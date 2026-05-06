// macOS adapter for lib/ui.js. Implements the dispatcher contract using
// AppleScript dialogs (existing osascript helpers) for prompts + final
// success/error, and a `display notification` for the new "work has begun"
// cue between the third prompt and the success dialog.
//
// Notes:
// - confirm/askText/choose reimplement the previous lib/prompts.js logic
//   inline against the generic { message, choices } interface so we don't
//   have to keep prompts.js's older fixed-purpose signatures.
// - success/error delegate to the existing lib/output.js — its dialogs
//   already match the macOS UX we want.

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
  // AppleScript `choose from list` returns the chosen label (or `false` on
  // cancel). We map that label back to the caller's `value` field.
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

// Native macOS notification — fire-and-forget. This is the new piece: it
// fills the silent gap between the third prompt and the success dialog.
// `display notification` also pings the system sound by default, which is a
// nice "work has begun" cue.
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
