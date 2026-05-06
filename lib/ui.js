// Picks a UI adapter (macOS dialogs vs. terminal) on first call and
// re-exports its API. Adapter contract:
//   confirm({ message })                  → Promise<true>     — throws CancelledError on cancel
//   askText({ message })                  → Promise<string>   — '' if submitted empty; throws on cancel
//   choose({ message, choices })          → Promise<value>    — choices: [{label, value}, ...]
//   notifyStart({ message })              → Promise<void>     — fire-and-forget "work begun" cue
//   success({ url, fileCount, skipped })  → Promise<void>     — final success UX (incl. clipboard)
//   error({ message, logPath })           → Promise<void>     — final error UX
//
// Selection is deferred until first call so gallery.js's --cli flag (which
// sets DROPGALLERY_UI=cli) is observed despite ESM import hoisting.

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
