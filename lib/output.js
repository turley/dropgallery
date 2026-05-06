import { spawn } from 'node:child_process';
import { runOsascript, escapeAppleScript } from './osascript.js';

function pbcopy(text) {
  return new Promise((resolve, reject) => {
    const proc = spawn('pbcopy');
    proc.on('error', (err) => {
      // pbcopy missing → log and continue (extremely unlikely on macOS)
      console.error(`pbcopy failed: ${err.message}`);
      resolve();
    });
    proc.on('close', () => resolve());
    proc.stdin.on('error', reject);
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

function openInDefaultApp(target) {
  spawn('open', [target], { stdio: 'ignore', detached: true }).unref();
}

function summarizeSkipped(skipped) {
  if (!skipped || skipped.length === 0) return '';
  if (skipped.length > 8) {
    return `\n\n${skipped.length} files were skipped — see log for details.`;
  }
  const lines = skipped.map((s) => {
    const path = s.sourcePath || s.localPath || s.key || '(unknown)';
    const reason = (s.reason || '').replace(/\s+/g, ' ').slice(0, 80);
    const base = path.split('/').pop();
    return `  • ${base}: ${reason}`;
  });
  return `\n\n${skipped.length} file${skipped.length === 1 ? '' : 's'} skipped:\n${lines.join('\n')}`;
}

export async function showSuccess({ url, fileCount, skipped = [] }) {
  await pbcopy(url);

  const noun = fileCount === 1 ? 'file' : 'files';
  const body = `${url}\n\n${fileCount} ${noun} uploaded.${summarizeSkipped(skipped)}`;
  const script =
    `set theResult to display dialog "${escapeAppleScript(body)}" ` +
    `buttons {"Open in Browser", "Copy", "OK"} ` +
    `default button "OK" ` +
    `with title "DropGallery"\n` +
    `return button returned of theResult`;

  let choice = 'OK';
  try {
    choice = await runOsascript(script);
  } catch (_e) { /* dialog dismissal — treat as OK */ }

  if (choice === 'Open in Browser') {
    openInDefaultApp(url);
  } else if (choice === 'Copy') {
    await pbcopy(url);
  }
}

export async function showError({ message, logPath }) {
  const safeMsg = message || 'DropGallery failed.';
  const buttons = logPath
    ? `{"Show Log", "OK"}`
    : `{"OK"}`;
  const defaultBtn = `default button "OK"`;
  const script =
    `set theResult to display alert "DropGallery failed" ` +
    `message "${escapeAppleScript(safeMsg)}" ` +
    `as critical ` +
    `buttons ${buttons} ` +
    `${defaultBtn}\n` +
    `return button returned of theResult`;

  let choice = 'OK';
  try {
    choice = await runOsascript(script);
  } catch (_e) { /* dismissed — treat as OK */ }

  if (choice === 'Show Log' && logPath) {
    openInDefaultApp(logPath);
  }
}
