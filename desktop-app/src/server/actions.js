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

/** Everything Buddy is allowed to do, and how to check the argument. */
const ACTIONS = {
  open_url: {
    summary: 'open a web page',
    validate(argument) {
      let url;
      try {
        url = new URL(argument);
      } catch {
        return { ok: false, error: 'that is not a web address' };
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
  'Examples of exactly what to write:\n' +
  '\n' +
  'User: open the BBC website\n' +
  'You: Opening it now.\n' +
  '[[open_url: https://www.bbc.co.uk]]\n' +
  '\n' +
  'User: look up tide times for me\n' +
  'You: Searching for that.\n' +
  '[[search_web: tide times]]\n' +
  '\n' +
  'User: what is the capital of France?\n' +
  'You: The capital of France is Paris.\n' +
  '\n' +
  'That last one has no marker because nothing needed opening. Put the marker on ' +
  'its own line at the very end, and never write more than one.';

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
};

/**
 * Pull an action line out of a reply.
 *
 * @returns {{ reply: string, action: null|{ name: string, value: string, description: string },
 *             refused: null|string }}
 */
function extractAction(reply) {
  const text = String(reply || '');
  // Accept `[[name: arg]]`, `[[name | arg]]` and `[[action: name | arg]]`, since
  // which of those a model produces is largely luck.
  const pattern = /\[\[\s*(?:action\s*[:|]\s*)?([a-z_]+)\s*[:|]\s*([\s\S]*?)\s*\]\]/i;
  const match = text.match(pattern);
  if (!match) return { reply: text.trim(), action: null, refused: null };

  // Whatever the model wrote around the action is still the reply.
  const cleaned = text.replace(pattern, '').trim();
  const raw = match[1].toLowerCase();
  const name = ACTIONS[raw] ? raw : ALIASES[raw] || raw;
  // Small models like to append a second field nobody asked for
  // (`[[search: tide times | tide.org]]`); the first one is the argument.
  const argument = (match[2] || '').split('|')[0].trim();

  const definition = ACTIONS[name];
  if (!definition) {
    return { reply: cleaned, action: null, refused: `Buddy tried to run "${name}", which is not something it can do.` };
  }

  const checked = definition.validate(argument);
  if (!checked.ok) {
    return { reply: cleaned, action: null, refused: `Buddy tried to ${definition.summary}, but ${checked.error}.` };
  }

  return {
    reply: cleaned,
    action: {
      name,
      value: checked.value,
      // "about to" and "just did" read very differently in a transcript.
      description: definition.describe(checked.value),
      done: definition.describeDone(checked.value),
    },
    refused: null,
  };
}

module.exports = { ACTIONS, ACTION_NAMES, ACTION_INSTRUCTIONS, extractAction };
