/**
 * First run. There is nothing to configure and nothing to decide: Buddy fetches
 * its model once, shows how far along it is, and starts. The cloud form exists
 * only for people who go looking for it.
 *
 * The voice and the ears are fetched too, but they are not waited for — they are
 * a few hundred megabytes between them, and Buddy is perfectly usable by typing
 * while they arrive. That download is started here and finishes in the background;
 * the settings panel is where its progress lives.
 */
'use strict';

import { $, api, formatBytes, formatDuration } from './core.js';

export function initSetup() {
  const ready = $('ready');
  const form = $('setup-form');
  const barFill = $('bar-fill');
  const line = $('ready-line');
  const sub = $('ready-sub');
  const title = $('ready-title');
  const lede = $('ready-lede');
  const retry = $('ready-retry');
  const saveButton = $('setup-save');
  const errorBox = $('setup-error');

  let polling = null;
  let finished = false;

  const MB = 1048576;

  function stopPolling() {
    clearInterval(polling);
    polling = null;
  }

  // Closing setup without finishing ends the run — Buddy has nothing to run on.
  $('setup-close').addEventListener('click', () => window.close());

  // ── the download ────────────────────────────────────────────────────────

  function render(state) {
    if (state.status === 'error') {
      ready.classList.add('failed');
      barFill.classList.remove('indeterminate');
      // Show how far it got: the copy below promises the progress was kept, so an
      // empty bar would contradict it.
      barFill.style.width = `${state.percent || 0}%`;
      title.textContent = "That didn't work.";
      lede.textContent = 'I could not finish downloading my model.';
      line.textContent = state.error || 'The download failed.';
      sub.textContent =
        'Your progress was kept, so trying again picks up where it stopped. A different network often helps.';
      retry.hidden = false;
      return;
    }

    ready.classList.remove('failed');
    retry.hidden = true;

    if (state.status === 'verifying') {
      barFill.classList.remove('indeterminate');
      barFill.style.width = '100%';
      line.textContent = 'Checking the download…';
      sub.textContent = 'Making sure every byte arrived intact before I use it.';
      return;
    }

    if (state.ready) {
      barFill.classList.remove('indeterminate');
      barFill.style.width = '100%';
      title.textContent = "All set. I'm Buddy.";
      lede.textContent = 'Starting up…';
      line.textContent = 'Ready';
      sub.textContent = 'My voice and my ears are still coming down in the background — you can start now.';
      return;
    }

    // Downloading, or still waiting for the first byte.
    const started = state.receivedBytes > 0;
    barFill.classList.toggle('indeterminate', !started);
    if (started) barFill.style.width = state.percent + '%';

    const bits = [];
    if (started) bits.push(`${formatBytes(state.receivedBytes)} of ${formatBytes(state.totalBytes)}`);
    if (state.bytesPerSecond > 0) bits.push((state.bytesPerSecond / MB).toFixed(1) + ' MB/s');
    const eta = formatDuration(state.etaSeconds);
    if (eta) bits.push(eta);
    line.textContent = started ? bits.join('  ·  ') : 'Starting the download…';
  }

  async function finish() {
    if (finished) return;
    finished = true;
    stopPolling();
    // Writing the settings file is what marks this install as past its first run.
    // All three capabilities are named explicitly rather than left to the defaults:
    // if a previous attempt had pointed any of them at the cloud, writing only the
    // chat provider would leave those behind, and an install with cloud speech and
    // no API key never counts as configured — so setup would reopen on every
    // launch, forever.
    try {
      await api('/settings', {
        chat: { provider: 'builtin' },
        tts: { provider: 'kokoro' },
        asr: { provider: 'local' },
      });
    } catch (error) {
      console.warn('[buddy] could not persist settings:', error.message);
    }
    // Start the voice and the ears, but do not wait: this runs in the server, so
    // it carries on after this window has gone.
    api('/speech', { what: 'both' }).catch(() => {
      /* the settings panel will offer it again */
    });
    setTimeout(() => window.buddy.setupComplete(), 700);
  }

  async function poll() {
    try {
      const state = await api('/model');
      render(state);
      if (state.ready) await finish();
    } catch (error) {
      render({ status: 'error', error: error.message, receivedBytes: 0, totalBytes: 1, percent: 0 });
    }
  }

  async function beginDownload() {
    ready.classList.remove('failed');
    retry.hidden = true;
    render({ status: 'downloading', receivedBytes: 0, totalBytes: 1, percent: 0, bytesPerSecond: 0 });
    try {
      const state = await api('/model', {});
      render(state);
      if (state.ready) return finish();
    } catch (error) {
      return render({ status: 'error', error: error.message, receivedBytes: 0, totalBytes: 1, percent: 0 });
    }
    stopPolling();
    polling = setInterval(poll, 500);
  }

  retry.addEventListener('click', beginDownload);

  // ── the cloud escape hatch ──────────────────────────────────────────────

  $('show-advanced').addEventListener('click', () => {
    stopPolling();
    ready.hidden = true;
    form.hidden = false;
    title.textContent = 'Use a cloud API';
    lede.textContent = 'Only if you want to. The built-in model needs none of this.';
    $('setup-key').focus();
  });

  $('hide-advanced').addEventListener('click', () => {
    form.hidden = true;
    ready.hidden = false;
    errorBox.hidden = true;
    title.textContent = "Hey, I'm Buddy.";
    lede.textContent = 'Getting my brain ready — this happens once.';
    beginDownload();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const baseUrl = $('setup-baseurl').value.trim();
    const apiKey = $('setup-key').value.trim();
    if (!baseUrl || !apiKey) {
      errorBox.textContent = 'Both the base URL and the API key are required.';
      errorBox.hidden = false;
      return;
    }

    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      await api('/setup', { baseUrl, apiKey });
      await api('/settings', {
        chat: { provider: 'z-ai' },
        tts: { provider: 'z-ai', voice: 'tongtong' },
        asr: { provider: 'z-ai' },
      });
      finished = true;
      stopPolling();
      window.buddy.setupComplete();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      saveButton.disabled = false;
      saveButton.textContent = 'Use this cloud API';
    }
  });

  beginDownload();
}
