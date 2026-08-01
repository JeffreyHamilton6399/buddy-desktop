/**
 * Letting Buddy do things on the computer.
 *
 * This is off by default and stays off until somebody turns it on, because it is
 * the one part of Buddy that reaches outside its own window. The design is
 * deliberately narrow:
 *
 *   * The model does not run anything. It emits a line naming an action and its
 *     argument, this file parses it, and the main process performs it. There is
 *     no shell, no eval, and no path the model can talk down to reach one.
 *   * There is a fixed list of actions. Anything not on it is refused, so a
 *     confused or manipulated model cannot invent `delete_everything`.
 *   * Every argument is validated here rather than trusted. A URL must parse and
 *     must be http or https, which is what keeps `file://`, `javascript:` and
 *     friends out.
 *
 * The 1B default model is not good at this. It will sometimes narrate an action
 * instead of emitting one, or emit one nobody asked for. That is why the reply
 * still goes to the user in full, why the action is shown rather than performed
 * silently, and why the settings copy says to use a bigger model.
 */
'use strict';

const path = require('path');

const files = require('./files.js');

/**
 * What this machine calls the place deleted files go. Said out loud to the user
 * and written into the model's instructions, so it has to be the name they will
 * actually see when they go looking for the file.
 */
const BIN = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';

/**
 * Everything Buddy is allowed to do, and how to check the argument.
 *
 * `fields: 2` means the marker carries a path and a body separated by the first
 * `|`, rather than a single value — writing a file needs both, and the body can
 * contain anything including newlines and further pipes.
 */
const ACTIONS = {
  open_url: {
    summary: 'open a web page',
    validate(argument) {
      const raw = String(argument || '').trim();
      let url;
      try {
        url = new URL(raw);
      } catch {
        // Models write "youtube.com", or just "youtube", far more often than a
        // full address. Anything that looks like a hostname gets https:// put on
        // the front; anything that does not is still refused, so this widens what
        // is understood without widening what is allowed.
        const host = raw.replace(/^\/+/, '');
        if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/.*)?$/i.test(host)) {
          return { ok: false, error: 'that is not a web address' };
        }
        try {
          url = new URL(`https://${host}`);
        } catch {
          return { ok: false, error: 'that is not a web address' };
        }
      }
      // Only the two schemes a browser should be handed. Anything else — file,
      // javascript, data — is a way of reaching something that is not a web page.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, error: 'only http and https addresses can be opened' };
      }
      return { ok: true, value: url.toString() };
    },
    describe: (value) => `open ${value}`,
    describeDone: (value) => `Opened ${value}`,
  },

  search_web: {
    summary: 'search the web',
    validate(argument) {
      const query = String(argument || '').trim();
      if (!query) return { ok: false, error: 'there was nothing to search for' };
      if (query.length > 300) return { ok: false, error: 'that search is too long' };
      return { ok: true, value: `https://duckduckgo.com/?q=${encodeURIComponent(query)}` };
    },
    describe: (value) => `search for “${decodeURIComponent(value.split('q=')[1] || '')}”`,
    describeDone: (value) => `Searched for “${decodeURIComponent(value.split('q=')[1] || '')}”`,
  },

  open_folder: {
    summary: "open one of Buddy's own folders",
    validate(argument) {
      // Names, not paths: the model never gets to point this at somewhere else.
      const known = ['models', 'chats', 'config'];
      const name = String(argument || '').trim().toLowerCase();
      if (!known.includes(name)) {
        return { ok: false, error: `only ${known.join(', ')} can be opened` };
      }
      return { ok: true, value: name };
    },
    describe: (value) => `open Buddy's ${value} folder`,
    describeDone: (value) => `Opened Buddy's ${value} folder`,
  },

  // ── files, and only inside folders the user has named ───────────────────

  read_file: {
    summary: 'read a file',
    needsFiles: true,
    validate(argument, context) {
      const found = files.resolveWithin(context.readRoots, argument);
      if (!found.ok) return { ok: false, error: found.error };
      return { ok: true, value: found.path };
    },
    describe: (value) => `read ${path.basename(value)}`,
    describeDone: (value) => `Read ${path.basename(value)}`,
  },

  list_folder: {
    summary: 'list a folder',
    needsFiles: true,
    validate(argument, context) {
      // "." and "" both mean "the folder you shared with me", which is what a
      // model reaches for when asked what files there are.
      const wanted = String(argument || '').trim();
      const found = files.resolveWithin(context.readRoots, wanted === '.' || !wanted ? './' : wanted);
      if (!found.ok) return { ok: false, error: found.error };
      return { ok: true, value: found.path };
    },
    describe: (value) => `list ${path.basename(value) || value}`,
    describeDone: (value) => `Listed ${path.basename(value) || value}`,
  },

  write_file: {
    summary: 'write a file',
    needsFiles: true,
    fields: 2,
    validate(argument, context) {
      const found = files.resolveWithin(context.writeRoots, argument.path);
      if (!found.ok) return { ok: false, error: found.error };
      if (!argument.content) return { ok: false, error: 'there was no text to write' };
      return { ok: true, value: found.path, content: argument.content };
    },
    describe: (value) => `write to ${path.basename(value)}`,
    describeDone: (value) => `Wrote ${path.basename(value)}`,
  },

  append_file: {
    summary: 'add to a file',
    needsFiles: true,
    fields: 2,
    validate(argument, context) {
      const found = files.resolveWithin(context.writeRoots, argument.path);
      if (!found.ok) return { ok: false, error: found.error };
      if (!argument.content) return { ok: false, error: 'there was nothing to add' };
      return { ok: true, value: found.path, content: argument.content, append: true };
    },
    describe: (value) => `add to ${path.basename(value)}`,
    describeDone: (value) => `Added to ${path.basename(value)}`,
  },

  /**
   * Checked against the write roots, not the read ones. Being able to see the
   * whole machine is a reasonable thing to allow; being able to delete across
   * the whole machine is not, and deleting is a write by any sensible reading
   * of the word.
   */
  delete_file: {
    summary: 'delete a file',
    needsFiles: true,
    validate(argument, context) {
      const found = files.resolveWithin(context.writeRoots, argument);
      if (!found.ok) return { ok: false, error: found.error };
      return { ok: true, value: found.path };
    },
    describe: (value) => `delete ${path.basename(value)}`,
    describeDone: (value) => `Deleted ${path.basename(value)}`,
  },
};

