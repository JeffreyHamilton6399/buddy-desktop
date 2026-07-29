/* Buddy landing page — no build step, no dependencies. */
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Set these two to your GitHub owner and repo. Everything on the page that
// links to GitHub is derived from them.
// ─────────────────────────────────────────────────────────────────────────────
const OWNER = 'your-github-username';
const REPO = 'buddy';

const REPO_URL = `https://github.com/${OWNER}/${REPO}`;
const RELEASES_LATEST = `${REPO_URL}/releases/latest`;

(function wireLinks() {
  const links = {
    'hero-download': RELEASES_LATEST,
    'hero-source': REPO_URL,
    'download-btn': RELEASES_LATEST,
    'nav-demo': RELEASES_LATEST,
    'footer-repo': REPO_URL,
  };

  for (const [id, href] of Object.entries(links)) {
    const element = document.getElementById(id);
    if (!element) continue;
    element.href = href;
    if (element.id !== 'download-btn') {
      element.rel = 'noopener';
      element.target = '_blank';
    }
  }
})();

/** Name the visitor's platform so the download button is less of a guess. */
(function detectPlatform() {
  const agent = navigator.userAgent;
  const platform = navigator.platform || '';

  const isMac = /Mac/i.test(agent) || /Mac/i.test(platform);
  const isWindows = /Win/i.test(agent) || /Win/i.test(platform);
  const isLinux = !isMac && !isWindows && /Linux|X11|Ubuntu/i.test(agent);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(agent);

  const button = document.getElementById('download-btn');
  const hero = document.getElementById('hero-download');
  const hint = document.getElementById('download-hint');
  const heroNote = document.getElementById('hero-platform');

  if (isMobile) {
    if (heroNote) heroNote.textContent = 'Buddy is a desktop app — open this page on your computer to install it.';
    if (hint) hint.textContent = 'Buddy needs a desktop: macOS, Windows or Linux.';
    return;
  }

  let label = null;
  if (isMac) label = 'macOS';
  else if (isWindows) label = 'Windows';
  else if (isLinux) label = 'Linux';
  if (!label) return;

  const text = `Download for ${label}`;
  if (button) button.textContent = text;
  if (hero) hero.textContent = text;
  // The button goes to /releases/latest; the release page lists every asset, so
  // this stays correct even when asset filenames change between versions.
  if (hint) hint.textContent = `Opens the latest release — pick the ${label} file.`;
})();

/* mobile nav */
(function mobileNav() {
  const toggle = document.getElementById('nav-toggle');
  const links = document.getElementById('nav-links');
  if (!toggle || !links) return;

  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  links.addEventListener('click', (event) => {
    if (event.target.tagName !== 'A') return;
    links.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  });
})();

/* fade sections in as they scroll into view */
(function reveal() {
  // Opt in to the hidden starting state only now that we know JS is running.
  document.documentElement.classList.add('js');

  const items = Array.from(document.querySelectorAll('.reveal'));
  if (!items.length) return;

  if (!('IntersectionObserver' in window)) {
    items.forEach((item) => item.classList.add('shown'));
    return;
  }

  // Anything already on screen should just be there — no transition to miss.
  const fold = window.innerHeight;
  const pending = items.filter((item) => {
    if (item.getBoundingClientRect().top >= fold) return true;
    item.classList.add('instant', 'shown');
    return false;
  });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry, index) => {
        if (!entry.isIntersecting) return;
        // A small stagger keeps a row of cards from popping in all at once.
        setTimeout(() => entry.target.classList.add('shown'), index * 70);
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
  );

  pending.forEach((item) => observer.observe(item));
})();
