import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { fromIni } from '@aws-sdk/credential-providers';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

export function contentTypeFor(localPath) {
  const ext = extname(localPath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

export function cacheControlFor(localPath) {
  return localPath.endsWith('index.html') ? NO_CACHE : IMMUTABLE;
}

// Map a local file path under stagingDir to its S3 key. The index.html lands
// at the bare `g/<id>` key (no extension, no trailing slash) so it serves
// directly when a viewer hits https://<cf>/g/<id>; everything else lives at
// `g/<id>/<rel>` as siblings under that prefix. The renderer uses
// <base href="<id>/"> so the HTML's relative paths still resolve correctly.
export function keyFor(galleryId, rel) {
  if (rel === 'index.html') return `g/${galleryId}`;
  return `g/${galleryId}/${rel}`;
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

export function withConcurrency(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (queue.length === 0 || active >= limit) return;
    const { task, resolve, reject } = queue.shift();
    active++;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => { active--; next(); });
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    next();
  });
}

// Always use the lib-storage Upload helper. It does a single PutObject under
// the part-size threshold (no multipart overhead for small files), and for
// larger bodies it uploads in parts. Critically, it materializes the stream
// safely so SDK retries can replay the body — using PutObjectCommand directly
// with `Body: createReadStream(...)` would silently corrupt retried uploads.
async function putOne(client, params) {
  const upload = new Upload({ client, params });
  await upload.done();
}

export async function uploadGallery({
  galleryId,
  stagingDir,
  expireDays,
  config,
  concurrency = 8,
}) {
  const client = new S3Client({
    region: config.awsRegion,
    credentials: fromIni({ profile: config.awsProfile }),
  });

  const tagging = expireDays != null ? `expire-days=${expireDays}` : undefined;

  const files = [];
  for await (const f of walk(stagingDir)) files.push(f);

  const limit = withConcurrency(concurrency);
  const uploaded = [];
  const failed = [];

  const buildParams = (localPath, key) => ({
    Bucket: config.s3Bucket,
    Key: key,
    Body: createReadStream(localPath),
    ContentType: contentTypeFor(localPath),
    CacheControl: cacheControlFor(localPath),
    ...(tagging ? { Tagging: tagging } : {}),
  });

  await Promise.all(files.map((localPath) => limit(async () => {
    const rel = relative(stagingDir, localPath).split(/[/\\]/).join('/');
    const key = keyFor(galleryId, rel);
    try {
      await putOne(client, buildParams(localPath, key));
      uploaded.push(key);
    } catch (err) {
      failed.push({ key, localPath, reason: err.message });

      if (rel === 'index.html') {
        try {
          await putOne(client, buildParams(localPath, key));
          uploaded.push(key);
          failed.pop();
        } catch (_e) { /* keep original failure */ }
      }
    }
  })));

  const url = `https://${config.cloudfrontDomain}/g/${galleryId}`;
  const indexUploaded = uploaded.includes(`g/${galleryId}`);

  return { url, uploaded, failed, indexUploaded };
}
