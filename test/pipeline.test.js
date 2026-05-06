// End-to-end: convertFiles → generateThumbnails → renderGallery, on synthetic
// images built with sharp at test time. The point is to catch sharp / pipeline
// regressions on dep bumps. HEIC and ffmpeg-driven video paths are skipped —
// they need real fixtures and platform tools.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { convertFiles, isSupportedFile } from '../lib/convert.js';
import { generateThumbnails } from '../lib/thumbnails.js';
import { renderGallery } from '../lib/render.js';
import { makeTmpDir, cleanup, writeJpeg, writePng, writeWebp } from '../fixtures.js';

const tmpDirs = [];
after(() => { for (const d of tmpDirs) cleanup(d); });

function freshTmpDir(prefix) {
  const d = makeTmpDir(prefix);
  tmpDirs.push(d);
  return d;
}

test('isSupportedFile recognizes the documented extensions', () => {
  for (const p of ['x.jpg', 'x.JPG', 'x.jpeg', 'x.png', 'x.webp', 'x.gif', 'x.heic', 'x.heif', 'x.avif', 'x.mp4', 'x.mov', 'x.MOV']) {
    assert.ok(isSupportedFile(p), `expected ${p} to be supported`);
  }
  for (const p of ['x.txt', 'x.bmp', 'x.tiff', 'x.mkv', 'x']) {
    assert.ok(!isSupportedFile(p), `expected ${p} to be unsupported`);
  }
});

test('convertFiles → generateThumbnails → renderGallery on synthetic images', async () => {
  const inputDir = freshTmpDir('dropgallery-pipeline-in-');
  const stagingDir = freshTmpDir('dropgallery-pipeline-out-');
  const imagesDir = join(stagingDir, 'images');
  const thumbsDir = join(stagingDir, 'thumbnails');

  const jpgPath = await writeJpeg(join(inputDir, 'one.jpg'),  { width: 80,  height: 60 });
  const pngPath = await writePng(join(inputDir, 'two.png'),   { width: 50,  height: 100 });
  const webpPath = await writeWebp(join(inputDir, 'three.webp'), { width: 200, height: 150 });

  // Convert
  const conv = await convertFiles([jpgPath, pngPath, webpPath], imagesDir);
  assert.equal(conv.failed.length, 0, `convert failures: ${JSON.stringify(conv.failed)}`);
  assert.equal(conv.converted.length, 3);

  for (const item of conv.converted) {
    assert.equal(item.kind, 'image');
    assert.ok(existsSync(item.outputPath), `missing converted output ${item.outputPath}`);
    assert.ok(typeof item.width === 'number' && item.width > 0);
    assert.ok(typeof item.height === 'number' && item.height > 0);
    assert.ok(item.mimeType.startsWith('image/'));
  }

  const byName = Object.fromEntries(conv.converted.map((c) => [c.finalName, c]));
  assert.equal(byName['one.jpg'].width, 80);
  assert.equal(byName['one.jpg'].height, 60);
  assert.equal(byName['two.png'].width, 50);
  assert.equal(byName['two.png'].height, 100);

  // Thumbnails (no ffmpeg path needed for images)
  const thumb = await generateThumbnails(conv.converted, thumbsDir, false);
  assert.equal(thumb.failed.length, 0, `thumb failures: ${JSON.stringify(thumb.failed)}`);
  assert.equal(thumb.thumbs.length, 3);
  for (const t of thumb.thumbs) {
    assert.ok(existsSync(t.thumbPath), `missing thumb ${t.thumbPath}`);
    assert.match(t.thumbPath, /\.jpg$/);
  }

  // Render — ensure the resulting HTML references each item's stem
  await renderGallery({ galleryId: 'pipeline_id_1', title: '', items: thumb.thumbs, outputDir: stagingDir });
  const html = readFileSync(join(stagingDir, 'index.html'), 'utf8');
  for (const item of thumb.thumbs) {
    assert.ok(html.includes(`images/${item.finalName}`), `index.html missing ${item.finalName}`);
    assert.ok(html.includes(`thumbnails/${item.stem}.jpg`), `index.html missing thumb for ${item.stem}`);
  }
});

test('convertFiles dedupes inputs that share a stem', async () => {
  const inputDir = freshTmpDir('dropgallery-pipeline-dedupe-in-');
  const imagesDir = join(freshTmpDir('dropgallery-pipeline-dedupe-out-'), 'images');

  const a1 = await writeJpeg(join(inputDir, 'a.jpg'));
  const a2 = await writePng(join(inputDir, 'a.png'));

  const conv = await convertFiles([a1, a2], imagesDir);
  assert.equal(conv.failed.length, 0);
  assert.equal(conv.converted.length, 2);

  const stems = conv.converted.map((c) => c.stem);
  assert.equal(new Set(stems).size, 2, `expected distinct stems, got ${JSON.stringify(stems)}`);
  // First file keeps its stem; second gets renamed (a → a-2).
  assert.equal(stems[0], 'a');
  assert.equal(stems[1], 'a-2');

  const finals = conv.converted.map((c) => c.finalName);
  assert.deepEqual(finals, ['a.jpg', 'a-2.png']);
});

test('convertFiles records unsupported-extension files in failed', async () => {
  const inputDir = freshTmpDir('dropgallery-pipeline-unsup-in-');
  const imagesDir = join(freshTmpDir('dropgallery-pipeline-unsup-out-'), 'images');
  const txt = join(inputDir, 'notes.txt');
  writeFileSync(txt, 'hello\n', 'utf8');

  const conv = await convertFiles([txt], imagesDir);
  assert.equal(conv.converted.length, 0);
  assert.equal(conv.failed.length, 1);
  assert.match(conv.failed[0].reason, /Unsupported format/);
});

test('generateThumbnails uses the placeholder for video items when ffmpeg is unavailable', async () => {
  const stagingDir = freshTmpDir('dropgallery-pipeline-vidthumb-');
  const imagesDir = join(stagingDir, 'images');
  const thumbsDir = join(stagingDir, 'thumbnails');
  await mkdir(imagesDir, { recursive: true });

  // Contents don't matter — hasFfmpeg=false short-circuits to the placeholder.
  const fakeVideo = join(imagesDir, 'fake.mp4');
  writeFileSync(fakeVideo, 'not really a video', 'utf8');

  const items = [{
    sourcePath: fakeVideo,
    outputPath: fakeVideo,
    finalName: 'fake.mp4',
    stem: 'fake',
    mimeType: 'video/mp4',
    kind: 'video',
    width: 1280,
    height: 720,
  }];

  const thumb = await generateThumbnails(items, thumbsDir, false);
  assert.equal(thumb.failed.length, 0);
  assert.equal(thumb.thumbs.length, 1);
  assert.ok(existsSync(thumb.thumbs[0].thumbPath));
});
