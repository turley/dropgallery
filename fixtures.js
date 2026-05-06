import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

export function makeTmpDir(prefix = 'dropgallery-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
}

function blank(width, height, channels = 3, color = { r: 200, g: 80, b: 80 }) {
  return sharp({ create: { width, height, channels, background: color } });
}

export async function writeJpeg(path, { width = 64, height = 48 } = {}) {
  await blank(width, height).jpeg({ quality: 90 }).toFile(path);
  return path;
}

export async function writePng(path, { width = 64, height = 48 } = {}) {
  await blank(width, height, 4, { r: 50, g: 150, b: 200, alpha: 1 }).png().toFile(path);
  return path;
}

export async function writeWebp(path, { width = 64, height = 48 } = {}) {
  await blank(width, height).webp({ quality: 90 }).toFile(path);
  return path;
}
