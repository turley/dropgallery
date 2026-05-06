import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = join(__dirname, '..', 'templates', 'placeholder-video.jpg');

const THUMB_MAX = 400;
const THUMB_QUALITY = 80;

export function detectFfmpeg() {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
    if (proc.stdout) proc.stdout.on('data', () => {});
    if (proc.stderr) proc.stderr.on('data', () => {});
  });
}

async function imageThumbnail(sourcePath, thumbPath) {
  await sharp(sourcePath)
    .rotate()
    .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY })
    .toFile(thumbPath);
}

function ffmpegPosterBuffer(videoPath) {
  return new Promise((resolve, reject) => {
    // -ss before -i: fast input seek. -frames:v 1: one frame.
    // Output as MJPEG to stdout so we can pipe directly to sharp.
    const args = [
      '-loglevel', 'error',
      '-ss', '00:00:01',
      '-i', videoPath,
      '-frames:v', '1',
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ];
    const proc = spawn('ffmpeg', args);
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(0, 200)}`));
      }
    });
  });
}

async function videoThumbnail(sourcePath, thumbPath) {
  // Try seek to 1s; on failure (e.g. video shorter than 1s), retry from 0s.
  let buf;
  try {
    buf = await ffmpegPosterBuffer(sourcePath);
  } catch (_e) {
    // fall through and retry with no seek
    buf = null;
  }
  if (!buf) {
    buf = await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-i', sourcePath,
        '-frames:v', '1',
        '-f', 'image2',
        '-vcodec', 'mjpeg',
        'pipe:1',
      ]);
      const chunks = [];
      let stderr = '';
      proc.stdout.on('data', (c) => chunks.push(c));
      proc.stderr.on('data', (c) => { stderr += c; });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(0, 200)}`));
      });
    });
  }

  await sharp(buf)
    .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY })
    .toFile(thumbPath);
}

async function placeholderThumbnail(thumbPath) {
  await copyFile(PLACEHOLDER, thumbPath);
}

export async function generateThumbnails(items, thumbsDir, hasFfmpeg) {
  await mkdir(thumbsDir, { recursive: true });

  // Each input slot maps to either a successful thumb or a failure record.
  // We must preserve input order in the `thumbs` output (PRD §5.1) — Promise.all
  // resolves results in input order, but if we pushed into a shared array from
  // inside the async callbacks the order would be completion-order, not input-order.
  const results = await Promise.all(items.map(async (item) => {
    const thumbPath = join(thumbsDir, `${item.stem}.jpg`);
    try {
      if (item.kind === 'image') {
        await imageThumbnail(item.outputPath, thumbPath);
      } else if (item.kind === 'video') {
        if (hasFfmpeg) {
          try {
            await videoThumbnail(item.outputPath, thumbPath);
          } catch (_e) {
            await placeholderThumbnail(thumbPath);
          }
        } else {
          await placeholderThumbnail(thumbPath);
        }
      } else {
        throw new Error(`Unknown kind: ${item.kind}`);
      }
      return { ok: true, value: { ...item, thumbPath } };
    } catch (err) {
      return { ok: false, value: { sourcePath: item.sourcePath, reason: `Thumbnail failed: ${err.message}` } };
    }
  }));

  const thumbs = [];
  const failed = [];
  for (const r of results) {
    if (r.ok) thumbs.push(r.value);
    else failed.push(r.value);
  }
  return { thumbs, failed };
}
