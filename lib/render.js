import { copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', 'templates');
const TEMPLATE_PATH = join(TEMPLATE_DIR, 'index.html.tmpl');
const PSWP_DIR = join(TEMPLATE_DIR, 'photoswipe');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) { return escapeHtml(s); }

// PhotoSwipe rebuilds its slide dataSource from the clicked DOM at click
// time, so per-slide dims have to live on the <a> as data-pswp-width/height
// (otherwise it falls back to viewport size and stretches the image).
// data-pswp-type="video" routes through the contentLoad handler below.
function renderTile(item) {
  const cls = item.kind === 'video' ? 'tile is-video' : 'tile';
  const thumb = `thumbnails/${encodeURIComponent(item.stem)}.jpg`;
  const href = `images/${encodeURIComponent(item.finalName)}`;
  const typeAttr = item.kind === 'video' ? ' data-pswp-type="video"' : '';
  return `  <a class="${cls}" href="${href}"${typeAttr} data-pswp-width="${item.width}" data-pswp-height="${item.height}">
    <img src="${escapeAttr(thumb)}" alt="" loading="lazy">
  </a>`;
}

export async function renderGallery({ galleryId, title, items, outputDir }) {
  await mkdir(outputDir, { recursive: true });

  const tpl = await readFile(TEMPLATE_PATH, 'utf8');

  // The HTML is uploaded to the bare key `g/<id>`; the trailing slash on the
  // <base href> makes `images/foo.jpg` resolve to `g/<id>/images/foo.jpg`.
  // Gallery IDs are URL-safe base64, so no escaping needed.
  const baseHref = `<base href="${galleryId}/">`;

  const trimmedTitle = title ? title.trim() : '';
  const titleText = trimmedTitle ? escapeHtml(trimmedTitle) : 'Gallery';
  const heading = trimmedTitle ? `<h1>${escapeHtml(trimmedTitle)}</h1>` : '';
  const tiles = items.map(renderTile).join('\n');

  const html = tpl
    .replace('{{BASE_HREF}}', baseHref)
    .replace('{{TITLE_TEXT}}', titleText)
    .replace('{{HEADING}}', heading)
    .replace('{{TILES}}', tiles);

  await writeFile(join(outputDir, 'index.html'), html, 'utf8');

  // Copy vendored PhotoSwipe assets into outputDir/photoswipe/
  const targetPswp = join(outputDir, 'photoswipe');
  await mkdir(targetPswp, { recursive: true });
  const pswpFiles = await readdir(PSWP_DIR);
  for (const f of pswpFiles) {
    await copyFile(join(PSWP_DIR, f), join(targetPswp, f));
  }
}
