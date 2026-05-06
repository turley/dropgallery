import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as ini from 'ini';
import envPaths from 'env-paths';

const REQUIRED_KEYS = ['AWS_PROFILE', 'AWS_REGION', 'S3_BUCKET', 'CLOUDFRONT_DOMAIN'];

// Per-OS config location: ~/Library/Preferences/dropgallery/galleryrc on
// macOS, ~/.config/dropgallery/galleryrc on Linux, equivalent under
// %APPDATA% on Windows. `suffix: ''` drops the default `-nodejs`.
export const CONFIG_DIR = envPaths('dropgallery', { suffix: '' }).config;
export const CONFIG_PATH = join(CONFIG_DIR, 'galleryrc');

// Optional dotfile alternative; takes priority if it exists.
export const HOME_CONFIG_PATH = join(homedir(), '.galleryrc');

export function configLookupPath() {
  if (existsSync(HOME_CONFIG_PATH)) return HOME_CONFIG_PATH;
  return CONFIG_PATH;
}

// Returns { name -> { KEY: 'value', ... } }. The legacy flat format
// (top-level KEY=value pairs, no [sections]) is wrapped as [default].
function parseConfigFile(raw) {
  const parsed = ini.parse(raw);
  const sections = {};
  const flatKeys = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      sections[key] = value;
    } else {
      flatKeys[key] = value;
    }
  }

  if (Object.keys(sections).length === 0 && Object.keys(flatKeys).length > 0) {
    return { default: flatKeys };
  }
  // Sectioned format; stray top-level keys (which a setup-generated file
  // shouldn't have) are dropped.
  return sections;
}

function validateDestination(name, dest, sourcePath) {
  const missing = REQUIRED_KEYS.filter((k) => !dest[k] || !String(dest[k]).trim());
  if (missing.length > 0) {
    throw new Error(
      `Destination "${name}" in ${sourcePath} is missing required keys: ${missing.join(', ')}. ` +
      `Run \`dropgallery --setup --as ${name}\` to (re)create it.`
    );
  }
  return {
    awsProfile: String(dest.AWS_PROFILE).trim(),
    awsRegion: String(dest.AWS_REGION).trim(),
    s3Bucket: String(dest.S3_BUCKET).trim(),
    cloudfrontDomain: String(dest.CLOUDFRONT_DOMAIN).trim(),
  };
}

// Returns `{ destinations: { name -> {awsProfile,...} }, path }`. Throws on
// missing file or empty config.
export function loadConfigs() {
  const path = configLookupPath();

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `No config found at ${HOME_CONFIG_PATH} or ${CONFIG_PATH}. ` +
        `Run \`dropgallery --setup\` to create one.`
      );
    }
    throw err;
  }

  const sections = parseConfigFile(raw);
  const names = Object.keys(sections);
  if (names.length === 0) {
    throw new Error(
      `Config at ${path} has no destinations. Run \`dropgallery --setup\` to create one.`
    );
  }

  const destinations = {};
  for (const name of names) {
    destinations[name] = validateDestination(name, sections[name], path);
  }
  return { destinations, path };
}

// Returns the named destination, or — with no name — the only destination
// if exactly one is configured (otherwise throws).
export function loadConfig(name) {
  const { destinations, path } = loadConfigs();
  const names = Object.keys(destinations);

  if (name) {
    if (!destinations[name]) {
      throw new Error(
        `Destination "${name}" not found in ${path}. Available: ${names.join(', ')}`
      );
    }
    return destinations[name];
  }

  if (names.length === 1) return destinations[names[0]];

  throw new Error(
    `Multiple destinations configured in ${path} (${names.join(', ')}). ` +
    `Pass --target <name> or set DROPGALLERY_TARGET=<name>.`
  );
}