const ACTION_NAMES = Object.keys(ACTIONS);

/**
 * Bolted onto the system prompt when the setting is on.
 *
 * The shape here is the one a small model reaches for on its own. Asked to emit
 * `[[action: open_url | https://x]]`, Llama 3.2 1B wrote `[[open_url: https://x]]`
 * instead — so that is what it is asked for now. Fighting a model over
 * punctuation is a fight nobody needs to have.
 */
const ACTION_INSTRUCTIONS =
  'You can do things on this computer, but ONLY by writing a marker line. You ' +
  'cannot open anything by describing it. Saying "opening it now" without the ' +
  'marker line does nothing at all.\n' +
  '\n' +
  'The markers are:\n' +
  '  [[open_url: FULL WEB ADDRESS]]\n' +
  '  [[search_web: WORDS TO SEARCH FOR]]\n' +
  '  [[open_folder: models]]   (or chats, or config)\n' +
  '\n' +
  // These stay as a labelled dialogue. Rewriting them as prose ("Asked to open
  // the BBC website, write:") dropped the model from five hits in six to one:
  // it started answering with a bare URL and no marker at all. The labels leak
  // into the odd reply, which extractAction strips; that is the cheaper problem.
  'Examples of exactly what to write:\n' +
  '\n' +
  'User: open the BBC website\n' +
  'You: Opening it now.\n' +
  '[[open_url: https://www.bbc.co.uk]]\n' +
  '\n' +
  'User: open youtube\n' +
  'You: Opening YouTube.\n' +
  '[[open_url: https://www.youtube.com]]\n' +
  '\n' +
  'User: open a new tab with youtube in it\n' +
  'You: Opening YouTube.\n' +
  '[[open_url: https://www.youtube.com]]\n' +
  '\n' +
  'User: look up tide times for me\n' +
  'You: Searching for that.\n' +
  '[[search_web: tide times]]\n' +
  '\n' +
  'User: what is the capital of France?\n' +
  'You: The capital of France is Paris.\n' +
  '\n' +
  'That last one has no marker because nothing needed opening. Put the marker on ' +
  'its own line at the very end, and never write more than one.\n' +
  '\n' +
  'You cannot choose which browser is used — pages open in whichever one this ' +
  'computer uses by default. If asked for a particular browser, open the page ' +
  'anyway and say which browser it will actually use.';

/**
 * Does this message plausibly ask Buddy to *do* something?
 *
 * The instructions above cost more than they look. Handed to Llama 3.2 1B on
 * every turn, they crowd out the actual job: asked "what is 2+2?" it opened
 * Google, and asked for the capital of France it suggested searching online
 * rather than answering. A larger model holds both at once; this one cannot, so
 * it is only given the second job when the message looks like it needs it.
 *
 * A miss here is cheap — the message is answered normally, and asking again in
 * plainer words works. A false positive is the expensive one, so the list is
 * verbs about opening and searching rather than anything vaguer.
 */
