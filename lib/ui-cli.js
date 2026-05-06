// Terminal UI adapter — default on Linux/Windows, opt-in on macOS via --cli.
// Prompts via @inquirer/prompts, spinner via ora, clipboard via clipboardy.

import {
  confirm as inquirerConfirm,
  input as inquirerInput,
  select as inquirerSelect,
} from '@inquirer/prompts';
import ora from 'ora';
import clipboard from 'clipboardy';
import { CancelledError } from './cancelled.js';

// Inquirer throws ExitPromptError (Ctrl+C / Esc) or CancelPromptError on
// cancel; either way we want a clean exit 0.
function isCancelError(err) {
  const name = err && err.constructor && err.constructor.name;
  return name === 'ExitPromptError' || name === 'CancelPromptError';
}

// Held across notifyStart → success/error so we can .succeed()/.fail() it.
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
