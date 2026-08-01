/**
 * The settings surface, reached by clicking Buddy's own name in the panel header.
 *
 * Five sections down a rail: which model thinks, how Buddy sounds, how it listens,
 * what happens to conversations, and what all of that means for privacy. The
 * point of gathering them here is that the header used to be four unlabelled
 * icons, which told you nothing about what Buddy is or where it runs.
 *
 * Everything writes straight through to the server's /settings and re-reads the
 * runtime afterwards, so the panel and the orb both react to a change at once.
 */
'use strict';

import {
  $,
  api,
  boot,
  runtime,
  buddyName,
  wakePhrase,
  binName,
  refreshRuntime,
  formatBytes,
  describeProgress,
} from './core.js';
import { previewVoice } from './speech.js';
import { ACCENT_PRESETS, accentStops, applyLook } from './theme.js';

/**
 * How often the open settings pane re-reads the world.
 *
 * The fast rate exists for progress bars: a download that only moves every
 * three seconds looks stalled. Nothing else in here changes on that timescale,
 * so once nothing is downloading or loading the pane drops to the slow rate —
 * three requests a second, forever, for a pane somebody left open and walked
 * away from is a poor way to treat a machine that is also running a language
 * model.
 */
const POLL_BUSY_MS = 700;
const POLL_IDLE_MS = 4000;

/**
 * @param {{ onChanged?: () => void,
 *           onRequestMicTest?: () => Promise<string>,
 *           getWakeEnabled?: () => boolean }} hooks
 */
