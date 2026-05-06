// Smoke tests for argv parsing and the early-exit gates. Spawns gallery.js
// with a sandboxed $HOME (so we don't touch the real ~/.galleryrc or log
// dir) and DROPGALLERY_UI=cli (so error paths don't pop the macOS dialog).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeTmpDir, cleanup } from '../fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GALLERY_JS = join(__dirname, '..', 'gallery.js');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) cleanup(d); });

function freshHome() {
  const d = makeTmpDir('dropgallery-cli-home-');
  tmpDirs.push(d);
  return d;
}

function runCli(args, { home = freshHome(), forceCli = true } = {}) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    // Make sure DROPGALLERY_TARGET isn't inherited from the dev's shell.
    DROPGALLERY_TARGET: '',
  };
  if (forceCli) env.DROPGALLERY_UI = 'cli';
  else delete env.DROPGALLERY_UI;

  const result = spawnSync(process.execPath, [GALLERY_JS, ...args], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  // Surface spawn failures (timeout, ENOENT) before they show up as a
  // confusing `null !== <code>` mismatch.
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('exits 1 with a Usage message when no files are provided', () => {
  const { code, stderr } = runCli([]);
  assert.equal(code, 1);
  assert.match(stderr, /No files provided/);
  assert.match(stderr, /Usage:/);
});

test('--as without --setup exits 2 with a helpful message', () => {
  const { code, stderr } = runCli(['--as', 'foo']);
  assert.equal(code, 2);
  assert.match(stderr, /--as requires --setup/);
});

test('--target combined with --setup exits 2', () => {
  const { code, stderr } = runCli(['--setup', '--target', 'foo']);
  assert.equal(code, 2);
  assert.match(stderr, /--target cannot be used with --setup/);
});

test('--target with no value exits 2', () => {
  const { code, stderr } = runCli(['--target']);
  assert.equal(code, 2);
  assert.match(stderr, /--target requires a value/);
});

test('--help prints usage to stdout and exits 0', () => {
  const { code, stdout, stderr } = runCli(['--help']);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /dropgallery <file\|dir>/);
  assert.match(stdout, /--target/);
  assert.match(stdout, /--setup/);
});

test('-h is an alias for --help', () => {
  const { code, stdout } = runCli(['-h']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
});

test('--help works without --cli and without a config file', () => {
  // No DROPGALLERY_UI=cli, no ~/.galleryrc — help must short-circuit before
  // any UI / config / SDK code loads, so even macOS exits cleanly here.
  const { code, stdout, stderr } = runCli(['--help'], { forceCli: false });
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Usage:/);
});

test('--help wins even when combined with other flags', () => {
  const { code, stdout } = runCli(['--setup', '--target', 'foo', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
});

test('--target naming a non-existent destination exits 1 before path validation', () => {
  const home = freshHome();
  // Single-destination config so the target check has something concrete
  // to reject against.
  writeFileSync(
    join(home, '.galleryrc'),
    [
      '[only]',
      'AWS_PROFILE=p',
      'AWS_REGION=us-east-1',
      'S3_BUCKET=b',
      'CLOUDFRONT_DOMAIN=d.example.com',
      '',
    ].join('\n'),
    'utf8',
  );

  const { code, stderr } = runCli(['--target', 'missing', 'irrelevant.jpg'], { home });
  assert.equal(code, 1);
  assert.match(stderr, /Destination "missing" not found/);
  assert.match(stderr, /Available:.*only/);
});
