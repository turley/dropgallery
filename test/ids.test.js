import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateGalleryId } from '../lib/ids.js';

test('generateGalleryId produces a 22-char URL-safe base64url string', () => {
  const id = generateGalleryId();
  assert.equal(typeof id, 'string');
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
});

test('generateGalleryId is unique across many calls', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(generateGalleryId());
  assert.equal(seen.size, 1000);
});
