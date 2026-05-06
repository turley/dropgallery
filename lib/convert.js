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

// Read post-rotation visual dimensions from an image. sharp.metadata() returns
// the file's stored width/height; if EXIF orientation is 5-8 (rotated 90/270)
// we swap so PhotoSwipe gets the dimensions a browser actually renders.
async function getImageDims(path) {
  const meta = await sharp(path).metadata();
  const rotated = meta.orientation && meta.orientation >= 5 && meta.orientation <= 8;
  return {
    width: rotated ? meta.height : meta.width,
    height: rotated ? meta.width : meta.height,
  };
}

// Spawn ffmpeg with the given args; resolve on exit 0, reject otherwise.
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

// Probe the video stream's codec (e.g. 'h264', 'hevc', 'av1') so we can
// decide whether plain remux is enough or we need to transcode for browser
// compat. Returns null if ffprobe fails. Uses `default=nk=1:nw=1` to print
// just the codec name with no trailing field separator (csv=p=0 leaves a
// stray trailing comma when one field is requested).
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

// Re-mux a video without re-encoding. Used when the source codec is already
// H.264 (which every modern browser plays). `-c copy` = no re-encoding;
// `-movflags +faststart` puts the moov index atom at the START of the file
// so Firefox can seek (camera-recorded files put it at the end, breaking
// Firefox scrubbing); stream maps drop iPhone-style metadata/timecode tracks
// that confuse some players. `?` on the audio map makes it optional for
// silent videos.
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

// Transcode HEVC (or other browser-unfriendly codecs) to H.264 + AAC in an
// MP4 container. iPhone records HEVC Main 10 (10-bit) which Firefox can't
// reliably seek even with faststart. CRF 23 is libx264's near-lossless
// default; -preset medium balances speed and size. yuv420p forces 8-bit
// chroma so the output decodes everywhere. Faststart is included so the
// moov atom lands at the start.
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

// Codecs that need transcoding because their cross-browser support is
// uneven enough that even a clean container won't make them seek reliably.
const TRANSCODE_CODECS = new Set(['hevc', 'h265', 'av1']);

// Probe video dimensions via ffprobe (ships with ffmpeg). Returns a sane
// fallback when ffprobe is missing or the video has no readable video stream
// — the lightbox aspect will be wrong in that case but the gallery still works.
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
  // We must dedupe BOTH the final filename AND the stem, since thumbnails
  // are stored as `<stem>.jpg` regardless of source extension. Two inputs
  // sharing a stem (e.g. photo.jpg + photo.png, or photo.heic + photo.jpg
  // after HEIC→JPEG conversion) would otherwise overwrite each other's
  // thumbnail and produce duplicate tiles in the gallery.
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
        // sharp's .toFile() returns post-rotation dims directly — no need to
        // re-read metadata.
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
          // Byte-copy GIFs to preserve animation; in practice GIFs don't
          // carry EXIF orientation, so the dims we read here match what
          // browsers render.
          await pipeline(createReadStream(sourcePath), createWriteStream(outputPath));
          dims = await getImageDims(outputPath);
        } else {
          // JPEG / PNG / WebP get re-encoded through sharp.rotate() so EXIF
          // orientation is baked into pixels and the orientation tag is
          // dropped. Without this, Safari (and others) honor EXIF orientation
          // when measuring the image's intrinsic size, but PhotoSwipe sets
          // explicit `<img width=N height=M>` attributes from our dataSource
          // dims — the mismatch makes the browser stretch the image to fit
          // those attributes. JPEG re-encode at q=92 (matching the HEIC path)
          // is visually lossless; PNG is lossless.
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
        // Three-tier strategy:
        //   1. ffmpeg + HEVC/AV1 source → transcode to H.264 in MP4 (renames
        //      the file extension to .mp4). Slow but only path that gives
        //      Firefox a video it can both play AND seek.
        //   2. ffmpeg + already-compatible source → faststart remux, no
        //      re-encoding. Keeps the original extension and codec.
        //   3. no ffmpeg → plain byte-for-byte stream-copy. Safari/Chrome
        //      will play it; Firefox seek may misbehave (camera files have
        //      moov at the end, plus HEVC issues).
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
            // ffmpeg failed — fall back to byte-for-byte copy so the user at
            // least gets the file. Use the original extension/mime.
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
