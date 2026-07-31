/* Buddy landing page — no build step, no dependencies. */
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Set these two to your GitHub owner and repo. Everything on the page that
// links to GitHub is derived from them.
// ─────────────────────────────────────────────────────────────────────────────
const OWNER = 'JeffreyHamilton6399';
const REPO = 'buddy-desktop';

const REPO_URL = `https://github.com/${OWNER}/${REPO}`;
const RELEASES_LATEST = `${REPO_URL}/releases/latest`;

const API_LATEST = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

(function wireLinks() {
  const links = {
    'hero-download': '#download',
    'footer-repo': REPO_URL,
    'all-releases': RELEASES_LATEST,
  };

  for (const [id, href] of Object.entries(links)) {
    const element = document.getElementById(id);
    if (!element) continue;
    element.href = href;
    if (href.startsWith('http')) {
      element.rel = 'noopener';
      element.target = '_blank';
    }
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// Per-platform downloads.
//
// The buttons link straight at the installer rather than at the releases page,
// which means the page has to know the current filenames — and those carry the
// version number, so they change every release. They are read from the GitHub
// API at load time instead of being hardcoded and going stale.
//
// Every button starts out pointing at the releases page, so if the API is
// unreachable — rate limited, offline, blocked — the links still work and the
// visitor lands somewhere they can finish the job by hand.
// ─────────────────────────────────────────────────────────────────────────────

/** Which asset belongs to which button. First match wins, so order matters. */
const ASSET_RULES = [
  ['mac-arm64', (name) => /arm64\.dmg$/i.test(name)],
  ['mac-x64', (name) => /\.dmg$/i.test(name) && !/arm64/i.test(name)],
  ['win', (name) => /\.exe$/i.test(name)],
  ['linux-appimage', (name) => /\.appimage$/i.test(name)],
  ['linux-deb', (name) => /\.deb$/i.test(name)],
];

function formatSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

(function downloads() {
  const buttons = Array.from(document.querySelectorAll('[data-asset]'));
  if (!buttons.length) return;

  // Safe default before — and if — the network answers.
  for (const button of buttons) {
    button.href = RELEASES_LATEST;
    button.rel = 'noopener';
  }

  fetch(API_LATEST, { headers: { Accept: 'application/vnd.github+json' } })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
    .then((release) => {
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const matched = new Map();

      for (const [key, matches] of ASSET_RULES) {
        // .blockmap files sit beside the real ones and must never be offered.
        const asset = assets.find((entry) => !/\.blockmap$/i.test(entry.name) && matches(entry.name));
        if (asset) matched.set(key, asset);
      }

      for (const button of buttons) {
        const key = button.dataset.asset;
        const asset = matched.get(key);
        if (!asset) {
          // Not in this release — leave the link on the releases page rather
          // than pointing it at a file that would 404.
          button.classList.add('is-missing');
          continue;
        }
        button.href = asset.browser_download_url;
        button.removeAttribute('target');

        // The size lives beside the button, not inside it: at three cards across
        // it would otherwise wrap the label mid-phrase ("Apple / Silicon").
        const size = document.querySelector(`[data-size-for="${key}"]`);
        if (size) size.textContent = formatSize(asset.size);
      }

      const version = String(release.tag_name || '').replace(/^v/, '');
      const line = document.getElementById('download-line');
      if (version && line) line.textContent = `Version ${version}. Free and MIT licensed.`;
    })
    .catch(() => {
      // The pre-set releases-page links stand; nothing to undo.
    });
})();

/**
 * Put the visitor's own platform first. Every platform is still shown — this
 * only marks one, because guessing from a user agent is a hint and not a fact.
 *
 * Which Mac is deliberately not guessed: Safari on Apple Silicon still reports
 * an Intel user agent, so picking for them would send half of all Mac visitors
 * the wrong build. Both are offered instead.
 */
(function detectPlatform() {
  const agent = navigator.userAgent;
  const platform = navigator.platform || '';

  const isMac = /Mac/i.test(agent) || /Mac/i.test(platform);
  const isWindows = /Win/i.test(agent) || /Win/i.test(platform);
  const isLinux = !isMac && !isWindows && /Linux|X11|Ubuntu/i.test(agent);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(agent);

  const heroNote = document.getElementById('hero-platform');

  if (isMobile) {
    if (heroNote) heroNote.textContent = 'Buddy is a desktop app — open this page on your computer to install it.';
    return;
  }

  const os = isMac ? 'mac' : isWindows ? 'windows' : isLinux ? 'linux' : null;
  if (!os) return;

  const card = document.querySelector(`.dl-card[data-os="${os}"]`);
  if (!card) return;
  card.classList.add('is-yours');

  const tag = document.createElement('span');
  tag.className = 'dl-tag';
  tag.textContent = 'yours';
  const links = card.querySelector('.dl-links');
  if (links) links.prepend(tag);
})();
