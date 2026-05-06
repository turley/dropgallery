// UI dispatcher. Picks an adapter based on platform and re-exports its API,
// so `gallery.js` can do `import * as ui from './lib/ui.js'` and not care
// whether it's running on macOS or in a terminal somewhere else.
//
// Adapter contract (each method on each adapter):
//   confirm({ message })            → Promise<true>          — throws CancelledError on cancel
//   askText({ message })            → Promise<string>        — throws CancelledError on cancel; '' if user submitted empty
//   choose({ message, choices })    → Promise<value>         — choices: [{label, value}, ...]; throws CancelledError on cancel
//   notifyStart({ message })        → Promise<void>          — fire-and-forget "work has begun" cue (notification on darwin, ora spinner on cli)
//   success({ url, fileCount, skipped }) → Promise<void>     — final success UX, including clipboard copy
//   error({ message, logPath })     → Promise<void>          — final error UX
//
// DROPGALLERY_UI=cli forces the CLI adapter on any platform — gallery.js
// sets this when invoked with --cli, but it's also usable directly as an
// override (e.g. for unattended scripts on macOS).
//
// Adapter selection happens on first call, NOT at module-load time: ESM
// imports are hoisted, so any process.env tweaks gallery.js makes before
// dispatching the work would otherwise run too late to be observed here.

let adapterPromise = null;
function getAdapter() {
  if (!adapterPromise) {
    const useCli = process.env.DROPGALLERY_UI === 'cli' || process.platform !== 'darwin';
    adapterPromise = import(useCli ? './ui-cli.js' : './ui-darwin.js');
  }
  return adapterPromise;
}

export async function confirm(args)    { return (await getAdapter()).confirm(args); }
export async function askText(args)    { return (await getAdapter()).askText(args); }
export async function choose(args)     { return (await getAdapter()).choose(args); }
export async function notifyStart(args){ return (await getAdapter()).notifyStart(args); }
export async function success(args)    { return (await getAdapter()).success(args); }
export async function error(args)      { return (await getAdapter()).error(args); }
export { CancelledError } from './cancelled.js';