export function createSettings({ onChanged, onRequestMicTest, getWakeEnabled } = {}) {
  const sheet = $('settings');
  const rail = $('settings-rail');
  const note = $('settings-note');

  let pollTimer = null;
  let visible = false;
  let voicesLoaded = false;
  /** Set by the renders below when something is genuinely moving. */
  let workInFlight = false;

  // ── plumbing ────────────────────────────────────────────────────────────

  async function save(patch) {
    try {
      const { runtime: updated } = await api('/settings', patch);
      Object.assign(runtime, updated);
      if (onChanged) onChanged();
      return true;
    } catch (error) {
      setNote(`Couldn't save that: ${error.message}`, true);
      return false;
    }
  }

  function setNote(text, bad) {
    note.textContent = text || '';
    note.classList.toggle('bad', Boolean(bad));
    if (text) {
      clearTimeout(setNote.timer);
      setNote.timer = setTimeout(() => {
        note.textContent = '';
        note.classList.remove('bad');
      }, 4000);
    }
  }

  function showPane(name) {
    for (const tab of rail.querySelectorAll('.rail-tab')) {
      const on = tab.dataset.pane === name;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', String(on));
    }
    for (const pane of $('settings-panes').querySelectorAll('.pane')) {
      pane.classList.toggle('is-on', pane.dataset.pane === name);
    }
  }

  rail.addEventListener('click', (event) => {
    const tab = event.target.closest('.rail-tab');
    if (tab) showPane(tab.dataset.pane);
  });

  // ── brain: the model picker ─────────────────────────────────────────────

  /**
   * @param entry one model from /models
   * @param provider which provider is actually answering right now
   *
   * `entry.active` only means "this is the built-in model Buddy would use" —
   * it stays true while a cloud provider is doing the answering. Reading it as
   * "answering now" is what left the local models badged and buttonless after
   * a switch to the cloud, with no way back.
   */
  function modelCard(entry, provider) {
    const answering = provider === 'builtin' && entry.active;
    const card = document.createElement('div');
    card.className = 'card' + (answering ? ' is-active' : '');

    const head = document.createElement('div');
    head.className = 'card-head';

    const title = document.createElement('strong');
    title.textContent = entry.model.label;
    const size = document.createElement('span');
    size.className = 'card-size';
    size.textContent = `${entry.model.parameters} · ${formatBytes(entry.model.bytes)}`;
    head.append(title, size);

    const blurb = document.createElement('p');
    blurb.className = 'card-blurb';
    blurb.textContent = entry.model.blurb;

    const foot = document.createElement('div');
    foot.className = 'card-foot';

    if (entry.status === 'downloading' || entry.status === 'verifying') {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.className = 'bar-fill';
      fill.style.width = `${entry.percent}%`;
      bar.appendChild(fill);

      const line = document.createElement('span');
      line.className = 'card-note';
      line.textContent =
        entry.status === 'verifying' ? 'Checking the download…' : describeProgress(entry) || 'Starting…';
      foot.append(bar, line);
    } else if (entry.ready) {
      if (answering) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'Answering now';
        foot.appendChild(badge);
      } else {
        const use = document.createElement('button');
        use.className = 'btn primary';
        use.type = 'button';
        use.textContent = 'Use this one';
        use.addEventListener('click', async () => {
          use.disabled = true;
          if (await save({ chat: { provider: 'builtin', builtinModel: entry.model.id } })) {
            setNote(`${entry.model.label} will answer from now on, on this machine.`);
          }
          await refreshRuntime();
          await renderAll();
        });
        foot.appendChild(use);
      }

      if (!entry.active) {
        const remove = document.createElement('button');
        remove.className = 'btn ghost';
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.title = 'Free up the disk space';
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try {
            await api(`/models/${entry.model.id}`, undefined, { method: 'DELETE' });
            setNote(`Deleted ${entry.model.label}.`);
          } catch (error) {
            setNote(error.message, true);
          }
          await renderModels();
        });
        foot.appendChild(remove);
      }
    } else {
      const get = document.createElement('button');
      get.className = 'btn';
      get.type = 'button';
      get.textContent = entry.error ? 'Try again' : `Download ${formatBytes(entry.model.bytes)}`;
      get.addEventListener('click', async () => {
        get.disabled = true;
        try {
          await api(`/models/${entry.model.id}`, {});
        } catch (error) {
          setNote(error.message, true);
        }
        await renderModels();
      });
      foot.appendChild(get);

      if (entry.model.memoryHint) {
        const hint = document.createElement('span');
        // Saying a model wants more memory than this machine has is the whole
        // point of listing a dozen of them — otherwise the extra choice is just
        // a longer way to download something that will swap.
        hint.className = entry.fits ? 'card-note' : 'card-note bad';
        hint.textContent = entry.fits
          ? `Needs ${entry.model.memoryHint}`
          : `Needs ${entry.model.memoryHint} — more than this computer has`;
        foot.appendChild(hint);
      }
    }

    if (entry.error) {
      const failed = document.createElement('span');
      failed.className = 'card-note bad';
      failed.textContent = entry.error;
      foot.appendChild(failed);
    }

    card.append(head, blurb, foot);
    return card;
  }

  /**
   * Does a model match what is typed in the search box?
   *
   * Matches across the name, the description, the size and the tags, so
   * "small", "code", "qwen" and "writing" all find something sensible — a
   * library of a dozen is only better than a list of four if you can get to the
   * one you want without reading all of them.
   */
  function matchesSearch(entry) {
    const needle = $('model-search').value.trim().toLowerCase();
    if (!needle) return true;
    const haystack = [
      entry.model.label,
      entry.model.blurb,
      entry.model.parameters,
      ...(entry.model.tags || []),
      entry.ready ? 'downloaded installed' : '',
      entry.fits ? '' : 'too big',
    ]
      .join(' ')
      .toLowerCase();
    // Every word has to appear somewhere, so "small chat" narrows rather than widens.
    return needle.split(/\s+/).every((word) => haystack.includes(word));
  }

  $('model-search').addEventListener('input', () => renderModels());

  async function renderModels() {
    let payload;
    try {
      payload = await api('/models');
    } catch (error) {
      $('model-list').textContent = `Couldn't read the model list: ${error.message}`;
      return;
    }

    const busy = (entry) => entry.status === 'downloading' || entry.status === 'verifying';
    if (payload.models.some(busy)) workInFlight = true;

    const list = $('model-list');
    const matching = payload.models.filter(matchesSearch);
    list.replaceChildren(...matching.map((entry) => modelCard(entry, payload.provider)));

    if (!matching.length) {
      const empty = document.createElement('p');
      empty.className = 'pane-lede';
      empty.textContent = `Nothing matches “${$('model-search').value.trim()}”.`;
      list.appendChild(empty);
    }

    // ── Ollama, if it is running ──
    const lede = $('ollama-lede');
    const ollamaList = $('ollama-list');
    ollamaList.replaceChildren();

    if (!payload.ollama.reachable) {
      lede.textContent =
        `No Ollama answering on ${payload.ollama.baseUrl}. Start it and any models you have pulled will appear here.`;
      return;
    }
    if (!payload.ollama.models.length) {
      lede.textContent = `Ollama is running, but has no models pulled yet. Try \`ollama pull llama3.2\`.`;
      return;
    }

    lede.textContent = `Ollama is running with ${payload.ollama.models.length} model${
      payload.ollama.models.length === 1 ? '' : 's'
    }. Pick one to have Buddy use it instead.`;

    for (const name of payload.ollama.models) {
      const isActive = payload.provider === 'ollama' && payload.ollama.active === name;
      const row = document.createElement('div');
      row.className = 'card compact' + (isActive ? ' is-active' : '');

      const head = document.createElement('div');
      head.className = 'card-head';
      const title = document.createElement('strong');
      title.textContent = name;
      head.appendChild(title);

      const foot = document.createElement('div');
      foot.className = 'card-foot';
      if (isActive) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'Answering now';
        foot.appendChild(badge);
      } else {
        const use = document.createElement('button');
        use.className = 'btn primary';
        use.type = 'button';
        use.textContent = 'Use this one';
        use.addEventListener('click', async () => {
          use.disabled = true;
          if (await save({ chat: { provider: 'ollama', model: name } })) {
            setNote(`${name} will answer through Ollama from now on.`);
          }
          await renderModels();
        });
        foot.appendChild(use);
      }

      row.append(head, foot);
      ollamaList.appendChild(row);
    }
  }

  // ── on this machine, or in the cloud ────────────────────────────────────

  /** Which of the two choices is lit, and what the line underneath says. */
  function applyRuns() {
    const inCloud = runtime.providers.chat === 'cloud' || runtime.providers.chat === 'z-ai';
    $('run-local').classList.toggle('is-on', !inCloud);
    $('run-cloud').classList.toggle('is-on', inCloud);
    $('run-local').setAttribute('aria-pressed', String(!inCloud));
    $('run-cloud').setAttribute('aria-pressed', String(inCloud));

    const note = $('runs-note');
    if (!inCloud) {
      note.textContent =
        runtime.providers.chat === 'ollama'
          ? `Answering with ${runtime.chatModel} through Ollama, on this machine.`
          : `Answering with ${runtime.chatModel}, on this machine.`;
      note.classList.remove('bad');
      return;
    }
    if (runtime.needsKey) {
      note.textContent = 'Set to use the cloud, but no API key is saved for it. Add one below.';
      note.classList.add('bad');
      return;
    }
    note.textContent = `Answering with ${runtime.chatModel}. What you say is sent to them.`;
    note.classList.remove('bad');
  }

  $('run-local').addEventListener('click', async () => {
    if (runtime.providers.chat === 'builtin' || runtime.providers.chat === 'ollama') return;
    if (await save({ chat: { provider: 'builtin' } })) {
      setNote('Back to the model on this machine. Nothing leaves the device.');
      await refreshRuntime();
      await renderAll();
    }
  });

  $('run-cloud').addEventListener('click', async () => {
    const saved = runtime.keys || [];
    if (!saved.length) {
      setNote('Add an API key below first — then Buddy can use it.', true);
      $('key-input').focus();
      return;
    }
    // Whatever was in use last, or the only one there is.
    const pick = saved.find((entry) => entry.id === runtime.cloudProvider) || saved[0];
    if (await save({ chat: { provider: 'cloud', cloudProvider: pick.id, cloudModel: pick.model } })) {
      setNote(`${pick.label} will answer from now on.`);
      await refreshRuntime();
      await renderAll();
    }
  });

  // ── API keys ────────────────────────────────────────────────────────────

  /** Models per provider, fetched once per settings visit rather than per poll. */
  const modelCache = new Map();

  function setKeyNote(text, bad) {
    const note = $('key-note');
    note.textContent = text || '';
    note.classList.toggle('bad', Boolean(bad));
  }

  /** The providers Buddy knows the endpoint for, fetched once. */
  let catalog = null;

  async function loadCatalog() {
    if (catalog) return catalog;
    try {
      const payload = await api('/keys');
      catalog = payload.catalog || [];
    } catch {
      catalog = [];
    }
    return catalog;
  }

  /** Offer the list of providers by name, plus the escape hatch at the end. */
  async function askWhoIssuedIt() {
    const select = $('key-provider');
    const known = await loadCatalog();
    if (select.options.length !== known.length + 1) {
      select.replaceChildren(
        ...known.map((entry) => new Option(entry.hint ? `${entry.label} — ${entry.hint}` : entry.label, entry.id)),
        new Option('Something else (OpenAI-compatible)', 'custom')
      );
    }
    $('key-provider-row').hidden = false;
    select.focus();
  }

  // Only the catch-all needs an address typed out; the rest Buddy already knows.
  $('key-provider').addEventListener('change', (event) => {
    $('key-baseurl-row').hidden = event.target.value !== 'custom';
  });

  function resetKeyForm() {
    $('key-input').value = '';
    $('key-baseurl').value = '';
    $('key-provider-row').hidden = true;
    $('key-baseurl-row').hidden = true;
  }

  async function addKey() {
    const button = $('key-save');
    const field = $('key-input');
    const apiKey = field.value.trim();
    if (!apiKey) {
      setKeyNote('Paste a key first.', true);
      field.focus();
      return;
    }

    button.disabled = true;
    setKeyNote('Checking that key…');
    try {
      const baseUrl = $('key-baseurl').value.trim();
      // Only sent once the user has actually been asked — otherwise Buddy
      // should get one guess at it from the key itself.
      const provider = $('key-provider-row').hidden ? '' : $('key-provider').value;
      const result = await api('/keys', {
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        ...(provider ? { provider } : {}),
      });
      resetKeyForm();
      modelCache.delete(result.provider.id);
      setKeyNote(`Saved. That is ${result.provider.label} — Buddy can use it now.`);
      await refreshRuntime();
      await renderAll();
    } catch (error) {
      // An unrecognised key is not a failure, it is a follow-up question.
      const payload = error.payload || {};
      if (payload.needsProvider) await askWhoIssuedIt();
      if (payload.needsBaseUrl) {
        $('key-baseurl-row').hidden = false;
        $('key-baseurl').focus();
      }
      setKeyNote(error.message, true);
    }
    button.disabled = false;
  }

  $('key-save').addEventListener('click', addKey);
  $('key-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addKey();
  });

  /** The models one saved key can reach, cached so the picker is not a poll. */
  async function modelsFor(id) {
    if (modelCache.has(id)) return modelCache.get(id);
    try {
      const { models } = await api(`/keys/${id}/models`);
      modelCache.set(id, models || []);
    } catch {
      modelCache.set(id, []);
    }
    return modelCache.get(id);
  }

  function keyCard(entry) {
    const answering = runtime.providers.chat === 'cloud' && runtime.cloudProvider === entry.id;

    const card = document.createElement('div');
    card.className = 'card' + (answering ? ' is-active' : '');

    const head = document.createElement('div');
    head.className = 'card-head';
    const title = document.createElement('strong');
    title.textContent = entry.label;
    const masked = document.createElement('span');
    masked.className = 'card-size';
    masked.textContent = entry.maskedKey;
    head.append(title, masked);

    const blurb = document.createElement('p');
    blurb.className = 'card-blurb';
    blurb.textContent = entry.hint ? `${entry.hint} · ${entry.baseUrl}` : entry.baseUrl;

    const foot = document.createElement('div');
    foot.className = 'card-foot';

    // Which model of theirs to use. Filled in from the provider's own list, so
    // a model that has since been retired cannot be left selected.
    const picker = document.createElement('select');
    picker.className = 'key-model';
    picker.setAttribute('aria-label', `Model for ${entry.label}`);
    picker.replaceChildren(new Option(entry.model || 'Loading models…', entry.model || ''));
    modelsFor(entry.id).then((models) => {
      if (!models.length) return;
      const selected = answering ? runtime.cloudModel || entry.model : entry.model;
      picker.replaceChildren(...models.map((id) => new Option(id, id, false, id === selected)));
      if (selected && !models.includes(selected)) picker.prepend(new Option(selected, selected, false, true));
      picker.value = selected || models[0];
    });
    picker.addEventListener('change', async () => {
      // Picking a model for a provider that is not answering must not quietly
      // switch Buddy over to it — the choice is carried by "Use this one"
      // instead. Only the live provider writes straight through.
      if (!answering) return;
      if (await save({ chat: { cloudModel: picker.value } })) setNote(`Now using ${picker.value}.`);
    });
    foot.appendChild(picker);

    if (answering) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Answering now';
      foot.appendChild(badge);
    } else {
      const use = document.createElement('button');
      use.className = 'btn primary';
      use.type = 'button';
      use.textContent = 'Use this one';
      use.addEventListener('click', async () => {
        use.disabled = true;
        if (await save({ chat: { provider: 'cloud', cloudProvider: entry.id, cloudModel: picker.value } })) {
          setNote(`${entry.label} will answer from now on.`);
        }
        await refreshRuntime();
        await renderAll();
      });
      foot.appendChild(use);
    }

    const forget = document.createElement('button');
    forget.className = 'btn ghost';
    forget.type = 'button';
    forget.textContent = 'Forget';
    forget.title = 'Delete this key from this computer';
    forget.addEventListener('click', async () => {
      forget.disabled = true;
      try {
        await api(`/keys/${entry.id}`, undefined, { method: 'DELETE' });
        modelCache.delete(entry.id);
        setKeyNote(`Forgot the ${entry.label} key.`);
      } catch (error) {
        setKeyNote(error.message, true);
      }
      await refreshRuntime();
      await renderAll();
    });
    foot.appendChild(forget);

    card.append(head, blurb, foot);
    return card;
  }

  function renderKeys() {
    const list = $('key-list');
    const saved = runtime.keys || [];
    if (!saved.length) {
      list.replaceChildren();
      return;
    }
    list.replaceChildren(...saved.map(keyCard));
  }

  // ── voice ───────────────────────────────────────────────────────────────

  async function loadVoices() {
    const select = $('tts-voice');
    try {
      const { voices, selected, needsDownload } = await api('/voices');
      if (needsDownload || !voices.length) {
        select.replaceChildren(new Option('Download the voice first', ''));
        return;
      }
      select.replaceChildren(
        ...voices.map((entry) => {
          const label = `${entry.name}${entry.gender ? ` — ${entry.gender.toLowerCase()}` : ''}`;
          return new Option(label, entry.id, false, entry.id === (runtime.ttsVoice || selected));
        })
      );
      voicesLoaded = true;
    } catch (error) {
      select.replaceChildren(new Option(`Couldn't list voices: ${error.message}`, ''));
    }
  }

  function loadSystemVoices() {
    const select = $('system-voice');
    const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    if (!voices.length) {
      select.replaceChildren(new Option('This computer has no voices installed', ''));
      return;
    }
    // The better Windows voices are the ones with "Natural" in the name; float
    // them up so the least robotic option is not buried.
    const sorted = [...voices].sort((a, b) => {
      const score = (voice) => (/natural|neural|online/i.test(voice.name) ? 0 : 1);
      return score(a) - score(b) || a.name.localeCompare(b.name);
    });
    select.replaceChildren(
      ...sorted.map((voice) => new Option(voice.name, voice.name, false, voice.name === runtime.ttsVoice))
    );
  }

  /**
   * Fill a provider picker with the saved keys that can do a given job, and
   * say so plainly when there are none. An empty dropdown with no explanation
   * is the worst version of this — it looks broken rather than unconfigured.
   */
  function fillCloudProviders(select, available, selected) {
    if (!available.length) {
      select.replaceChildren(new Option('No key you have added can do this', ''));
      select.disabled = true;
      return;
    }
    select.disabled = false;
    select.replaceChildren(
      ...available.map((entry) => new Option(entry.label, entry.id, false, entry.id === selected))
    );
    if (selected && available.some((entry) => entry.id === selected)) select.value = selected;
  }

  $('speak-replies').addEventListener('change', async (event) => {
    if (!(await save({ speakReplies: event.target.checked }))) {
      event.target.checked = !event.target.checked;
      return;
    }
    await refreshRuntime();
    setNote(event.target.checked ? 'Replies will be read out loud.' : 'Replies will be text only.');
  });

  function applyVoicePanes() {
    const provider = runtime.providers.tts;
    $('speak-replies').checked = runtime.speakReplies !== false;
    $('tts-provider').value = provider;
    // The voice picker and the speed slider serve the in-app voice and a cloud
    // one equally; only the OS voices have their own list.
    $('kokoro-options').hidden = provider !== 'kokoro' && provider !== 'cloud';
    $('system-options').hidden = provider !== 'system';
    $('tts-cloud-options').hidden = provider !== 'cloud';
    if (provider === 'cloud') {
      fillCloudProviders($('tts-cloud-provider'), runtime.ttsProviders || [], runtime.ttsCloudProvider);
    }
    $('tts-speed').value = String(runtime.ttsSpeed || 1);
    $('tts-speed-value').textContent = `${Number(runtime.ttsSpeed || 1).toFixed(2)}x`;
  }

  $('tts-provider').addEventListener('change', async (event) => {
    const provider = event.target.value;
    // A Kokoro voice id means nothing to speechSynthesis, or to OpenAI, and so
    // on in every direction — so the voice is always cleared on a switch.
    const patch = { provider, voice: '' };
    if (provider === 'cloud' && !runtime.ttsCloudProvider) {
      const first = (runtime.ttsProviders || [])[0];
      if (!first) {
        setNote('None of the keys you have added can do speech. Add an OpenAI or Groq key first.', true);
        $('tts-provider').value = runtime.providers.tts;
        return;
      }
      patch.cloudProvider = first.id;
    }
    if (await save({ tts: patch })) {
      await refreshRuntime();
      applyVoicePanes();
      if (provider === 'kokoro' || provider === 'cloud') await loadVoices();
      if (provider === 'system') loadSystemVoices();
      renderAssets();
    }
  });

  $('tts-cloud-provider').addEventListener('change', async (event) => {
    if (!event.target.value) return;
    if (await save({ tts: { cloudProvider: event.target.value, voice: '' } })) {
      await refreshRuntime();
      applyVoicePanes();
      await loadVoices();
    }
  });

  $('asr-cloud-provider').addEventListener('change', async (event) => {
    if (!event.target.value) return;
    if (await save({ asr: { cloudProvider: event.target.value } })) {
      await refreshRuntime();
      applyHearingPanes();
      if (onChanged) onChanged();
    }
  });

  $('tts-voice').addEventListener('change', async (event) => {
    if (event.target.value) await save({ tts: { voice: event.target.value } });
  });

  $('system-voice').addEventListener('change', async (event) => {
    if (event.target.value) await save({ tts: { voice: event.target.value } });
  });

  $('tts-speed').addEventListener('input', (event) => {
    $('tts-speed-value').textContent = `${Number(event.target.value).toFixed(2)}x`;
  });
  $('tts-speed').addEventListener('change', async (event) => {
    await save({ tts: { speed: Number(event.target.value) } });
  });

  $('voice-preview').addEventListener('click', async () => {
    const button = $('voice-preview');
    const previewNote = $('voice-preview-note');
    const chosen =
      runtime.providers.tts === 'system' ? $('system-voice').value : $('tts-voice').value || runtime.ttsVoice;

    button.disabled = true;
    previewNote.textContent = 'Making it…';
    try {
      await previewVoice(chosen);
      previewNote.textContent = '';
    } catch (error) {
      previewNote.textContent = error.message;
    }
    button.disabled = false;
  });

  // ── hearing ─────────────────────────────────────────────────────────────

  function applyHearingPanes() {
    $('asr-provider').value = runtime.providers.asr;
    $('whisper-options').hidden = runtime.providers.asr !== 'whisper';
    $('asr-cloud-options').hidden = runtime.providers.asr !== 'cloud';
    if (runtime.providers.asr === 'cloud') {
      fillCloudProviders($('asr-cloud-provider'), runtime.asrProviders || [], runtime.asrCloudProvider);
    }

    // Which size of the in-app Whisper. Only relevant when that is what is listening.
    const localOptions = $('local-whisper-options');
    localOptions.hidden = runtime.providers.asr !== 'local';
    const sizes = runtime.asrLocalModels || [];
    const select = $('asr-local-model');
    if (sizes.length && select.options.length !== sizes.length) {
      select.replaceChildren(...sizes.map((entry) => new Option(entry.label, entry.id)));
    }
    if (runtime.asrLocalModel) select.value = runtime.asrLocalModel;
    $('asr-local-note').textContent =
      runtime.asrLocalModel === 'tiny.en'
        ? 'If Buddy keeps mishearing you, the larger model is worth a try — a 73 MB download, and slower per phrase. On a synthetic headset-quality test here the two scored the same, so it is not a guaranteed fix.'
        : 'The larger model. Switch back to Faster if replies feel sluggish.';

    const wake = $('wake-toggle');
    wake.checked = Boolean(getWakeEnabled ? getWakeEnabled() : boot.wakeEnabled);
    // Without a way to transcribe, the wake word has nothing to listen with.
    wake.disabled = runtime.providers.asr === 'off';
  }

  $('asr-provider').addEventListener('change', async (event) => {
    const provider = event.target.value;
    const patch = { provider };
    if (provider === 'cloud' && !runtime.asrCloudProvider) {
      const first = (runtime.asrProviders || [])[0];
      if (!first) {
        setNote('None of the keys you have added can transcribe. Add an OpenAI or Groq key first.', true);
        $('asr-provider').value = runtime.providers.asr;
        return;
      }
      patch.cloudProvider = first.id;
    }
    if (await save({ asr: patch })) {
      await refreshRuntime();
      applyHearingPanes();
      renderAssets();
      if (onChanged) onChanged();
    }
  });

  $('asr-local-model').addEventListener('change', async (event) => {
    const size = event.target.value;
    if (!(await save({ asr: { localModel: size } }))) return;
    await refreshRuntime();
    applyHearingPanes();
    renderAssets();
    // Switching to a size that is not on disk means a download, so say so rather
    // than leaving the wake word quietly broken until it finishes.
    setNote(
      runtime.hearingReady === false
        ? 'Downloading the more accurate model — listening resumes when it lands.'
        : 'Switched. The next thing you say uses it.'
    );
  });

  $('whisper-url').addEventListener('change', async (event) => {
    if (event.target.value.trim()) await save({ asr: { baseUrl: event.target.value.trim() } });
  });

  // ── what Buddy may do ───────────────────────────────────────────────────

  $('allow-system').addEventListener('change', async (event) => {
    if (!(await save({ allowSystem: event.target.checked }))) {
      event.target.checked = !event.target.checked;
      return;
    }
    await refreshRuntime();
    applyDoingPane();
    setNote(event.target.checked ? 'Buddy can reach your system now.' : 'Buddy is back inside its own window.');
  });

  $('add-file-root').addEventListener('click', async () => {
    const chosen = await window.buddy.pickFolder();
    if (!chosen) return;
    const roots = [...(runtime.fileRoots || []), chosen];
    if (await save({ fileRoots: roots })) {
      await refreshRuntime();
      applyDoingPane();
      setNote('Buddy can work in that folder now.');
    }
  });

  /**
   * The folders Buddy may touch, with a way to take each one back.
   *
   * Listed in full rather than by name: "Documents" is not enough to know what
   * you have handed over, and this is the one screen where being able to see
   * exactly what was granted matters more than looking tidy.
   */
  function renderFileRoots() {
    const list = $('file-roots');
    const roots = runtime.fileRoots || [];
    list.replaceChildren();

    if (!roots.length) {
      const empty = document.createElement('p');
      empty.className = 'pane-lede';
      const where = (runtime.writeRoots || [])[0];
      // The empty case is the permissive one now, so it has to say so rather
      // than read like nothing has been granted.
      empty.textContent = runtime.allowSystem
        ? `No folders picked. Buddy may write and delete anywhere under ${where || 'your home folder'}.`
        : 'No folders picked. Turn the switch above on to let Buddy work with files.';
      list.appendChild(empty);
      return;
    }

    for (const root of roots) {
      const row = document.createElement('div');
      row.className = 'card compact';

      const head = document.createElement('div');
      head.className = 'card-head';
      const title = document.createElement('strong');
      title.textContent = root;
      title.className = 'root-path';
      head.appendChild(title);

      const foot = document.createElement('div');
      foot.className = 'card-foot';
      const remove = document.createElement('button');
      remove.className = 'btn ghost';
      remove.type = 'button';
      remove.textContent = 'Stop sharing';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        if (await save({ fileRoots: roots.filter((entry) => entry !== root) })) {
          await refreshRuntime();
          applyDoingPane();
          setNote('Buddy can no longer reach that folder.');
        }
      });
      foot.appendChild(remove);

      row.append(head, foot);
      list.appendChild(row);
    }
  }

  function applyDoingPane() {
    $('allow-system').checked = Boolean(runtime.allowSystem);
    // Named for this machine, since the copy tells the user where to go looking.
    $('bin-name').textContent = binName();
    applyActionsNote();
    applyFileScope();
    renderFileRoots();

    /**
     * Where writing lands, said plainly.
     *
     * With no folder named this is the whole home folder, and that is exactly
     * the case somebody should not have to infer from an empty list.
     */
    const note = $('files-note');
    if (!runtime.allowSystem) note.textContent = '';
    else if (!(runtime.fileRoots || []).length) {
      const where = (runtime.writeRoots || [])[0];
      note.textContent = where
        ? `No folders picked, so Buddy may write and delete anywhere under ${where}. Add one to narrow it.`
        : 'Add a folder to narrow where Buddy may write.';
    } else note.textContent = 'These are the only folders Buddy can write to or delete in.';
  }

  /**
   * Which of the two scopes is on, and what it actually means on this machine.
   *
   * The drives are spelled out rather than described as "everywhere", because
   * "everywhere" is exactly the kind of promise a permission screen should not
   * be making vaguely.
   */
  function applyFileScope() {
    const wide = runtime.fileScope === 'everywhere';
    $('scope-folders').classList.toggle('is-on', !wide);
    $('scope-everywhere').classList.toggle('is-on', wide);

    const where = (runtime.machineRoots || []).join(', ');
    $('scope-note').textContent = wide
      ? `Buddy can read and list anything under ${where || 'this computer'}. It still cannot write to or delete anything outside the folders below, and it will not touch programs, keys or databases whatever the setting says.`
      : 'Buddy cannot see that a file exists unless it is inside a folder you have added.';
  }

  async function setFileScope(fileScope) {
    if (!(await save({ fileScope }))) return;
    applyDoingPane();
    setNote(
      fileScope === 'everywhere' ? 'Buddy can look anywhere on this computer.' : 'Buddy is back to the folders you pick.'
    );
  }

  $('scope-folders').addEventListener('click', () => setFileScope('folders'));
  $('scope-everywhere').addEventListener('click', () => setFileScope('everywhere'));

  /**
   * Say plainly how well this is likely to go. Emitting a structured action on
   * cue is a lot to ask of a 1B model — it will sometimes describe the action
   * instead of performing it — and the honest thing is to say so where the
   * switch is, not to let it look broken.
   */
  function applyActionsNote() {
    const note = $('actions-note');
    if (!runtime.allowSystem) {
      note.textContent = '';
      return;
    }
    const small = runtime.providers.chat === 'builtin' && /1B/i.test(runtime.chatModel || '');
    note.textContent = small
      ? `${runtime.chatModel} is small and will not always get this right — it may describe an action instead of doing it. A larger model under Brain is much more reliable.`
      : 'Ask for something like “open the BBC website” or “search for tide times”.';
  }

  $('wake-toggle').addEventListener('change', (event) => {
    window.buddy.setWakeEnabled(event.target.checked);
    setNote(event.target.checked ? 'Buddy is listening for its name.' : 'Buddy has stopped listening.');
  });

  /**
   * Show the last few things the orb transcribed while listening for its name.
   *
   * "It doesn't work" and "it heard you but read it as *hey buddha*" need
   * completely different fixes, and only one of them is visible from outside.
   */
  async function renderHeard() {
    const list = $('heard-list');
    let entries = [];
    try {
      entries = (await window.buddy.getHeard()) || [];
    } catch {
      /* nothing recorded yet */
    }

    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'pane-lede';
      empty.textContent =
        runtime.providers.asr === 'off'
          ? `Listening is off, so ${buddyName()} is not hearing anything.`
          : 'Nothing yet. Say something near the microphone and it will appear here.';
      list.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'heard' + (entry.matched ? ' is-match' : '');

      const when = document.createElement('span');
      when.className = 'heard-when';
      when.textContent = new Date(entry.at).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      });

      const what = document.createElement('span');
      what.className = 'heard-text';
      what.textContent = entry.note
        ? entry.note
        : entry.text
          ? `“${entry.text}”`
          : 'sound, but no words in it';

      const tag = document.createElement('span');
      tag.className = 'heard-tag';
      tag.textContent = entry.matched ? 'woke' : entry.kind === 'question' ? 'question' : `${entry.seconds.toFixed(1)}s`;

      row.append(when, what, tag);
      list.appendChild(row);
    }
  }

  /** Paint one line of the wake-word walkthrough. */
  function reportStep(step, state, detail) {
    const row = $('wake-probe').querySelector(`[data-step="${step}"]`);
    if (!row) return;

    // The level row also carries a live meter, fed far too often to re-render.
    if (state === 'meter') {
      try {
        const { level } = JSON.parse(detail);
        $('probe-meter').style.width = `${Math.min(100, level * 100).toFixed(1)}%`;
      } catch {
        /* ignore a malformed frame */
      }
      return;
    }

    row.classList.remove('is-run', 'is-ok', 'is-fail');
    row.classList.add(`is-${state}`);
    const note = row.querySelector('em');
    if (note) note.textContent = detail || '';
  }

  function resetProbe() {
    const probe = $('wake-probe');
    probe.hidden = false;
    for (const row of probe.querySelectorAll('.probe-step')) {
      row.classList.remove('is-run', 'is-ok', 'is-fail');
      row.querySelector('em').textContent = '';
    }
    $('probe-meter').style.width = '0%';
  }

  $('mic-test').addEventListener('click', async () => {
    const button = $('mic-test');
    const testNote = $('mic-test-note');
    if (!onRequestMicTest) return;

    button.disabled = true;
    resetProbe();
    testNote.textContent = `Say “${wakePhrase()}”…`;
    try {
      testNote.textContent = (await onRequestMicTest(reportStep)) || '';
    } catch (error) {
      testNote.textContent = error.message;
    }
    button.disabled = false;
  });

  // ── the downloadable voice/hearing assets ───────────────────────────────

  function renderAsset(which, state) {
    const box = $(`${which}-asset`);
    const usingIt = which === 'voice' ? runtime.providers.tts === 'kokoro' : runtime.providers.asr === 'local';

    // Only relevant when the in-app engine is the one selected and not yet here.
    if (!usingIt || state.ready) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    const title = $(`${which}-asset-title`);
    const sub = $(`${which}-asset-sub`);
    const bar = $(`${which}-bar`);
    const button = $(`${which}-get`);

    bar.style.width = `${state.percent || 0}%`;

    const name = buddyName();

    if (state.status === 'downloading' || state.status === 'loading') {
      title.textContent = which === 'voice' ? `Downloading ${name}’s voice…` : `Downloading ${name}’s ears…`;
      sub.textContent = describeProgress(state) || 'Starting…';
      button.hidden = true;
    } else if (state.status === 'error') {
      title.textContent = 'That download did not finish.';
      sub.textContent = state.error || 'Something went wrong.';
      button.hidden = false;
      button.textContent = 'Try again';
    } else {
      title.textContent =
        which === 'voice' ? `${name}’s own voice isn’t downloaded yet` : `${name}’s ears aren’t downloaded yet`;
      sub.textContent =
        which === 'voice'
          ? 'A one-time 156 MB download. After it, speaking never needs the internet.'
          : 'A one-time 39 MB download. After it, listening never needs the internet.';
      button.hidden = false;
      button.textContent = 'Download it';
    }
  }

  /** What the last poll saw, so a re-read only happens when something changed. */
  let lastAssetState = '';

  async function renderAssets() {
    try {
      const state = await api('/speech');
      renderAsset('voice', state.voice);
      renderAsset('hearing', state.hearing);

      const moving = (entry) => entry.status === 'downloading' || entry.status === 'loading';
      if (moving(state.voice) || moving(state.hearing)) workInFlight = true;

      if (state.voice.ready && !voicesLoaded && runtime.providers.tts === 'kokoro') await loadVoices();

      // A download finishing changes what the rest of the app may offer, but this
      // polls repeatedly — so only tell anyone when the answer actually moves.
      const now = `${state.voice.ready}:${state.hearing.ready}`;
      if (lastAssetState && now !== lastAssetState) {
        await refreshRuntime();
        applyHearingPanes();
        if (onChanged) onChanged();
      }
      lastAssetState = now;
    } catch {
      /* the section simply shows nothing rather than an alarming error */
    }
  }

  for (const which of ['voice', 'hearing']) {
    $(`${which}-get`).addEventListener('click', async () => {
      $(`${which}-get`).hidden = true;
      try {
        await api('/speech', { what: which });
      } catch (error) {
        setNote(error.message, true);
      }
      await renderAssets();
    });
  }

  // ── name, colour, theme, size ───────────────────────────────────────────

  /**
   * Everything in this pane repaints the app the instant it is saved, so each
   * control writes through on change and lets the runtime broadcast do the rest.
   * The two text fields are the exception: saving on every keystroke would send
   * a settings write per letter and rename Buddy to "A", then "Ad", then "Ada".
   */
  const nameField = $('buddy-name');
  const wakeField = $('wake-word');

  function renderSwatches() {
    const swatches = $('accent-swatches');
    const current = (runtime.look || {}).accent;
    swatches.replaceChildren();

    for (const preset of ACCENT_PRESETS) {
      const stops = accentStops(preset.accent);
      const rgb = ({ r, g, b }) => `rgb(${r}, ${g}, ${b})`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch' + (preset.accent === current ? ' is-on' : '');
      button.title = preset.label;
      button.setAttribute('aria-label', preset.label);
      button.style.background =
        `radial-gradient(circle at 34% 30%, ${rgb(stops.amber)}, ${rgb(stops.rose)} 52%, ${rgb(stops.fuchsia)} 100%)`;
      button.addEventListener('click', () => setAccent(preset.accent, preset.label));
      swatches.appendChild(button);
    }
  }

  async function setAccent(accent, label) {
    // Paint first. A colour picker that waits for a round trip before showing
    // the colour feels broken, and the save that follows is what makes it stick.
    applyLook({ ...runtime.look, accent });
    if (await save({ look: { accent } })) setNote(label ? `${label} it is.` : 'Colour changed.');
    renderLook();
  }

  $('accent-custom').addEventListener('input', (event) => {
    applyLook({ ...runtime.look, accent: event.target.value });
  });
  $('accent-custom').addEventListener('change', (event) => setAccent(event.target.value, ''));

  $('theme-choice').addEventListener('change', async (event) => {
    const theme = event.target.value;
    applyLook({ ...runtime.look, theme });
    await save({ look: { theme } });
  });

  function renderOrbSizes() {
    const holder = $('orb-sizes');
    const sizes = runtime.orbSizes || {};
    const current = (runtime.look || {}).orbSize;
    holder.replaceChildren();

    for (const [id, size] of Object.entries(sizes)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'runs-choice' + (id === current ? ' is-on' : '');
      const title = document.createElement('strong');
      title.textContent = size.label || id;
      const note = document.createElement('small');
      note.textContent = `${size.visual}px across`;
      button.append(title, note);
      button.addEventListener('click', async () => {
        applyLook({ ...runtime.look, orbSize: id });
        await save({ look: { orbSize: id } });
        renderLook();
      });
      holder.appendChild(button);
    }
  }

  /**
   * Whether a wake phrase stands a chance.
   *
   * Whisper needs something with enough syllables to recognise; one short word
   * either never fires or fires at everything, and both of those are impossible
   * to diagnose from the outside. Saying so here is much cheaper than the bug
   * report that would otherwise follow.
   */
  function describeWakeWord(phrase) {
    const words = String(phrase || '').trim().split(/\s+/).filter(Boolean);
    const letters = words.join('').length;
    if (!words.length) return { text: 'Buddy will answer to “Hey Buddy”.', warn: false };
    if (letters <= 3) {
      return { text: 'That is very short — expect it to be missed, or to fire at nothing.', warn: true };
    }
    if (words.length === 1 && letters <= 5) {
      return { text: 'One short word will fire more often than you want. Try putting “Hey” in front of it.', warn: true };
    }
    if (words.length > 4) return { text: 'That is a lot to say every time. Two or three words works best.', warn: true };
    return { text: `Say “${phrase.trim()}” and the orb wakes up. Greetings like “Okay” and “Hi” work too.`, warn: false };
  }

  function renderWakeNote() {
    const { text, warn } = describeWakeWord(wakeField.value);
    const note = $('wake-word-note');
    note.textContent = text;
    note.classList.toggle('bad', warn);
  }

  wakeField.addEventListener('input', renderWakeNote);

  /** Commit a text field on blur or Enter, never per keystroke. */
  function commitOnSettle(field, apply) {
    const commit = async () => {
      const value = field.value.trim();
      if (value === field.dataset.saved) return;
      await apply(value);
      field.dataset.saved = value;
    };
    field.addEventListener('blur', commit);
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        field.blur();
      }
    });
  }

  commitOnSettle(nameField, async (value) => {
    if (!(await save({ identity: { name: value } }))) return;
    // The server has the last word on what the name became — it strips and caps
    // it — so show what was actually stored rather than what was typed.
    renderLook();
    setNote(`Now called ${runtime.identity.name}.`);
  });

  commitOnSettle(wakeField, async (value) => {
    if (!(await save({ identity: { wakeWord: value } }))) return;
    renderLook();
    setNote(`Answering to “${runtime.identity.wakeWord}”.`);
  });

  /**
   * Enter has to stay a newline here — this is prose, not a one-line field —
   * so it commits on blur only, rather than through commitOnSettle.
   */
  const aboutField = $('about-you');
  aboutField.addEventListener('blur', async () => {
    const value = aboutField.value.trim();
    if (value === aboutField.dataset.saved) return;
    if (!(await save({ about: value }))) return;
    aboutField.dataset.saved = value;
    renderAboutNote();
    setNote(value ? `${buddyName()} will remember that.` : `${buddyName()} has forgotten that.`);
  });

  function renderAboutNote() {
    const used = (runtime.about || '').length;
    $('about-you-note').textContent = used
      ? `${used} of 600 characters, sent with every message.`
      : 'Optional. Left empty, each conversation starts from nothing.';
  }

  /** Push whatever the server now holds back into every control in this pane. */
  function renderLook() {
    const look = runtime.look || {};
    const identity = runtime.identity || {};

    nameField.value = identity.name || '';
    nameField.dataset.saved = nameField.value;
    wakeField.value = identity.wakeWord || '';
    wakeField.dataset.saved = wakeField.value;
    renderWakeNote();

    // Not overwritten while it has focus: this is a paragraph somebody may be
    // half way through typing when a poll comes back.
    if (document.activeElement !== aboutField) {
      aboutField.value = runtime.about || '';
      aboutField.dataset.saved = aboutField.value;
    }
    renderAboutNote();

    $('accent-custom').value = look.accent || '#f43f5e';
    $('theme-choice').value = look.theme || 'dark';
    renderSwatches();
    renderOrbSizes();

    // The rest of the panel names Buddy in several places; keep those in step
    // with the field the user is looking at right now.
    applyNaming();
  }

  /**
   * Copy elsewhere in settings that quotes the wake word. The asset titles are
   * deliberately not here: renderAsset owns those and repaints them on a poll,
   * so anything written from this side would be wiped within the second.
   */
  /**
   * Everything in the panel that says Buddy's name out loud.
   *
   * This covered three labels and missed six, which only became obvious once
   * renaming could be done by voice: an assistant called Jeff was still
   * offering "Buddy's own ears" and "Off — Buddy cannot hear at all", two
   * controls away from a header reading Jeff. A rename that leaves the old name
   * lying around the settings reads as a rename that did not work.
   */
  function applyNaming() {
    const phrase = wakePhrase();
    const name = buddyName();

    $('wake-toggle-label').textContent = `Answer to “${phrase}”`;
    $('mic-test').textContent = `Test “${phrase}”`;
    $('probe-match-label').textContent = `Matched “${phrase}”`;

    /**
     * Everything else carries its own wording as a template, so adding a
     * heading that names Buddy needs no line here — just the attribute. The
     * markup keeps the default text too, so the file still reads correctly to
     * anybody looking at it rather than being a page full of placeholders.
     */
    for (const element of document.querySelectorAll('[data-name-template]')) {
      element.textContent = element.dataset.nameTemplate.replace(/\{name\}/g, name);
    }

    // The provider pickers name Buddy in the options that mean "in this app".
    const option = (selectId, value) => $(selectId).querySelector(`option[value="${value}"]`);
    const own = [
      [option('tts-provider', 'kokoro'), `${name}'s own voice — neural, on this machine`],
      [option('asr-provider', 'local'), `${name}'s own ears — Whisper, on this machine`],
      [option('asr-provider', 'off'), `Off — ${name} cannot hear at all`],
    ];
    for (const [element, text] of own) if (element) element.textContent = text;

    $('save-history-note').textContent = `Stored as a plain file in ${name}'s own folder. Nothing is uploaded.`;
    $('memory-add-text').placeholder = `Tell ${name} something to remember…`;
  }

  // ── chats ───────────────────────────────────────────────────────────────

  $('save-history').addEventListener('change', async (event) => {
    if (!(await save({ saveHistory: event.target.checked }))) {
      event.target.checked = !event.target.checked;
      return;
    }
    setNote(event.target.checked ? 'New chats will be kept.' : 'Nothing new will be saved.');
    // Remembering rides on saving, so the Memory pane has just changed meaning
    // even though nobody touched it. Say so now rather than on the next poll.
    memoryState.saveHistory = event.target.checked;
    memoryState.enabled = event.target.checked && memoryState.wanted;
    drawMemory();
  });

  let clearArmed = false;
  const clearButton = $('clear-history');

  function resetClear() {
    clearArmed = false;
    clearButton.classList.remove('confirming');
    clearButton.textContent = 'Delete all saved chats';
  }

  clearButton.addEventListener('click', async () => {
    // Deleting everything is worth a second tap rather than a modal.
    if (!clearArmed) {
      clearArmed = true;
      clearButton.classList.add('confirming');
      clearButton.textContent = 'Really delete every chat?';
      setTimeout(() => {
        if (clearArmed) resetClear();
      }, 4000);
      return;
    }
    try {
      const { deleted } = await api('/chats', undefined, { method: 'DELETE' });
      setNote(`Deleted ${deleted} chat${deleted === 1 ? '' : 's'}.`);
      if (onChanged) onChanged();
    } catch (error) {
      setNote(error.message, true);
    }
    resetClear();
    await renderChats();
  });

  async function renderChats() {
    $('save-history').checked = Boolean(runtime.saveHistory);
    try {
      const { chats } = await api('/chats');
      $('chat-count').textContent = chats.length
        ? `${chats.length} conversation${chats.length === 1 ? '' : 's'} saved on this device.`
        : 'Nothing saved yet.';
    } catch {
      $('chat-count').textContent = '';
    }
  }

  // ── the keys that always work ───────────────────────────────────────────

  /**
   * The global shortcuts, written the way this machine writes them.
   *
   * Kept in step with SHORTCUTS in main.js by hand. That is a duplication, but
   * the alternative is shipping the accelerator strings to the renderer and
   * parsing Electron's format here, which is more machinery than two lines of
   * text are worth.
   */
  function renderShortcuts() {
    const mac = boot.platform === 'darwin';
    const mod = mac ? '⌘' : 'Ctrl';
    const shift = mac ? '⇧' : 'Shift';
    const rows = [
      [[mod, shift, 'Space'], `Open ${buddyName()}, ready to type`],
      [[mod, shift, '.'], 'Stop talking'],
    ];

    const list = $('shortcut-list');
    list.replaceChildren();
    for (const [keys, what] of rows) {
      const row = document.createElement('div');
      row.className = 'key-row';

      const combo = document.createElement('span');
      combo.className = 'key-combo';
      keys.forEach((key, index) => {
        if (index) combo.append(document.createTextNode('+'));
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        combo.append(kbd);
      });

      const label = document.createElement('span');
      label.className = 'key-what';
      label.textContent = what;

      row.append(combo, label);
      list.append(row);
    }
  }

  // ── memory ──────────────────────────────────────────────────────────────
  //
  // The list is not a readout of a feature happening elsewhere; it is the part
  // that makes the feature allowable. Buddy holding opinions about somebody is
  // fine as long as they can read every one, correct it and throw it away, so
  // editing is in place, deleting is one click, and nothing is summarised or
  // hidden behind a disclosure.

  /** What the server last told us, so a redraw does not need a round trip. */
  let memoryState = { facts: [], enabled: true, wanted: true, saveHistory: true };

  const icon = (path) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
    return svg;
  };

  const PIN_PATH = 'M7 4h10a2 2 0 0 1 2 2v14l-7-3.5L5 20V6a2 2 0 0 1 2-2z';
  const BIN_PATH = 'M5 7h14M10 7V5h4v2M8 7l1 12h6l1-12';

  /** "3 days ago" beats a timestamp for something whose age is all that matters. */
  function whenish(iso) {
    const at = Date.parse(iso || '');
    if (!Number.isFinite(at)) return '';
    const days = Math.floor((Date.now() - at) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    const months = Math.round(days / 30);
    return months < 12 ? `${months} month${months === 1 ? '' : 's'} ago` : 'over a year ago';
  }

  async function patchFact(id, changes, onFail) {
    try {
      await api(`/memory/${id}`, changes, { method: 'PATCH' });
      return true;
    } catch (error) {
      setNote(error.message, true);
      if (onFail) onFail();
      return false;
    }
  }

  function memoryRow(fact) {
    const row = document.createElement('div');
    row.className = `memory-row${fact.pinned ? ' is-pinned' : ''}`;

    const main = document.createElement('div');
    main.className = 'memory-row-main';

    /*
     * contenteditable rather than an <input>: a fact can run to two lines, and a
     * single-line box that scrolls sideways is a poor place to reread something
     * you are deciding whether to keep. Saved on blur, the same as the About
     * note, and Enter is a save rather than a newline because one fact is one
     * sentence.
     */
    const text = document.createElement('div');
    text.className = 'memory-text';
    text.contentEditable = 'plaintext-only';
    text.spellcheck = false;
    text.role = 'textbox';
    text.textContent = fact.text;
    text.dataset.saved = fact.text;

    text.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        text.blur();
      }
      if (event.key === 'Escape') {
        text.textContent = text.dataset.saved;
        text.blur();
      }
    });

    text.addEventListener('blur', async () => {
      const value = text.textContent.replace(/\s+/g, ' ').trim();
      if (value === text.dataset.saved) return;
      if (!value) {
        // Emptying a fact is not how it is deleted — there is a button for that,
        // and silently deleting on blur would make a stray ctrl-A destructive.
        text.textContent = text.dataset.saved;
        return;
      }
      const ok = await patchFact(fact.id, { text: value }, () => {
        text.textContent = text.dataset.saved;
      });
      if (!ok) return;
      text.dataset.saved = value;
      fact.text = value;
      // The conversation it came from no longer explains a sentence the user
      // has rewritten, and the server drops it — so stop claiming it here too.
      fact.source = null;
      source.textContent = sourceLine(fact);
      setNote('Reworded.');
    });

    const source = document.createElement('small');
    source.className = 'memory-source';
    source.textContent = sourceLine(fact);

    main.append(text, source);

    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = `memory-row-act${fact.pinned ? ' is-on' : ''}`;
    pin.title = fact.pinned ? 'Always remembered — click to unpin' : 'Always remember this';
    pin.setAttribute('aria-label', pin.title);
    pin.setAttribute('aria-pressed', String(Boolean(fact.pinned)));
    pin.append(icon(PIN_PATH));
    pin.addEventListener('click', async () => {
      const next = !fact.pinned;
      if (!(await patchFact(fact.id, { pinned: next }))) return;
      fact.pinned = next;
      row.classList.toggle('is-pinned', next);
      pin.classList.toggle('is-on', next);
      pin.setAttribute('aria-pressed', String(next));
      pin.title = next ? 'Always remembered — click to unpin' : 'Always remember this';
      pin.setAttribute('aria-label', pin.title);
      setNote(next ? `${buddyName()} will always keep that in mind.` : 'No longer pinned.');
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'memory-row-act del';
    del.title = 'Forget this';
    del.setAttribute('aria-label', `Forget: ${fact.text}`);
    del.append(icon(BIN_PATH));
    del.addEventListener('click', async () => {
      try {
        await api(`/memory/${fact.id}`, undefined, { method: 'DELETE' });
      } catch (error) {
        return setNote(error.message, true);
      }
      memoryState.facts = memoryState.facts.filter((entry) => entry.id !== fact.id);
      drawMemory();
      setNote('Forgotten.');
    });

    row.append(main, pin, del);
    return row;
  }

  /** Where a fact came from, which is the answer to "why does it think that?". */
  function sourceLine(fact) {
    const when = whenish(fact.at);
    if (!fact.source || !fact.source.title) return when ? `You told ${buddyName()} this, ${when}` : 'You wrote this';
    return `From “${fact.source.title}”${when ? `, ${when}` : ''}`;
  }

  /** Redraw from `memoryState` alone — no request, so edits feel immediate. */
  function drawMemory() {
    const { facts, enabled, wanted, saveHistory } = memoryState;

    $('memory-enabled').checked = Boolean(wanted);
    $('memory-enabled').closest('.switch').classList.toggle('is-paused', Boolean(wanted) && !saveHistory);
    // The switch can be on while nothing is being remembered, and saying so is
    // better than showing it off and letting somebody wonder who moved it.
    $('memory-switch-note').textContent = !saveHistory
      ? `Paused: ${buddyName()} only remembers while chats are being saved — turn that back on at the top of this page.`
      : enabled
        ? `${buddyName()} notes what seems worth keeping and uses it in later chats. Everything it remembers is listed below.`
        : `Off — ${buddyName()} starts every conversation knowing only what you have written here.`;

    $('memory-count').textContent = facts.length
      ? `${facts.length} thing${facts.length === 1 ? '' : 's'} remembered. Click any of them to correct it.`
      : '';

    const list = $('memory-list');
    list.replaceChildren();
    if (!facts.length) {
      const empty = document.createElement('p');
      empty.className = 'memory-empty';
      empty.textContent = enabled
        ? `Nothing yet. ${buddyName()} will note things as you talk — or tell it something above.`
        : `Nothing remembered.`;
      list.append(empty);
    } else {
      for (const fact of facts) list.append(memoryRow(fact));
    }

    $('memory-clear').hidden = !facts.length;
  }

  $('memory-enabled').addEventListener('change', async (event) => {
    const wanted = event.target.checked;
    if (!(await save({ memory: { enabled: wanted, max: memoryState.max } }))) {
      event.target.checked = !wanted;
      return;
    }
    memoryState.wanted = wanted;
    memoryState.enabled = wanted && memoryState.saveHistory;
    drawMemory();
    setNote(
      wanted
        ? memoryState.saveHistory
          ? `${buddyName()} will remember things as you talk.`
          : `Saved — but ${buddyName()} cannot remember while chats are not being kept.`
        : `${buddyName()} will stop noting things down. What it already knows is kept below.`
    );
  });

  $('memory-add').addEventListener('submit', async (event) => {
    event.preventDefault();
    const field = $('memory-add-text');
    const text = field.value.trim();
    if (!text) return;
    try {
      const { updated } = await api('/memory', { text });
      field.value = '';
      setNote(updated ? `${buddyName()} already knew something like that, and updated it.` : 'Remembered.');
      await renderMemory();
    } catch (error) {
      setNote(error.message, true);
    }
  });

  let forgetArmed = false;
  const forgetButton = $('memory-clear');

  function resetForget() {
    forgetArmed = false;
    forgetButton.classList.remove('confirming');
    forgetButton.textContent = 'Forget everything';
  }

  forgetButton.addEventListener('click', async () => {
    // Same second tap as deleting every chat, and for the same reason: there is
    // nothing behind this one either.
    if (!forgetArmed) {
      forgetArmed = true;
      forgetButton.classList.add('confirming');
      forgetButton.textContent = 'Really forget all of it?';
      setTimeout(() => {
        if (forgetArmed) resetForget();
      }, 4000);
      return;
    }
    try {
      const { deleted } = await api('/memory', undefined, { method: 'DELETE' });
      setNote(`Forgot ${deleted} thing${deleted === 1 ? '' : 's'}.`);
    } catch (error) {
      setNote(error.message, true);
    }
    resetForget();
    await renderMemory();
  });

  async function renderMemory() {
    try {
      const state = await api('/memory');
      memoryState = state;
    } catch {
      /* leave the pane showing what it last knew rather than blanking it */
    }
    drawMemory();
  }

  // ── about ───────────────────────────────────────────────────────────────

  function renderAbout() {
    $('about-version').textContent = `${buddyName()} ${boot.version || ''} — a local-first AI companion.`.replace(
      '  ',
      ' '
    );

    const facts = $('about-facts');
    facts.replaceChildren();

    /** Anything answered by somebody else's server is not on this machine. */
    const isLocal = (provider) => provider !== 'z-ai' && provider !== 'cloud';
    /** The label of a saved key, for naming who is actually being used. */
    const keyLabel = (id) => {
      const found = (runtime.keys || []).find((entry) => entry.id === id);
      return found ? found.label : 'a cloud provider';
    };

    const where = [
      ['Thinking', runtime.chatModel, isLocal(runtime.providers.chat)],
      [
        'Speaking',
        runtime.providers.tts === 'kokoro'
          ? 'Kokoro, in this app'
          : runtime.providers.tts === 'system'
            ? "this computer's voices"
            : runtime.providers.tts === 'cloud'
              ? keyLabel(runtime.ttsCloudProvider)
              : 'the z-ai cloud',
        isLocal(runtime.providers.tts),
      ],
      [
        'Listening',
        runtime.providers.asr === 'local'
          ? 'Whisper, in this app'
          : runtime.providers.asr === 'whisper'
            ? 'your own Whisper server'
            : runtime.providers.asr === 'off'
              ? 'turned off'
              : runtime.providers.asr === 'cloud'
                ? keyLabel(runtime.asrCloudProvider)
                : 'the z-ai cloud',
        isLocal(runtime.providers.asr),
      ],
    ];

    for (const [label, value, isLocal] of where) {
      const row = document.createElement('div');
      row.className = 'fact';
      const key = document.createElement('span');
      key.className = 'fact-key';
      key.textContent = label;
      const val = document.createElement('span');
      val.className = 'fact-value';
      val.textContent = value || '—';
      const tag = document.createElement('span');
      tag.className = `fact-tag ${isLocal ? 'local' : 'cloud'}`;
      tag.textContent = isLocal ? 'on this machine' : 'cloud';
      row.append(key, val, tag);
      facts.appendChild(row);
    }

    const summary = document.createElement('p');
    summary.className = 'pane-lede';
    summary.textContent = runtime.fullyLocal
      ? 'Nothing you say or type leaves this machine.'
      : 'Some of what you say is sent to a cloud API.';
    facts.appendChild(summary);

    /*
     * The one consequence of remembering that is not obvious from the Memory
     * pane. Recalled facts are part of the instructions the model is given, so
     * a cloud brain is sent them along with the question — which is exactly
     * what the pane exists to make checkable rather than assumed.
     */
    if (!isLocal(runtime.providers.chat) && memoryState.enabled && memoryState.facts.length) {
      const carried = document.createElement('p');
      carried.className = 'pane-lede';
      carried.textContent =
        `Because the thinking is done in the cloud, what ${buddyName()} remembers about you is sent ` +
        'there too, with any message it turns out to be relevant to. Memory has the list.';
      facts.appendChild(carried);
    }
  }

  $('open-folder').addEventListener('click', () => window.buddy.openConfigFolder());

  // ── polling while the pane is open ──────────────────────────────────────

  /**
   * One pass, then schedule the next.
   *
   * A self-scheduling timeout rather than an interval, for two reasons: the
   * three requests cannot pile up on top of each other when the machine is busy
   * (an interval does not wait for the previous tick to finish), and the gap can
   * be chosen afresh each time from whether anything is actually moving.
   */
  async function poll() {
    if (!visible) return;
    workInFlight = false;
    await Promise.allSettled([renderAssets(), renderModels(), renderHeard()]);
    if (!visible) return;
    pollTimer = setTimeout(poll, workInFlight ? POLL_BUSY_MS : POLL_IDLE_MS);
  }

  function startPolling() {
    stopPolling();
    pollTimer = setTimeout(poll, POLL_BUSY_MS);
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  // ── open / close ────────────────────────────────────────────────────────

  async function renderAll() {
    applyVoicePanes();
    applyHearingPanes();
    applyDoingPane();
    applyRuns();
    renderLook();
    renderKeys();
    $('whisper-url').value = runtime.asrBaseUrl || '';
    renderShortcuts();
    await Promise.all([renderModels(), renderAssets(), renderChats(), renderMemory(), renderHeard()]);
    // After the others, not before: the About pane's note about memories going
    // to a cloud brain needs the memory state that renderMemory has just fetched.
    renderAbout();
    if ((runtime.providers.tts === 'kokoro' || runtime.providers.tts === 'cloud') && !voicesLoaded) await loadVoices();
    if (runtime.providers.tts === 'system') loadSystemVoices();
  }

  return {
    get visible() {
      return visible;
    },

    async open() {
      visible = true;
      sheet.hidden = false;
      // Providers add and retire models; re-ask rather than trusting a list
      // gathered the last time settings happened to be open.
      modelCache.clear();
      setKeyNote('');
      resetKeyForm();
      await refreshRuntime();
      await renderAll();
      // Downloads and switches change under us, so keep the view honest while open.
      startPolling();
    },

    close() {
      visible = false;
      sheet.hidden = true;
      stopPolling();
      resetClear();
      setNote('');
    },

    /** Keep the wake checkbox in step when the tray or the orb changes it. */
    syncWake(enabled) {
      $('wake-toggle').checked = Boolean(enabled);
    },
  };
}
