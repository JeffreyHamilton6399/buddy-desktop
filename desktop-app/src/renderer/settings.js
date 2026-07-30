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

import { $, api, boot, runtime, refreshRuntime, formatBytes, describeProgress } from './core.js';
import { previewVoice } from './speech.js';

const POLL_MS = 700;

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

  function modelCard(entry) {
    const card = document.createElement('div');
    card.className = 'card' + (entry.active ? ' is-active' : '');

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
      if (entry.active) {
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
            setNote(`${entry.model.label} will answer from now on.`);
          }
          await renderModels();
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

      if (entry.memoryHint) {
        const hint = document.createElement('span');
        hint.className = 'card-note';
        hint.textContent = `Needs ${entry.memoryHint}`;
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

  async function renderModels() {
    let payload;
    try {
      payload = await api('/models');
    } catch (error) {
      $('model-list').textContent = `Couldn't read the model list: ${error.message}`;
      return;
    }

    const list = $('model-list');
    list.replaceChildren(...payload.models.map(modelCard));

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

  $('use-cloud').addEventListener('click', async () => {
    if (
      await save({
        chat: { provider: 'z-ai' },
        tts: { provider: 'z-ai' },
        asr: { provider: 'z-ai' },
      })
    ) {
      setNote('Switched to the cloud. It needs an API key in Buddy’s config file to work.');
      await renderAll();
    }
  });

  // ── voice ───────────────────────────────────────────────────────────────

  async function loadKokoroVoices() {
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

  function applyVoicePanes() {
    const provider = runtime.providers.tts;
    $('tts-provider').value = provider;
    $('kokoro-options').hidden = provider !== 'kokoro';
    $('system-options').hidden = provider !== 'system';
    $('tts-speed').value = String(runtime.ttsSpeed || 1);
    $('tts-speed-value').textContent = `${Number(runtime.ttsSpeed || 1).toFixed(2)}x`;
  }

  $('tts-provider').addEventListener('change', async (event) => {
    const provider = event.target.value;
    // A Kokoro voice id means nothing to speechSynthesis and vice versa.
    if (await save({ tts: { provider, voice: '' } })) {
      await refreshRuntime();
      applyVoicePanes();
      if (provider === 'kokoro') await loadKokoroVoices();
      if (provider === 'system') loadSystemVoices();
      renderAssets();
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
    $('allow-actions').checked = Boolean(runtime.allowActions);
    applyActionsNote();
    const wake = $('wake-toggle');
    wake.checked = Boolean(getWakeEnabled ? getWakeEnabled() : boot.wakeEnabled);
    // Without a way to transcribe, the wake word has nothing to listen with.
    wake.disabled = runtime.providers.asr === 'off';
  }

  $('asr-provider').addEventListener('change', async (event) => {
    if (await save({ asr: { provider: event.target.value } })) {
      await refreshRuntime();
      applyHearingPanes();
      renderAssets();
    }
  });

  $('whisper-url').addEventListener('change', async (event) => {
    if (event.target.value.trim()) await save({ asr: { baseUrl: event.target.value.trim() } });
  });

  $('allow-actions').addEventListener('change', async (event) => {
    if (!(await save({ allowActions: event.target.checked }))) {
      event.target.checked = !event.target.checked;
      return;
    }
    await refreshRuntime();
    applyActionsNote();
    setNote(event.target.checked ? 'Buddy can open things now.' : 'Buddy can no longer open anything.');
  });

  /**
   * Say plainly how well this is likely to go. Emitting a structured action on
   * cue is a lot to ask of a 1B model — it will sometimes describe the action
   * instead of performing it — and the honest thing is to say so where the
   * switch is, not to let it look broken.
   */
  function applyActionsNote() {
    const note = $('actions-note');
    if (!runtime.allowActions) {
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
    testNote.textContent = 'Say “Hey Buddy”…';
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

    if (state.status === 'downloading' || state.status === 'loading') {
      title.textContent = which === 'voice' ? 'Downloading Buddy’s voice…' : 'Downloading Buddy’s ears…';
      sub.textContent = describeProgress(state) || 'Starting…';
      button.hidden = true;
    } else if (state.status === 'error') {
      title.textContent = 'That download did not finish.';
      sub.textContent = state.error || 'Something went wrong.';
      button.hidden = false;
      button.textContent = 'Try again';
    } else {
      title.textContent =
        which === 'voice' ? 'Buddy’s own voice isn’t downloaded yet' : 'Buddy’s ears aren’t downloaded yet';
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

      if (state.voice.ready && !voicesLoaded && runtime.providers.tts === 'kokoro') await loadKokoroVoices();

      // A download finishing changes what the rest of the app may offer, but this
      // polls every 700ms — so only tell anyone when the answer actually moves.
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

  // ── chats ───────────────────────────────────────────────────────────────

  $('save-history').addEventListener('change', async (event) => {
    if (!(await save({ saveHistory: event.target.checked }))) {
      event.target.checked = !event.target.checked;
      return;
    }
    setNote(event.target.checked ? 'New chats will be kept.' : 'Nothing new will be saved.');
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

  // ── about ───────────────────────────────────────────────────────────────

  function renderAbout() {
    $('about-version').textContent = `Buddy ${boot.version || ''} — a local-first AI companion.`.replace('  ', ' ');

    const facts = $('about-facts');
    facts.replaceChildren();

    const where = [
      ['Thinking', runtime.chatModel, runtime.providers.chat !== 'z-ai'],
      [
        'Speaking',
        runtime.providers.tts === 'kokoro'
          ? 'Kokoro, in this app'
          : runtime.providers.tts === 'system'
            ? "this computer's voices"
            : 'the z-ai cloud',
        runtime.providers.tts !== 'z-ai',
      ],
      [
        'Listening',
        runtime.providers.asr === 'local'
          ? 'Whisper, in this app'
          : runtime.providers.asr === 'whisper'
            ? 'your own Whisper server'
            : runtime.providers.asr === 'off'
              ? 'turned off'
              : 'the z-ai cloud',
        runtime.providers.asr !== 'z-ai',
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
  }

  $('open-folder').addEventListener('click', () => window.buddy.openConfigFolder());

  // ── open / close ────────────────────────────────────────────────────────

  async function renderAll() {
    applyVoicePanes();
    applyHearingPanes();
    $('whisper-url').value = runtime.asrBaseUrl || '';
    renderAbout();
    await Promise.all([renderModels(), renderAssets(), renderChats()]);
    if (runtime.providers.tts === 'kokoro' && !voicesLoaded) await loadKokoroVoices();
    if (runtime.providers.tts === 'system') loadSystemVoices();
  }

  return {
    get visible() {
      return visible;
    },

    async open() {
      visible = true;
      sheet.hidden = false;
      await refreshRuntime();
      await renderAll();
      // Downloads and switches change under us, so keep the view honest while open.
      clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        renderAssets();
        renderModels();
      }, POLL_MS);
    },

    close() {
      visible = false;
      sheet.hidden = true;
      clearInterval(pollTimer);
      pollTimer = null;
      resetClear();
      setNote('');
    },

    /** Keep the wake checkbox in step when the tray or the orb changes it. */
    syncWake(enabled) {
      $('wake-toggle').checked = Boolean(enabled);
    },
  };
}
