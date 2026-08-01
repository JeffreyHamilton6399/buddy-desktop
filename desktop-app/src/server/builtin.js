/**
 * Buddy's built-in brain — llama.cpp running inside the app.
 *
 * This is the default. No key, no account, no separate daemon: the model file
 * from model.js is loaded straight into this process via node-llama-cpp, which
 * ships prebuilt native binaries and picks up Metal on Apple Silicon and Vulkan
 * elsewhere when they are available.
 *
 * Loading a model costs several seconds and around a gigabyte of memory, so it
 * happens once, lazily, on the first message and is then kept warm. Requests are
 * serialised because one context cannot serve two conversations at once.
 */
'use strict';

const CONTEXT_SIZE = 4096;
const MAX_REPLY_TOKENS = 400;
/**
 * How long the weights stay resident after the last reply.
 *
 * Half an hour was too generous. This is several gigabytes of memory and, where
 * llama.cpp offloads to the GPU, over half a typical card — so one question at
 * lunchtime made everything else on the machine slower until well into the
 * afternoon, and asking anything at all reset the clock. Ten minutes still
 * covers a conversation, since every reply pushes it back; it just stops a
 * single question buying half an hour of tax.
 *
 * Reloading costs about ten seconds, and the orb hides most of that by warming
 * the moment it hears its name rather than when the question arrives.
 */
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

let llamaPromise = null;
let loaded = null; // { llama, model, context, session, modelPath }
let loadPromise = null; // in-flight load, shared by concurrent callers
let loadingPath = null;
let queue = Promise.resolve();
let idleTimer = null;

/** node-llama-cpp is ESM-only and this file is CJS, so it arrives by dynamic import. */
async function getLlama() {
  if (!llamaPromise) {
    llamaPromise = (async () => {
      const mod = await import('node-llama-cpp');
      // 'warn' would spam the console with llama.cpp's own load chatter.
      return mod.getLlama({ logLevel: 'error' });
    })();
    llamaPromise.catch(() => {
      llamaPromise = null;
    });
  }
  return llamaPromise;
}

function scheduleIdleUnload() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    unload().catch(() => {});
  }, IDLE_UNLOAD_MS);
}

/**
 * Loading is memoised while it is in flight.
 *
 * Two things now ask for the model at once — the server warms it at startup, and
 * the orb asks it to warm the moment listening begins. Without this both saw
 * `loaded` still empty, and both loaded a gigabyte of weights: twice the wait and
 * twice the memory, with the first copy abandoned.
 */
function load(modelPath) {
  if (loaded && loaded.modelPath === modelPath) return Promise.resolve(loaded);
  if (loadPromise && loadingPath === modelPath) return loadPromise;

  loadingPath = modelPath;
  loadPromise = (async () => {
    if (loaded) await unload();

    const llama = await getLlama();
    const startedAt = Date.now();
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext({ contextSize: CONTEXT_SIZE });

    const mod = await import('node-llama-cpp');
    const session = new mod.LlamaChatSession({ contextSequence: context.getSequence() });

    loaded = { llama, model, context, session, modelPath, LlamaChatSession: mod.LlamaChatSession };
    console.log(
      `[buddy] model loaded in ${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
        `(${(model.size / 1073741824).toFixed(2)} GB, ${llama.gpu || 'cpu'})`
    );
    return loaded;
  })();

  loadPromise
    .catch(() => {})
    .finally(() => {
      loadPromise = null;
      loadingPath = null;
    });

  return loadPromise;
}

async function unload() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const current = loaded;
  loaded = null;
  loadingPath = null;
  if (!current) return;
  try {
    await current.context.dispose();
    await current.model.dispose();
    console.log('[buddy] model unloaded after being idle');
  } catch {
    /* shutting down anyway */
  }
}

/** Our own message list -> the chat-history shape node-llama-cpp expects. */
function toChatHistory(messages) {
  const history = [];
  for (const message of messages) {
    if (message.role === 'system') {
      history.push({ type: 'system', text: message.content });
    } else if (message.role === 'user') {
      history.push({ type: 'user', text: message.content });
    } else if (message.role === 'assistant') {
      history.push({ type: 'model', response: [message.content] });
    }
  }
  return history;
}

/**
 * @param {{ modelPath: string, messages: Array<{role: string, content: string}>, maxTokens?: number,
 *           onDelta?: (text: string) => void }} options
 *   `onDelta` receives the reply as it is generated, a few characters at a
 *   time. Without it nothing is shown until the model has finished, which on a
 *   local 7B is several seconds of a blank panel — and the voice cannot start
 *   either, since it has nothing to say yet.
 * @param {AbortSignal} [options.signal] stops generation early. Buddy is
 *   interrupted by being talked over, and until this existed that only silenced
 *   the voice — the model carried on to the last token, holding the GPU for an
 *   answer nobody was going to hear.
 * @returns {Promise<{ message: { role: string, content: string } }>} an Ollama-shaped reply
 */
function chat({ modelPath, messages, maxTokens, onDelta, signal }) {
  // One context, one conversation at a time.
  const run = queue.then(async () => {
    const { session } = await load(modelPath);

    const history = toChatHistory(messages);
    // The final user turn is the prompt; everything before it is context.
    let prompt = '';
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].type === 'user') {
        prompt = history[i].text;
        history.splice(i, 1);
        break;
      }
    }
    if (!prompt) throw new Error('There was no user message to reply to');

    session.setChatHistory(history);
    const reply = await session.prompt(prompt, {
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : MAX_REPLY_TOKENS,
      temperature: 0.7,
      topP: 0.9,
      ...(signal ? { signal, stopOnAbortSignal: true } : {}),
      // A throwing listener must not take the generation down with it — the
      // reply is still wanted even if whoever asked to watch has gone away.
      ...(typeof onDelta === 'function'
        ? {
            onTextChunk: (chunk) => {
              try {
                onDelta(String(chunk || ''));
              } catch {
                /* the caller's problem, not this one's */
              }
            },
          }
        : {}),
    });

    scheduleIdleUnload();
    // Shaped like Ollama's response so extractReply() needs no special case.
    return { message: { role: 'assistant', content: String(reply || '').trim() } };
  });

  // Keep the queue alive even when a request fails.
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * Load the model now so the next reply does not have to wait for it.
 *
 * `maintain` marks a periodic keep-warm ping rather than somebody actually
 * wanting the model, and the distinction is the whole point of this function.
 * The orb pings every five minutes for as long as the wake word is on; treating
 * those as use reset the idle timer below long before its thirty minutes could
 * ever elapse, so several gigabytes of weights stayed resident for the entire
 * life of the app whether or not anyone had spoken to Buddy all day.
 *
 * A maintenance ping now keeps a warm model warm and leaves a cold one cold.
 * Only a real load starts the idle clock, and only a real reply — see chat()
 * — pushes it back.
 */
async function warmUp(modelPath, { maintain = false } = {}) {
  if (maintain && !loaded) return;
  const wasLoaded = Boolean(loaded);
  await load(modelPath);
  if (!wasLoaded) scheduleIdleUnload();
}

module.exports = { chat, warmUp, unload, isLoaded: () => Boolean(loaded), CONTEXT_SIZE };
