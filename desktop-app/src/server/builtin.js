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
const IDLE_UNLOAD_MS = 30 * 60 * 1000; // give the memory back if Buddy goes unused

let llamaPromise = null;
let loaded = null; // { llama, model, context, session, modelPath }
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

async function load(modelPath) {
  if (loaded && loaded.modelPath === modelPath) return loaded;
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
}

async function unload() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const current = loaded;
  loaded = null;
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
 * @param {{ modelPath: string, messages: Array<{role: string, content: string}>, maxTokens?: number }} options
 * @returns {Promise<{ message: { role: string, content: string } }>} an Ollama-shaped reply
 */
function chat({ modelPath, messages, maxTokens }) {
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

async function warmUp(modelPath) {
  await load(modelPath);
  scheduleIdleUnload();
}

module.exports = { chat, warmUp, unload, isLoaded: () => Boolean(loaded), CONTEXT_SIZE };
