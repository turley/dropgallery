#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pre-parse flags out of argv. Recognised:
//   --help, -h         print usage to stdout and exit
//   --setup            launch the interactive wizard (always CLI-mode)
//   --as <name>        with --setup: which destination to add/replace
//   --cli              force the terminal UI on macOS
//   --target <name>    pick a specific destination (multi-destination configs)
// Anything else is treated as an input file/directory path.
function popFlag(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return false;
  process.argv.splice(i, 1);
  return true;
}
function popValueFlag(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  if (i === process.argv.length - 1) {
    process.stderr.write(`Error: ${name} requires a value.\n`);
    process.exit(2);
  }
  const value = process.argv[i + 1];
  process.argv.splice(i, 2);
  return value;
}

const HELP_TEXT = `DropGallery — turn images and videos into a shared static gallery.

Usage:
  dropgallery <file|dir> [<file|dir> ...]   Upload to a gallery and copy URL
  dropgallery --setup [--as <name>]         Run the interactive setup wizard

Options:
  --target <name>    Upload to a specific destination (multi-destination configs)
  --cli              Force terminal UI on macOS (default elsewhere)
  --setup            Run the interactive setup wizard
  --as <name>        With --setup: name of the destination to add/replace
  --help, -h         Show this help

Environment:
  DROPGALLERY_TARGET   Default destination name (overridden by --target)
  DROPGALLERY_UI=cli   Force terminal UI

Supported file types:
  Images: .jpg .jpeg .png .webp .gif .heic .heif .avif
  Videos: .mp4 .mov

See https://github.com/turley/dropgallery for setup, config, and Apple Shortcut docs.
`;

// Bail before any UI / config / SDK code loads, so this works without --cli.
if (popFlag('--help') || popFlag('-h')) {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
}

const isSetup = popFlag('--setup');
const setupAs = popValueFlag('--as');
const isCli = popFlag('--cli');
const targetFromFlag = popValueFlag('--target');

// --setup always runs in CLI mode (multi-step instructional flow doesn't
// suit native dialogs); --cli does the same on macOS.
if (isSetup || isCli) process.env.DROPGALLERY_UI = 'cli';

if (setupAs && !isSetup) {
  process.stderr.write('Error: --as requires --setup. Did you mean --target?\n');
  process.exit(2);
}
if (targetFromFlag && isSetup) {
  process.stderr.write('Error: --target cannot be used with --setup. Use --as <name>.\n');
  process.exit(2);
}

if (isSetup) {
  const { runSetup } = await import('./lib/setup.js');
  await runSetup({ targetName: setupAs });
  process.exit(0);
}

const requestedTargetName = targetFromFlag || process.env.DROPGALLERY_TARGET || null;

import { loadConfigs } from './lib/config.js';
import * as ui from './lib/ui.js';
import { generateGalleryId } from './lib/ids.js';
import { detectFfmpeg, generateThumbnails } from './lib/thumbnails.js';
import { convertFiles, isSupportedFile } from './lib/convert.js';
import { renderGallery } from './lib/render.js';
import { uploadGallery } from './lib/upload.js';
import { createLogger } from './lib/log.js';

// Skips dotfiles and symlinks; returns paths sorted for stable gallery order.
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
      const msg = 'No files provided. Usage: dropgallery <file|dir> [...]. Run --help for more.';
      log.error(msg);
      await ui.error({ message: msg, logPath: log.path });
      process.exitCode = 1;
      return;
    }

    const { destinations, path: configPath } = loadConfigs();
    const destinationNames = Object.keys(destinations);

    // Reject unknown --target / DROPGALLERY_TARGET before path validation.
    if (requestedTargetName && !destinations[requestedTargetName]) {
      const msg =
        `Destination "${requestedTargetName}" not found in ${configPath}. ` +
        `Available: ${destinationNames.join(', ')}`;
      log.error(msg);
      await ui.error({ message: msg, logPath: log.path });
      process.exitCode = 1;
      return;
    }

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

    // After the "do this at all?" confirm, but before title/expiration —
    // those prompts are wasted if the user backs out at the destination step.
    let chosenName;
    if (requestedTargetName) {
      chosenName = requestedTargetName;
    } else if (destinationNames.length === 1) {
      chosenName = destinationNames[0];
    } else {
      chosenName = await ui.choose({
        message: 'Upload to which destination?',
        choices: destinationNames.map((n) => ({ label: n, value: n })),
      });
    }

    const config = destinations[chosenName];
    log.info('config loaded', {
      destination: chosenName,
      profile: config.awsProfile,
      region: config.awsRegion,
      bucket: config.s3Bucket,
      cloudfrontDomain: config.cloudfrontDomain,
    });
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

    // "Work has begun" cue so the user isn't staring at silence for 30+ s.
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
