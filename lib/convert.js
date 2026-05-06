import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, extname, join, parse as parsePath } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

const HEIC_LIKE = new Set(['.heic', '.heif', '.avif']);
const PASSTHROUGH_IMAGE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const PASSTHROUGH_VIDEO = new Set(['.mp4', '.mov']);

// Union of every extension we know how to put in a gallery. Exposed so
// gallery.js can decide which files to pull in when the user passes a
// directory rather than individual file paths.
export const SUPPORTED_EXTENSIONS = new Set([
  ...HEIC_LIKE, ...PASSTHROUGH_IMAGE, ...PASSTHROUGH_VIDEO,
]);

export function isSupportedFile(path) {
  return SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase());
}

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

const VIDEO_DIM_FALLBACK = { width: 1280, height: 720 };

// Post-rotation dims. Orientation 5–8 are 90/270° rotations, so swap w/h.
async function getImageDims(path) {
  const meta = await sharp(path).metadata();
  const rotated = meta.orientation && meta.orientation >= 5 && meta.orientation <= 8;
  return {
    width: rotated ? meta.height : meta.width,
    height: rotated ? meta.width : meta.height,
  };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

// Codec name (e.g. 'h264', 'hevc', 'av1') or null if ffprobe fails.
function getVideoCodec(path) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      path,
    ]);
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

// Re-mux without re-encoding for already-compatible (H.264) sources.
// faststart moves the moov atom to the front so Firefox can seek; the
// stream maps strip iPhone metadata tracks; `?` on audio allows silent video.
function remuxFaststart(sourcePath, outputPath) {
  return runFfmpeg([
    '-loglevel', 'error',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', outputPath,
  ]);
}

// Transcode to H.264 + AAC for codecs Firefox can't seek (e.g. iPhone HEVC
// Main 10). CRF 23 is libx264's visually-lossless default; yuv420p forces
// 8-bit chroma so the result decodes everywhere.
function transcodeToH264(sourcePath, outputPath) {
  return runFfmpeg([
    '-loglevel', 'error',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-y', outputPath,
  ]);
}

// Codecs that won't seek reliably across browsers even with a clean container.
const TRANSCODE_CODECS = new Set(['hevc', 'h265', 'av1']);

// Returns a fallback dim when ffprobe is unavailable — the lightbox aspect is
// wrong but the gallery still works.
function getVideoDims(path) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      path,
    ]);
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve(VIDEO_DIM_FALLBACK));
    proc.on('close', (code) => {
      if (code !== 0) return resolve(VIDEO_DIM_FALLBACK);
      const [w, h] = out.trim().split(',').map((s) => parseInt(s, 10));
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        resolve({ width: w, height: h });
      } else {
        resolve(VIDEO_DIM_FALLBACK);
      }
    });
  });
}

function uniqueName(takenNames, takenStems, desiredName) {
  // Dedupe by stem AND filename: thumbnails are <stem>.jpg regardless of
  // source extension, so e.g. photo.jpg + photo.png would clobber each other.
  const { name, ext } = parsePath(desiredName);
  if (!takenNames.has(desiredName) && !takenStems.has(name)) {
    takenNames.add(desiredName);
    takenStems.add(name);
    return desiredName;
  }
  let n = 2;
  while (takenNames.has(`${name}-${n}${ext}`) || takenStems.has(`${name}-${n}`)) n++;
  const finalName = `${name}-${n}${ext}`;
  takenNames.add(finalName);
  takenStems.add(`${name}-${n}`);
  return finalName;
}

