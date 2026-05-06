import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderGallery } from '../lib/render.js';
import { makeTmpDir, cleanup } from '../fixtures.js';

const tmpDirs = [];
after(() => { for (const d of tmpDirs) cleanup(d); });

function freshTmpDir() {
  const d = makeTmpDir('dropgallery-render-');
  tmpDirs.push(d);
  return d;
}

const sampleItems = () => ([
  { kind: 'image', stem: 'photo', finalName: 'photo.jpg', width: 800, height: 600 },
  { kind: 'video', stem: 'clip',  finalName: 'clip.mp4',  width: 1920, height: 1080 },
]);

test('renders index.html with gallery id base href, tiles, and copies photoswipe assets', async () => {
  const out = freshTmpDir();
  const galleryId = 'abc_DEF-123';
  await renderGallery({ galleryId, title: 'My Trip', items: sampleItems(), outputDir: out });

  const html = readFileSync(join(out, 'index.html'), 'utf8');

  assert.match(html, new RegExp(`<base href="${galleryId}/">`));
  assert.match(html, /<h1>My Trip<\/h1>/);
  assert.match(html, /<title>My Trip<\/title>/);

  // Image tile
  assert.match(html, /<a class="tile" href="images\/photo\.jpg" data-pswp-width="800" data-pswp-height="600">/);
  assert.match(html, /thumbnails\/photo\.jpg/);

  // Video tile carries the type and is-video class
  assert.match(html, /<a class="tile is-video" href="images\/clip\.mp4" data-pswp-type="video" data-pswp-width="1920" data-pswp-height="1080">/);

  // Vendored photoswipe assets copied
  for (const f of [
    'photoswipe.css',
    'photoswipe.esm.min.js',
    'photoswipe-lightbox.esm.min.js',
    'LICENSE',
  ]) {
    assert.ok(existsSync(join(out, 'photoswipe', f)), `missing photoswipe/${f}`);
  }
});

test('escapes HTML in titles', async () => {
  const out = freshTmpDir();
  await renderGallery({
    galleryId: 'id',
    title: '<script>alert(1)</script>',
    items: sampleItems(),
    outputDir: out,
  });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw <script> leaked into output');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('empty title omits the heading and uses a default <title>', async () => {
  const out = freshTmpDir();
  await renderGallery({ galleryId: 'id', title: '', items: sampleItems(), outputDir: out });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(!/<h1>/.test(html), 'expected no <h1> when title is empty');
  assert.match(html, /<title>Gallery<\/title>/);
});

test('whitespace-only title is treated as empty', async () => {
  const out = freshTmpDir();
  await renderGallery({ galleryId: 'id', title: '   ', items: sampleItems(), outputDir: out });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(!/<h1>/.test(html));
  assert.match(html, /<title>Gallery<\/title>/);
});

test('encodes filename characters that are URL-unsafe', async () => {
  const out = freshTmpDir();
  await renderGallery({
    galleryId: 'id',
    title: '',
    items: [{ kind: 'image', stem: 'a b', finalName: 'a b.jpg', width: 10, height: 10 }],
    outputDir: out,
  });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(html, /href="images\/a%20b\.jpg"/);
  assert.match(html, /src="thumbnails\/a%20b\.jpg"/);
});
