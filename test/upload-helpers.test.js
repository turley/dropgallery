import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentTypeFor,
  cacheControlFor,
  keyFor,
  withConcurrency,
} from '../lib/upload.js';

test('keyFor maps index.html to the bare g/<id> key', () => {
  assert.equal(keyFor('abc123', 'index.html'), 'g/abc123');
});

test('keyFor maps assets to nested g/<id>/<rel>', () => {
  assert.equal(keyFor('abc123', 'images/foo.jpg'), 'g/abc123/images/foo.jpg');
  assert.equal(keyFor('abc123', 'photoswipe/photoswipe.css'), 'g/abc123/photoswipe/photoswipe.css');
});

test('contentTypeFor maps known extensions and falls back for unknown', () => {
  assert.equal(contentTypeFor('foo.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('a/b/c.jpg'), 'image/jpeg');
  assert.equal(contentTypeFor('clip.mp4'), 'video/mp4');
  assert.equal(contentTypeFor('clip.mov'), 'video/quicktime');
  assert.equal(contentTypeFor('whatever.xyz'), 'application/octet-stream');
});

test('cacheControlFor returns no-cache for index.html, immutable otherwise', () => {
  assert.equal(cacheControlFor('staging/index.html'), 'no-cache');
  assert.equal(cacheControlFor('staging/images/a.jpg'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('staging/photoswipe/photoswipe.css'), 'public, max-age=31536000, immutable');
});

test('withConcurrency limits in-flight tasks to the given cap', async () => {
  const cap = 3;
  const limit = withConcurrency(cap);
  let active = 0;
  let peak = 0;

  const tasks = Array.from({ length: 20 }, (_, i) => limit(async () => {
    active++;
    if (active > peak) peak = active;
    // give the scheduler a chance to start more tasks
    await new Promise((r) => setImmediate(r));
    active--;
    return i;
  }));

  const results = await Promise.all(tasks);
  assert.deepEqual(results, Array.from({ length: 20 }, (_, i) => i));
  assert.ok(peak <= cap, `peak ${peak} exceeded cap ${cap}`);
  assert.ok(peak >= 1, 'expected at least one task to run');
});

test('withConcurrency propagates rejections', async () => {
  const limit = withConcurrency(2);
  await assert.rejects(limit(async () => { throw new Error('boom'); }), /boom/);
});