export async function convertFiles(inputPaths, imagesDir, { hasFfmpeg = false } = {}) {
  await mkdir(imagesDir, { recursive: true });

  const taken = new Set();
  const takenStems = new Set();
  const converted = [];
  const failed = [];

  for (const sourcePath of inputPaths) {
    const ext = extname(sourcePath).toLowerCase();
    const baseName = basename(sourcePath);
    const stem = parsePath(baseName).name;

    try {
      if (HEIC_LIKE.has(ext)) {
        const finalName = uniqueName(taken, takenStems, `${stem}.jpg`);
        const outputPath = join(imagesDir, finalName);
        // toFile() already returns post-rotation dims.
        const info = await sharp(sourcePath)
          .rotate()
          .jpeg({ quality: 92 })
          .toFile(outputPath);
        converted.push({
          sourcePath,
          outputPath,
          finalName,
          stem: parsePath(finalName).name,
          mimeType: 'image/jpeg',
          kind: 'image',
          width: info.width,
          height: info.height,
        });
      } else if (PASSTHROUGH_IMAGE.has(ext)) {
        const finalName = uniqueName(taken, takenStems, baseName);
        const outputPath = join(imagesDir, finalName);

        let dims;
        if (ext === '.gif') {
          // Byte-copy to preserve animation. GIFs don't carry EXIF
          // orientation, so the dims here match what the browser renders.
          await pipeline(createReadStream(sourcePath), createWriteStream(outputPath));
          dims = await getImageDims(outputPath);
        } else {
          // Re-encode through sharp.rotate() to bake EXIF orientation into
          // pixels. Without this, Safari measures the image at its
          // pre-rotation size while PhotoSwipe sets explicit width/height
          // from dataSource dims, and the mismatch stretches the image.
          let pipe = sharp(sourcePath).rotate();
          if (ext === '.jpg' || ext === '.jpeg') pipe = pipe.jpeg({ quality: 92 });
          else if (ext === '.png') pipe = pipe.png();
          else if (ext === '.webp') pipe = pipe.webp({ quality: 92 });
          const info = await pipe.toFile(outputPath);
          dims = { width: info.width, height: info.height };
        }

        converted.push({
          sourcePath,
          outputPath,
          finalName,
          stem: parsePath(finalName).name,
          mimeType: MIME[ext],
          kind: 'image',
          width: dims.width,
          height: dims.height,
        });
      } else if (PASSTHROUGH_VIDEO.has(ext)) {
        // ffmpeg + HEVC/AV1 → transcode to H.264 .mp4 (only way Firefox can
        //   both play and seek).
        // ffmpeg + compatible codec → faststart remux, no re-encode.
        // no ffmpeg → byte-copy. Safari/Chrome play it; Firefox seek may
        //   misbehave (moov-at-end + HEVC).
        let outputPath;
        let finalName;
        let outputMime;

        if (hasFfmpeg) {
          const codec = (await getVideoCodec(sourcePath) || '').toLowerCase();
          const needsTranscode = TRANSCODE_CODECS.has(codec);

          try {
            if (needsTranscode) {
              finalName = uniqueName(taken, takenStems, `${stem}.mp4`);
              outputPath = join(imagesDir, finalName);
              await transcodeToH264(sourcePath, outputPath);
              outputMime = 'video/mp4';
            } else {
              finalName = uniqueName(taken, takenStems, baseName);
              outputPath = join(imagesDir, finalName);
              await remuxFaststart(sourcePath, outputPath);
              outputMime = MIME[ext];
            }
          } catch (_e) {
            // ffmpeg failed — fall back to a byte copy so the user at least
            // gets the file (with original extension/mime).
            finalName = uniqueName(taken, takenStems, baseName);
            outputPath = join(imagesDir, finalName);
            await pipeline(createReadStream(sourcePath), createWriteStream(outputPath));
            outputMime = MIME[ext];
          }
        } else {
          finalName = uniqueName(taken, takenStems, baseName);
          outputPath = join(imagesDir, finalName);
          await pipeline(createReadStream(sourcePath), createWriteStream(outputPath));
          outputMime = MIME[ext];
        }

        const dims = await getVideoDims(outputPath);
        converted.push({
          sourcePath,
          outputPath,
          finalName,
          stem: parsePath(finalName).name,
          mimeType: outputMime,
          kind: 'video',
          width: dims.width,
          height: dims.height,
        });
      } else {
        failed.push({ sourcePath, reason: `Unsupported format: ${ext || '(no extension)'}` });
      }
    } catch (err) {
      failed.push({ sourcePath, reason: err.message });
    }
  }

  return { converted, failed };
}
