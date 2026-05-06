// macOS adapter — AppleScript dialogs for prompts, `display notification`
// for the work-begun cue, lib/output.js for the final success/error UX.

import { runOsascript, escapeAppleScript } from './osascript.js';
import { CancelledError } from './cancelled.js';
import { showSuccess, showError } from './output.js';

const APP_TITLE = 'DropGallery';
const isCancel = (err) => /User canceled/i.test(err.stderr || err.message || '');

export async function confirm({ message }) {
  const script =
    `display dialog "${escapeAppleScript(message)}" ` +
    `buttons {"Cancel", "Continue"} ` +
    `default button "Continue" ` +
    `cancel button "Cancel" ` +
    `with title "${APP_TITLE}"`;
  try {
    await runOsascript(script);
    return true;
  } catch (err) {
    if (isCancel(err)) throw new CancelledError('confirm');
    throw err;
  }
}

export async function askText({ message }) {
  const script =
    `set theResult to display dialog "${escapeAppleScript(message)}" ` +
    `default answer "" ` +
    `buttons {"Cancel", "OK"} ` +
    `default button "OK" ` +
    `cancel button "Cancel" ` +
    `with title "${APP_TITLE}"\n` +
    `return text returned of theResult`;
  try {
    return await runOsascript(script);
  } catch (err) {
    if (isCancel(err)) throw new CancelledError('askText');
    throw err;
  }
}

export async function choose({ message, choices }) {
  // `choose from list` returns the label (or `false` on cancel) — map it
  // back to the caller's value field.
  const labelList = choices.map((c) => `"${escapeAppleScript(c.label)}"`).join(', ');
  const script =
    `set theChoice to choose from list ` +
    `{${labelList}} ` +
    `with prompt "${escapeAppleScript(message)}" ` +
    `with title "${APP_TITLE}" ` +
    `OK button name "Choose" ` +
    `cancel button name "Cancel"\n` +
    `if theChoice is false then\n` +
    `  error "User canceled."\n` +
    `end if\n` +
    `return item 1 of theChoice`;

  let chosenLabel;
  try {
    chosenLabel = await runOsascript(script);
  } catch (err) {
    if (isCancel(err)) throw new CancelledError('choose');
    throw err;
  }
  const match = choices.find((c) => c.label === chosenLabel);
  if (!match) throw new Error(`Unexpected choice: ${JSON.stringify(chosenLabel)}`);
  return match.value;
}

// Fire-and-forget toast that fills the silent gap before the success dialog.
export async function notifyStart({ message }) {
  const script =
    `display notification "${escapeAppleScript(message)}" ` +
    `with title "${APP_TITLE}"`;
  try {
    await runOsascript(script);
  } catch (_e) {
    // Don't fail the run if notifications are blocked / unavailable.
  }
}

export async function success(args) { return showSuccess(args); }
export async function error(args) { return showError(args); }