const REQUEST_PATTERN =
  /\b(open|opens|opening|launch|start up|go to|goto|visit|browse|pull up|bring up|take me to|show me|search|searching|look up|lookup|google|duckduckgo|find me|download)\b/i;

/** The same idea for files: verbs about reading, writing and getting rid of them. */
const FILE_REQUEST_PATTERN =
  /\b(file|files|folder|directory|note|notes|write|writes|writing|save|saves|saving|edit|edits|editing|append|add to|create|read|list|rename|delete|deletes|deleting|remove|removes|removing|erase|bin|trash|get rid of|throw away|txt|markdown|\.md)\b/i;

function looksLikeRequest(text, { allowSystem = false } = {}) {
  const source = String(text || '');
  if (REQUEST_PATTERN.test(source)) return true;
  return allowSystem && FILE_REQUEST_PATTERN.test(source);
}

/**
 * The instruction block for a given set of permissions.
 *
 * The file half rides on the same switch as everything else now, so it is added
 * whenever that switch is on. What still varies is *where*, and that has to be
 * stated exactly: a model that does not know which folders it may write to
 * invents a path, gets refused, and apologises — which reads to the user as the
 * feature being broken.
 */
function instructionsFor({
  allowSystem = false,
  fileScope = 'folders',
  readRoots = [],
  writeRoots = [],
} = {}) {
  const wide = fileScope === 'everywhere';
  if (!allowSystem) return ACTION_INSTRUCTIONS;

  // The writable set, which is the named folders or the home folder — never
  // empty while the switch is on. See scopedRoots in files.js.
  const folders = writeRoots.map((root) => `  ${root}`).join('\n');
  const places = readRoots.map((root) => `  ${root}`).join('\n');

  /**
   * What the model is told it can see. Getting this wrong in either direction
   * is expensive: told it can read anything when it cannot, it invents paths
   * and apologises; told it is confined when it is not, it refuses things the
   * user explicitly allowed.
   */
  const scope = wide
    ? 'You can read and list ANY file or folder on this computer. These are the ' +
      'places to start from:\n' +
      `${places}\n\n` +
      'You can only WRITE or DELETE inside these folders:\n' +
      `${folders}\n\n`
    : 'You can also read, write and delete files, but ONLY inside these folders:\n' + `${folders}\n\n`;

  return (
    `${ACTION_INSTRUCTIONS}\n\n` +
    scope +
    'The markers are:\n' +
    '  [[read_file: name.txt]]\n' +
    '  [[list_folder: .]]\n' +
    '  [[write_file: name.txt | the entire new contents of the file]]\n' +
    '  [[append_file: name.txt | the text to add on the end]]\n' +
    '  [[delete_file: name.txt]]\n' +
    '\n' +
    'Examples of exactly what to write:\n' +
    '\n' +
    'User: make a note that the bins go out on Tuesday\n' +
    'You: Saved that to bins.txt.\n' +
    '[[write_file: bins.txt | The bins go out on Tuesday.]]\n' +
    '\n' +
    'User: what files do I have?\n' +
    'You: Here is what is in there.\n' +
    '[[list_folder: .]]\n' +
    '\n' +
    'User: add milk to my shopping list\n' +
    'You: Added it.\n' +
    '[[append_file: shopping.txt | milk]]\n' +
    '\n' +
    'User: delete bins.txt\n' +
    `You: Deleted it — it is in the ${BIN} if you want it back.\n` +
    '[[delete_file: bins.txt]]\n' +
    '\n' +
    'When you read a file or list a folder, what it found is given back to you ' +
    'in the next message, in square brackets. Do not guess at the contents ' +
    'before then and do not claim to have read something you have not been ' +
    'shown yet — write the marker, stop, and answer once you can see it.\n' +
    '\n' +
    'User: what is in my shopping list?\n' +
    'You: Let me look.\n' +
    '[[read_file: shopping.txt]]\n' +
    '(the contents come back, and then you answer the question with them)\n' +
    '\n' +
    'write_file replaces the whole file, so give the complete new contents, not ' +
    'just the change. The previous version is kept as a .bak file automatically. ' +
    `delete_file only ever deletes the one file named, and it goes to the ${BIN} ` +
    'rather than being destroyed, so say so rather than warning that it is ' +
    'permanent. Only delete when you have been asked to delete. ' +
    (wide
      ? 'To read something, give its full path. To write or delete, use a plain file ' +
        'name — those are limited to the folders listed above even though reading is not.'
      : 'Use a plain file name — you cannot write to or delete anything outside the folders above.')
  );
}

