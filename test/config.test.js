// lib/config.js computes its paths at module load via os.homedir() /
// env-paths, so HOME has to be redirected before that module evaluates.
// Static imports are hoisted, hence the dynamic import() further down.

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'dropgallery-config-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.XDG_CONFIG_HOME = join(TEST_HOME, '.config');
process.env.APPDATA = join(TEST_HOME, 'AppData', 'Roaming');

const {
  loadConfigs,
  loadConfig,
  CONFIG_PATH,
  HOME_CONFIG_PATH,
  configLookupPath,
} = await import('../lib/config.js');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* swallow */ }
});

function clearConfigs() {
  try { rmSync(HOME_CONFIG_PATH, { force: true }); } catch { /* swallow */ }
  try { rmSync(CONFIG_PATH, { force: true }); } catch { /* swallow */ }
}

function writeConfig(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

beforeEach(clearConfigs);

test('paths land inside the test HOME — sanity check', () => {
  assert.ok(HOME_CONFIG_PATH.startsWith(TEST_HOME), `HOME_CONFIG_PATH=${HOME_CONFIG_PATH}`);
  assert.ok(CONFIG_PATH.startsWith(TEST_HOME), `CONFIG_PATH=${CONFIG_PATH}`);
});

test('parses a sectioned config with multiple destinations', () => {
  writeConfig(CONFIG_PATH, [
    '[personal]',
    'AWS_PROFILE=p',
    'AWS_REGION=us-east-1',
    'S3_BUCKET=p-bucket',
    'CLOUDFRONT_DOMAIN=p.example.com',
    '',
    '[work]',
    'AWS_PROFILE=w',
    'AWS_REGION=us-west-2',
    'S3_BUCKET=w-bucket',
    'CLOUDFRONT_DOMAIN=w.example.com',
    '',
  ].join('\n'));

  const { destinations, path } = loadConfigs();
  assert.equal(path, CONFIG_PATH);
  assert.deepEqual(Object.keys(destinations).sort(), ['personal', 'work']);
  assert.deepEqual(destinations.personal, {
    awsProfile: 'p',
    awsRegion: 'us-east-1',
    s3Bucket: 'p-bucket',
    cloudfrontDomain: 'p.example.com',
  });
  assert.equal(destinations.work.awsRegion, 'us-west-2');
});

test('legacy flat config is wrapped as a single "default" destination', () => {
  writeConfig(CONFIG_PATH, [
    'AWS_PROFILE=legacy',
    'AWS_REGION=us-east-1',
    'S3_BUCKET=legacy-bucket',
    'CLOUDFRONT_DOMAIN=legacy.example.com',
  ].join('\n'));

  const { destinations } = loadConfigs();
  assert.deepEqual(Object.keys(destinations), ['default']);
  assert.equal(destinations.default.awsProfile, 'legacy');
  assert.equal(destinations.default.s3Bucket, 'legacy-bucket');
});

test('missing required keys throws an error naming the section and missing keys', () => {
  writeConfig(CONFIG_PATH, [
    '[broken]',
    'AWS_PROFILE=p',
    // no region, bucket, or domain
  ].join('\n'));

  assert.throws(() => loadConfigs(), (err) => {
    assert.match(err.message, /broken/);
    assert.match(err.message, /AWS_REGION/);
    assert.match(err.message, /S3_BUCKET/);
    assert.match(err.message, /CLOUDFRONT_DOMAIN/);
    return true;
  });
});

test('~/.galleryrc takes priority over the env-paths location', () => {
  writeConfig(HOME_CONFIG_PATH, [
    '[home]',
    'AWS_PROFILE=h',
    'AWS_REGION=us-east-1',
    'S3_BUCKET=h-bucket',
    'CLOUDFRONT_DOMAIN=h.example.com',
  ].join('\n'));
  writeConfig(CONFIG_PATH, [
    '[appdir]',
    'AWS_PROFILE=a',
    'AWS_REGION=us-east-1',
    'S3_BUCKET=a-bucket',
    'CLOUDFRONT_DOMAIN=a.example.com',
  ].join('\n'));

  assert.equal(configLookupPath(), HOME_CONFIG_PATH);
  const { destinations, path } = loadConfigs();
  assert.equal(path, HOME_CONFIG_PATH);
  assert.deepEqual(Object.keys(destinations), ['home']);
});

test('missing config file throws a friendly setup error', () => {
  assert.equal(existsSync(HOME_CONFIG_PATH), false);
  assert.equal(existsSync(CONFIG_PATH), false);

  assert.throws(() => loadConfigs(), (err) => {
    assert.match(err.message, /No config found/);
    assert.match(err.message, /dropgallery --setup/);
    return true;
  });
});

test('loadConfig() returns the only destination when there is exactly one', () => {
  writeConfig(CONFIG_PATH, [
    '[only]',
    'AWS_PROFILE=p',
    'AWS_REGION=us-east-1',
    'S3_BUCKET=b',
    'CLOUDFRONT_DOMAIN=d.example.com',
  ].join('\n'));

  const cfg = loadConfig();
  assert.equal(cfg.s3Bucket, 'b');
});

test('loadConfig() throws when ambiguous and no name is given', () => {
  writeConfig(CONFIG_PATH, [
    '[a]',
    'AWS_PROFILE=p', 'AWS_REGION=r', 'S3_BUCKET=b', 'CLOUDFRONT_DOMAIN=d.example.com',
    '[b]',
    'AWS_PROFILE=p', 'AWS_REGION=r', 'S3_BUCKET=b', 'CLOUDFRONT_DOMAIN=d.example.com',
  ].join('\n'));

  assert.throws(() => loadConfig(), /Multiple destinations/);
});

test('loadConfig(name) throws on unknown destination', () => {
  writeConfig(CONFIG_PATH, [
    '[a]',
    'AWS_PROFILE=p', 'AWS_REGION=r', 'S3_BUCKET=b', 'CLOUDFRONT_DOMAIN=d.example.com',
  ].join('\n'));

  assert.throws(() => loadConfig('does-not-exist'), /not found/);
});
