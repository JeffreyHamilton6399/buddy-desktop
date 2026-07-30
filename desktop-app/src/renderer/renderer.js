/**
 * Buddy — renderer entry point. One document serves three window modes
 * (orb / panel / setup); the mode arrives as a query parameter from main.js and
 * decides which module takes over.
 */
'use strict';

import { MODE, FLAT, $, loadBoot, refreshRuntime } from './core.js';
import { initOrb } from './orb.js';
import { initPanel } from './panel.js';
import { initSetup } from './setup.js';

async function main() {
  document.body.dataset.mode = MODE;
  if (FLAT) document.body.classList.add('flat');

  const root = $(`root-${MODE}`);
  if (root) root.hidden = false;

  // Nothing may talk to the server before we know the port and the token.
  await loadBoot();
  // Where each capability runs decides what the UI can offer.
  await refreshRuntime();

  if (MODE === 'orb') initOrb();
  else if (MODE === 'setup') initSetup();
  else initPanel();
}

main().catch((error) => {
  console.error('[buddy] renderer failed to start:', error);
});
