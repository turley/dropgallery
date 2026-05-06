import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import envPaths from 'env-paths';

// Per-OS log location: ~/Library/Logs/dropgallery on macOS,
// ~/.local/share/dropgallery/log on Linux, %LOCALAPPDATA%/dropgallery/Log on
// Windows. `suffix: ''` drops env-paths' default `-nodejs` suffix.
const LOG_DIR = envPaths('dropgallery', { suffix: '' }).log;

function timestampFilename() {
  const now = new Date();
  const iso = now.toISOString();
  return iso.replace(/:/g, '-').replace(/\.\d+Z$/, 'Z') + '.log';
}

function fmt(level, message, details) {
  const ts = new Date().toISOString();
  let line = `[${ts}] ${level.padEnd(5)} ${message}`;
  if (details !== undefined) {
    if (details instanceof Error) {
      line += `\n  ${details.stack || details.message}`;
    } else if (typeof details === 'object') {
      try { line += `\n  ${JSON.stringify(details)}`; } catch { line += `\n  ${String(details)}`; }
    } else {
      line += `\n  ${String(details)}`;
    }
  }
  return line + '\n';
}

export function createLogger() {
  let path = null;
  let fd = null;
  let writeFn = (line) => {
    process.stderr.write(line);
  };

  try {
    mkdirSync(LOG_DIR, { recursive: true });
    path = join(LOG_DIR, timestampFilename());
    fd = openSync(path, 'a');
    writeFn = (line) => {
      try { writeSync(fd, line); } catch { /* swallow */ }
    };
  } catch (err) {
    process.stderr.write(`dropgallery: cannot open log file: ${err.message}\n`);
  }

  return {
    path,
    info(message, details) { writeFn(fmt('INFO', message, details)); },
    warn(message, details) { writeFn(fmt('WARN', message, details)); },
    error(message, details) { writeFn(fmt('ERROR', message, details)); },
    close() {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* swallow */ }
        fd = null;
      }
    },
  };
}
