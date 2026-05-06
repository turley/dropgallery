#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pre-parse flags out of argv. --setup launches the interactive wizard;
// --cli forces the terminal UI on macOS. Both are consumed here before
// anything else looks at argv. The wizard is always run in CLI mode (no
// macOS GUI dialogs for a multi-step setup flow), so --setup also implies
// --cli's effect.
const setupFlagIndex = process.argv.indexOf('--setup');
const isSetup = setupFlagIndex !== -1;
if (isSetup) {
  process.env.DROPGALLERY_UI = 'cli';
  process.argv.splice(setupFlagIndex, 1);
}
const cliFlagIndex = process.argv.indexOf('--cli');
if (cliFlagIndex !== -1) {
  process.env.DROPGALLERY_UI = 'cli';
  process.argv.splice(cliFlagIndex, 1);
}

if (isSetup) {
  const { runSetup } = await import('./lib/setup.js');
  await runSetup();
  process.exit(0);
}

import { loadConfig } from './lib/config.js';
import * as ui from './lib/ui.js';
import { generateGalleryId } from './lib/ids.js';
import { detectFfmpeg, generateThumbnails } from './lib/thumbnails.js';
import { convertFiles, isSupportedFile } from './lib/convert.js';
import { renderGallery } from './lib/render.js';
import { uploadGallery } from './lib/upload.js';
import { createLogger } from './lib/log.js';

// Recursively collect supported image/video files inside a directory.
// Skips entries whose name starts with `.` (e.g. .DS_Store, .git) and skips
// symlinks to avoid loops. Returns paths sorted alphabetically so the gallery
// order within a folder is predictable.
function walkDir(dir, log) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    log.warn('skipping unreadable directory', { dir, error: err.message });
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkDir(full, log));
    } else if (entry.isFile() && isSupportedFile(full)) {
      out.push(full);
    }
    // ignore symlinks and other entry types
  }
  return out.sort();
}

function validatePaths(paths, log) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  const add = (p) => { if (!seen.has(p)) { seen.add(p); valid.push(p); } };

  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch (err) {
      invalid.push({ sourcePath: p, reason: `Cannot read: ${err.code || err.message}` });
      log.warn(`Skipping unreadable input`, { path: p, error: err.message });
      continue;
    }

    if (st.isDirectory()) {
      const expanded = walkDir(p, log);
      log.info('expanded directory', { dir: p, files: expanded.length });
      if (expanded.length === 0) {
        invalid.push({ sourcePath: p, reason: 'No supported image or video files in directory' });
      }
      for (const f of expanded) add(f);
    } else if (st.isFile()) {
      add(p);
    } else {
      invalid.push({ sourcePath: p, reason: 'Not a regular file or directory' });
    }
  }

  return { valid, invalid };
}

async function main() {
  const log = createLogger();
  const startedAt = Date.now();
  let stagingDir = null;

  try {
    log.info('dropgallery starting', { argv: process.argv.slice(2) });

    const inputs = process.argv.slice(2);
    if (inputs.length === 0) {
      const msg = 'No files provided. Usage: gallery.js <file> [<file> ...]';
      log.error(msg);
      await ui.error({ message: msg, logPath: log.path });
      process.exitCode = 1;
      return;
    }

    const config = loadConfig();
    log.info('config loaded', {
      profile: config.awsProfile,
      region: config.awsRegion,
      bucket: config.s3Bucket,
      cloudfrontDomain: config.cloudfrontDomain,
    });

    const { valid, invalid } = validatePaths(inputs, log);
    if (valid.length === 0) {
      const msg = 'No supported image or video files found.';
      log.error(msg, { invalid });
      await ui.error({ message: msg, logPath: log.path });
      process.exitCode = 1;
      return;
    }

    const noun = valid.length === 1 ? 'file' : 'files';
    await ui.confirm({ message: `Make gallery from ${valid.length} ${noun}?` });
    const title = await ui.askText({ message: 'Title for gallery (optional):' });
    const expireDays = await ui.choose({
      message: 'Expire gallery after:',
      choices: [
        { label: '1 day', value: 1 },
        { label: '7 days', value: 7 },
        { label: '30 days', value: 30 },
        { label: 'Never', value: null },
      ],
    });
    log.info('user choices', { title: title || '(none)', expireDays: expireDays ?? 'never' });

    // Fire the new "work has begun" cue so the user isn't staring at silence
    // for 30+ seconds. macOS: a Notification Center toast. CLI: ora spinner.
    await ui.notifyStart({ message: `Uploading ${valid.length} ${noun}…` });

    const galleryId = generateGalleryId();
    log.info('gallery id', { galleryId });

    const hasFfmpeg = await detectFfmpeg();
    log.info('ffmpeg', { detected: hasFfmpeg });

    stagingDir = mkdtempSync(join(tmpdir(), `dropgallery-${galleryId}-`));
    log.info('staging dir', { path: stagingDir });

    const imagesDir = join(stagingDir, 'images');
    const thumbsDir = join(stagingDir, 'thumbnails');

    log.info('converting files', { count: valid.length });
    const conv = await convertFiles(valid, imagesDir, { hasFfmpeg });
    log.info('convert done', { ok: conv.converted.length, failed: conv.failed.length });

    if (conv.converted.length === 0) {
      const msg = 'No files could be converted. See log for details.';
      log.error(msg, { failed: [...invalid, ...conv.failed] });
      await ui.error({ message: msg, logPath: log.path });
      process.exitCode = 1;
      return;
    }

    log.info('generating thumbnails');
    const thumb = await generateThumbnails(conv.converted, thumbsDir, hasFfmpeg);
    log.info('thumbnail done', { ok: thumb.thumbs.length, failed: thumb.failed.length });

    if (thumb.thumbs.length === 0) {
      const msg = 'All thumbnails failed. See log for details.';
      log.error(msg, { failed: [...invalid, ...conv.failed, ...thumb.failed] });
      await ui.error({ message: msg, logPath: log.path });
      process.exitCode = 1;
      return;
    }

    log.info('rendering gallery');
    await renderGallery({ galleryId, title, items: thumb.thumbs, outputDir: stagingDir });

    log.info('uploading to s3', { bucket: config.s3Bucket, expireDays });
    const up = await uploadGallery({
      galleryId,
      stagingDir,
      expireDays,
      config,
    });
    log.info('upload done', { uploaded: up.uploaded.length, failed: up.failed.length });

    if (!up.indexUploaded) {
      const msg = 'Gallery index.html failed to upload. See log for details.';
      log.error(msg, { failed: up.failed });
      await ui.error({ message: msg, logPath: log.path });
      process.exitCode = 1;
      return;
    }

    const skipped = [
      ...invalid,
      ...conv.failed,
      ...thumb.failed,
      ...up.failed.map((f) => ({ sourcePath: f.localPath || f.key, reason: f.reason })),
    ];

    const elapsedMs = Date.now() - startedAt;
    log.info('success', { url: up.url, fileCount: thumb.thumbs.length, skipped: skipped.length, elapsedMs });

    await ui.success({
      url: up.url,
      fileCount: thumb.thumbs.length,
      skipped,
    });
  } catch (err) {
    if (err instanceof ui.CancelledError) {
      log.info('user cancelled', { stage: err.stage });
      log.close();
      return;
    }
    log.error('fatal', err);
    try {
      await ui.error({ message: err.message || 'Unknown error', logPath: log.path });
    } catch (_e) { /* ignore */ }
    process.exitCode = 1;
  } finally {
    if (stagingDir) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
    log.close();
  }
}

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`unhandledRejection: ${reason && reason.stack || reason}\n`);
  process.exitCode = 1;
});

main();