/**
 * Names a model reaches for instead of the real ones. Mapping them is not a
 * loosening: the target still has to be a real action, and its argument is still
 * validated. It only saves the user from a feature that fails on a synonym.
 */
const ALIASES = {
  open: 'open_url',
  open_website: 'open_url',
  open_browser: 'open_url',
  open_page: 'open_url',
  browse: 'open_url',
  url: 'open_url',
  search: 'search_web',
  web_search: 'search_web',
  google: 'search_web',
  search_the_web: 'search_web',
  folder: 'open_folder',
  open_directory: 'open_folder',
  delete: 'delete_file',
  remove: 'delete_file',
  remove_file: 'delete_file',
  erase_file: 'delete_file',
  trash_file: 'delete_file',
};

/**
 * Pull an action line out of a reply.
 *
 * @returns {{ reply: string, action: null|{ name: string, value: string, description: string },
 *             refused: null|string }}
 */
/**
 * The examples above are a labelled dialogue, and a small model sometimes copies
 * the label — answering "You: Searching for that." Strip it rather than lose the
 * examples, which are what make the feature work at all.
 */
function stripSpeakerLabel(text) {
  return text.replace(/^\s*(?:you|assistant|buddy)\s*:\s*/i, '');
}

function extractAction(reply, context = {}) {
  const settings = { fileRoots: [], allowSystem: false, ...context };
  const text = stripSpeakerLabel(String(reply || ''));
  // Accept `[[name: arg]]`, `[[name | arg]]` and `[[action: name | arg]]`, since
  // which of those a model produces is largely luck.
  /**
   * Note there is no `\s*` before the closing brackets. There used to be, and
   * it silently ate the trailing newline off every file written — so a file
   * that should have ended in a newline never did. Each branch below trims what
   * it actually wants instead.
   */
  const pattern = /\[\[\s*(?:action\s*[:|]\s*)?([a-z_]+)\s*[:|]\s*([\s\S]*?)\]\]/i;
  const match = text.match(pattern);
  if (!match) return { reply: text.trim(), action: null, refused: null };

  // Whatever the model wrote around the action is still the reply.
  const cleaned = text.replace(pattern, '').trim();
  const raw = match[1].toLowerCase();
  const name = ACTIONS[raw] ? raw : ALIASES[raw] || raw;

  const definition = ACTIONS[name];
  if (!definition) {
    return { reply: cleaned, action: null, refused: `Buddy tried to run "${name}", which is not something it can do.` };
  }
  // A marker for a switched-off ability is refused rather than performed. The
  // instructions never mention these unless they are on, so reaching one means
  // the model invented it.
  if (definition.needsFiles && !settings.allowSystem) {
    return {
      reply: cleaned,
      action: null,
      refused: `Buddy tried to ${definition.summary}, but it is not allowed to touch files.`,
    };
  }

  const body = match[2] || '';
  let argument;
  if (definition.fields === 2) {
    // Split on the first pipe only: everything after it is the file's contents,
    // which may itself contain pipes and newlines.
    const at = body.indexOf('|');
    // The separator is written as `| text` or `|` then a newline. Strip exactly
    // that much and no more, so indentation on the first line of a file — which
    // matters in anything code-shaped — survives.
    argument =
      at === -1
        ? { path: body.trim(), content: '' }
        : {
            path: body.slice(0, at).trim(),
            content: body.slice(at + 1).replace(/^(?:[ \t]*\r?\n|[ \t])/, ''),
          };
  } else {
    // Small models like to append a second field nobody asked for
    // (`[[search: tide times | tide.org]]`); the first one is the argument.
    argument = body.split('|')[0].trim();
  }

  const checked = definition.validate(argument, settings);
  if (!checked.ok) {
    return { reply: cleaned, action: null, refused: `Buddy tried to ${definition.summary}, but ${checked.error}.` };
  }

  return {
    reply: cleaned,
    action: {
      name,
      value: checked.value,
      ...(checked.content !== undefined ? { content: checked.content } : {}),
      ...(checked.append ? { append: true } : {}),
      // "about to" and "just did" read very differently in a transcript.
      description: definition.describe(checked.value),
      done: definition.describeDone(checked.value),
    },
    refused: null,
  };
}

module.exports = {
  ACTIONS,
  ACTION_NAMES,
  ACTION_INSTRUCTIONS,
  instructionsFor,
  extractAction,
  looksLikeRequest,
};
