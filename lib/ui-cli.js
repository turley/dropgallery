// Cross-platform CLI adapter for lib/ui.js. Used on Linux/Windows by default,
// and on macOS when DROPGALLERY_UI=cli (or the --cli flag) is set.
//
// Prompts via @inquirer/prompts (cross-platform terminal prompts).
// Progress via ora (terminal spinner) — fills the same UX role as the macOS
// `display notification` between prompts and success.
// Clipboard via clipboardy. Opens URLs/files via the `open` npm package.

import {
  confirm as inquirerConfirm,
  input as inquirerInput,
  select as inquirerSelect,
} from '@inquirer/prompts';
import ora from 'ora';
import clipboard from 'clipboardy';
import openInDefault from 'open';
import { CancelledError } from './cancelled.js';

// Inquirer rejects with ExitPromptError (Ctrl+C / Esc) or CancelPromptError
// (when something programmatically cancels the prompt). Either way, the user
// has cancelled — translate to our standard CancelledError so gallery.js
// exits 0 cleanly.
function isCancelError(err) {
  const name = err && err.constructor && err.constructor.name;
  return name === 'ExitPromptError' || name === 'CancelPromptError';
}

// Module-scoped spinner. Lives across notifyStart → success/error so we can
// .succeed()/.fail() it at the end. Calls are no-op if no spinner is active.
let spinner = null;

export async function confirm({ message }) {
  try {
    const ok = await inquirerConfirm({ message, default: true });
    if (!ok) throw new CancelledError('confirm');
    return true;
  } catch (err) {
    if (isCancelError(err)) throw new CancelledError('confirm');
    throw err;
  }
}

export async function askText({ message }) {
  try {
    return await inquirerInput({ message, default: '' });
  } catch (err) {
    if (isCancelError(err)) throw new CancelledError('askText');
    throw err;
  }
}

export async function choose({ message, choices }) {
  try {
    return await inquirerSelect({
      message,
      choices: choices.map((c) => ({ name: c.label, value: c.value })),
    });
  } catch (err) {
    if (isCancelError(err)) throw new CancelledError('choose');
    throw err;
  }
}

export async function notifyStart({ message }) {
  if (spinner) spinner.stop();
  spinner = ora({ text: message, spinner: 'dots' }).start();
}

export async function success({ url, fileCount, skipped = [] }) {
  if (spinner) {
    const noun = fileCount === 1 ? 'file' : 'files';
    spinner.succeed(`Gallery uploaded — ${fileCount} ${noun}`);
    spinner = null;
  }

  try {
    await clipboard.write(url);
    process.stdout.write(`\n  ${url}\n  (copied to clipboard)\n`);
  } catch (_e) {
    process.stdout.write(`\n  ${url}\n  (clipboard unavailable; copy manually)\n`);
  }

  if (skipped.length > 0) {
    process.stdout.write(`\n  ${skipped.length} skipped:\n`);
    for (const s of skipped.slice(0, 8)) {
      const path = s.sourcePath || s.localPath || s.key || '(unknown)';
      const reason = (s.reason || '').replace(/\s+/g, ' ').slice(0, 80);
      process.stdout.write(`    • ${path.split('/').pop()}: ${reason}\n`);
    }
    if (skipped.length > 8) {
      process.stdout.write(`    … and ${skipped.length - 8} more (see log)\n`);
    }
  }
  process.stdout.write('\n');
}

export async function error({ message, logPath }) {
  if (spinner) {
    spinner.fail(message || 'DropGallery failed');
    spinner = null;
  } else {
    process.stderr.write(`\nError: ${message || 'DropGallery failed'}\n`);
  }
  if (logPath) {
    process.stderr.write(`  log: ${logPath}\n`);
  }
}

// Used by no one in the prototype — kept here for symmetry with the macOS
// adapter's `open` usage in showSuccess/showError. Wraps the cross-platform
// open package so consumers can rely on the same call shape later.
export function openInDefaultApp(target) {
  openInDefault(target).catch(() => {});
}
