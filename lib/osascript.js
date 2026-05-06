import { spawn } from 'node:child_process';

// Re-export so existing callers of `lib/osascript.js` keep working unchanged.
// The canonical home for CancelledError is now `lib/cancelled.js`.
export { CancelledError } from './cancelled.js';

export function escapeAppleScript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function runOsascript(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', ['-e', script]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.replace(/\n$/, ''));
      } else {
        const err = new Error(stderr.trim() || `osascript exited ${code}`);
        err.code = code;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}
