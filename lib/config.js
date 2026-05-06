import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import envPaths from 'env-paths';

const REQUIRED_KEYS = ['AWS_PROFILE', 'AWS_REGION', 'S3_BUCKET', 'CLOUDFRONT_DOMAIN'];

// Per-OS config location (env-paths, no nodejs suffix to keep names tidy):
//   macOS:   ~/Library/Application Support/dropgallery/galleryrc
//   Linux:   ~/.config/dropgallery/galleryrc
//   Windows: %APPDATA%/dropgallery/Config/galleryrc
export const CONFIG_DIR = envPaths('dropgallery', { suffix: '' }).config;
export const CONFIG_PATH = join(CONFIG_DIR, 'galleryrc');

// Friendlier alternative for users who like keeping configs in their home
// directory. Checked first — `~/.galleryrc` wins if it exists, falls through
// to the env-paths location otherwise.
export const HOME_CONFIG_PATH = join(homedir(), '.galleryrc');

export function configLookupPath() {
  if (existsSync(HOME_CONFIG_PATH)) return HOME_CONFIG_PATH;
  return CONFIG_PATH;
}

export function loadConfig() {
  const path = configLookupPath();

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `No config found at ${HOME_CONFIG_PATH} or ${CONFIG_PATH}. ` +
        `Run \`gallery --setup\` to create one.`
      );
    }
    throw err;
  }

  const parsed = parse(raw);
  const missing = REQUIRED_KEYS.filter((k) => !parsed[k] || !parsed[k].trim());
  if (missing.length > 0) {
    throw new Error(
      `Config at ${path} is missing required keys: ${missing.join(', ')}. ` +
      `Run \`gallery --setup\` to (re)create it.`
    );
  }

  return {
    awsProfile: parsed.AWS_PROFILE.trim(),
    awsRegion: parsed.AWS_REGION.trim(),
    s3Bucket: parsed.S3_BUCKET.trim(),
    cloudfrontDomain: parsed.CLOUDFRONT_DOMAIN.trim(),
  };
}
