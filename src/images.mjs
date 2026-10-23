// Image output: contact sheets, before/after/difference strips and animated GIFs.
// Claude reads one composite image per run, so everything here favours "legible but small":
// tiles are downscaled (never upscaled, never cropped) and labels are drawn as SVG text.

import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';

const FONT_FAMILY = 'Segoe UI, Arial, sans-serif';
const FONT_SIZE = 18;
const LABEL_HEIGHT = 32;
const LABEL_CHAR_WIDTH = FONT_SIZE * 0.6;
const SHEET_PADDING = 16;
const SHEET_GAP = 16;
const PANE_GAP = 12;
const SHEET_BACKGROUND = '#e6e6e6';
const WHITE = '#ffffff';
const DEFAULT_MAX_WIDTH = 2400;
const DEFAULT_MAX_HEIGHT = 6000;

function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[c]);
}

function fitLabel(label, width) {
  const text = String(label ?? '').replace(/\s+/g, ' ').trim();
  const maxChars = Math.max(1, Math.floor((width - 16) / LABEL_CHAR_WIDTH));
  const chars = [...text];
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join('')}…` : text;
}

// A white strip with dark text, as a PNG buffer.
function labelStrip(label, width) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_HEIGHT}">` +
    `<rect width="${width}" height="${LABEL_HEIGHT}" fill="${WHITE}"/>` +
    `<text x="8" y="${Math.round(LABEL_HEIGHT / 2 + FONT_SIZE * 0.35)}" ` +
    `font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="#111111">` +
    `${escapeXml(fitLabel(label, width))}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function imageSize(file) {
  const { width, height } = await sharp(file).metadata();
  if (!width || !height) throw new Error(`Cannot read image size: ${file}`);
  return { width, height };
}

function ensureParentDir(outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
}

// Lay out `items` in a grid of `columns`. Each tile is scaled down to fit its column,
// keeping its aspect ratio; the label sits in a white strip beneath it.
export async function contactSheet(
  items,
  outPath,
  { maxWidth = DEFAULT_MAX_WIDTH, columns, maxHeight = DEFAULT_MAX_HEIGHT } = {},
) {
  if (!items || items.length === 0) throw new Error('contactSheet: no images to lay out');
  const cols = Math.max(1, Math.min(columns ?? Math.min(items.length, 3), items.length));
  const cellWidth = Math.floor((maxWidth - 2 * SHEET_PADDING - (cols - 1) * SHEET_GAP) / cols);

  const tiles = [];
  for (const item of items) {
    const size = await imageSize(item.path);
    const scale = Math.min(1, cellWidth / size.width);
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const image = await sharp(item.path)
      .resize({ width, height, fit: 'fill' })
      .removeAlpha()
      .png()
      .toBuffer();
    tiles.push({ image, width, height, label: item.label });
  }

  const rowCount = Math.ceil(tiles.length / cols);
  const columnWidths = Array.from({ length: cols }, (_, c) =>
    Math.max(...tiles.filter((_, i) => i % cols === c).map((t) => t.width)),
  );
  const rowHeights = Array.from({ length: rowCount }, (_, r) =>
    LABEL_HEIGHT + Math.max(...tiles.slice(r * cols, r * cols + cols).map((t) => t.height)),
  );

  const columnX = [];
  let x = SHEET_PADDING;
  for (const w of columnWidths) {
    columnX.push(x);
    x += w + SHEET_GAP;
  }
  const rowY = [];
  let y = SHEET_PADDING;
  for (const h of rowHeights) {
    rowY.push(y);
    y += h + SHEET_GAP;
  }
  const sheetWidth = x - SHEET_GAP + SHEET_PADDING;
  const sheetHeight = y - SHEET_GAP + SHEET_PADDING;

  const composites = [];
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const left = columnX[i % cols];
    const top = rowY[Math.floor(i / cols)];
    composites.push({ input: tile.image, left, top });
    composites.push({ input: await labelStrip(tile.label, tile.width), left, top: top + tile.height });
  }

  let sheet = sharp({
    create: { width: sheetWidth, height: sheetHeight, channels: 3, background: SHEET_BACKGROUND },
  })
    .composite(composites)
    .png();

  // A long column of tall tiles can still exceed the height budget: shrink the whole
  // sheet proportionally rather than cropping anything.
  if (sheetHeight > maxHeight) {
    const buffer = await sheet.toBuffer();
    sheet = sharp(buffer).resize({ height: maxHeight, fit: 'inside' }).png();
  }

  ensureParentDir(outPath);
  await sheet.toFile(outPath);
  return outPath;
}

// before | after | difference at a common height, each with a label beneath.
export async function sideBySide(
  beforePath,
  afterPath,
  diffPath,
  outPath,
  { maxWidth = DEFAULT_MAX_WIDTH } = {},
) {
  const panes = [
    { path: beforePath, label: 'before' },
    { path: afterPath, label: 'after' },
    { path: diffPath, label: 'difference' },
  ];
  const sizes = await Promise.all(panes.map((p) => imageSize(p.path)));

  const available = maxWidth - PANE_GAP * (panes.length - 1);
  const ratioSum = sizes.reduce((sum, s) => sum + s.width / s.height, 0);
  const height = Math.max(1, Math.floor(Math.min(...sizes.map((s) => s.height), available / ratioSum)));

  const composites = [];
  let x = 0;
  for (let i = 0; i < panes.length; i++) {
    const width = Math.max(1, Math.round((sizes[i].width * height) / sizes[i].height));
    const image = await sharp(panes[i].path)
      .resize({ width, height, fit: 'fill' })
      .removeAlpha()
      .png()
      .toBuffer();
    composites.push({ input: image, left: x, top: 0 });
    composites.push({ input: await labelStrip(panes[i].label, width), left: x, top: height });
    x += width + PANE_GAP;
  }
  const totalWidth = x - PANE_GAP;

  ensureParentDir(outPath);
  await sharp({
    create: { width: totalWidth, height: height + LABEL_HEIGHT, channels: 3, background: SHEET_BACKGROUND },
  })
    .composite(composites)
    .png()
    .toFile(outPath);
  return outPath;
}

// Animated GIF from PNG frames. Every frame is fitted to the first frame's (downscaled)
// size, so mixed-size input still produces a valid animation.
export async function toGif(framePaths, outPath, fps, maxWidth = 960) {
  if (!framePaths || framePaths.length === 0) throw new Error('toGif: no frames to animate');
  if (!(fps > 0)) throw new Error(`toGif: fps must be positive, got ${fps}`);

  const first = await imageSize(framePaths[0]);
  const scale = Math.min(1, maxWidth / first.width);
  const width = Math.max(1, Math.round(first.width * scale));
  const height = Math.max(1, Math.round(first.height * scale));

  const buffers = [];
  for (const framePath of framePaths) {
    buffers.push(
      await sharp(framePath)
        .resize({ width, height, fit: 'contain', background: WHITE })
        .flatten({ background: WHITE })
        .ensureAlpha()
        .raw()
        .toBuffer(),
    );
  }

  ensureParentDir(outPath);
  await sharp(Buffer.concat(buffers), {
    raw: { width, height: height * buffers.length, channels: 4, pageHeight: height },
  })
    .gif({ delay: Math.max(20, Math.round(1000 / fps)), loop: 0 })
    .toFile(outPath);
  return outPath;
}

// Decoded pixels as 8-bit RGBA, for pixel comparison.
export async function readRgba(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
