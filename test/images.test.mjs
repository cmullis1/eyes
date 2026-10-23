import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { contactSheet, sideBySide, toGif, readRgba } from '../src/images.mjs';

const PAD = 16;
const GAP = 16;
const LABEL_HEIGHT = 32;

let dir;

async function makePng(name, width, height, color) {
  const file = path.join(dir, name);
  await sharp({ create: { width, height, channels: 3, background: color } }).png().toFile(file);
  return file;
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes images test '));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('contact sheet of 4 tiles including a tall one stays within bounds and does not crop', async () => {
  const items = [
    { path: await makePng('a.png', 1600, 900, '#c33'), label: 'desktop' },
    { path: await makePng('b.png', 3840, 1934, '#3c3'), label: '4k' },
    { path: await makePng('c.png', 390, 844, '#33c'), label: 'phone' },
    { path: await makePng('tall.png', 2194, 7000, '#cc3'), label: 'tall full page' },
  ];
  const out = path.join(dir, 'sheet.png');
  const result = await contactSheet(items, out);
  assert.equal(result, out);
  const meta = await sharp(out).metadata();
  assert.ok(meta.width <= 2400, `width ${meta.width}`);
  assert.ok(meta.height <= 6000, `height ${meta.height}`);

  // Exact height: padding + two rows, each its tallest scaled tile plus one label strip.
  // Without labels the sheet would be exactly 2 * LABEL_HEIGHT shorter.
  const cell = Math.floor((2400 - 2 * PAD - 2 * GAP) / 3);
  const scaled = (w, h) => Math.round(h * Math.min(1, cell / w));
  const row1 = Math.max(scaled(1600, 900), scaled(3840, 1934), scaled(390, 844));
  const row2 = scaled(2194, 7000);
  assert.equal(meta.height, PAD + (row1 + LABEL_HEIGHT) + GAP + (row2 + LABEL_HEIGHT) + PAD);

  // The tall tile is downscaled, not cropped: its yellow content reaches the
  // bottom of its cell, and the aspect ratio is preserved (no horizontal squash).
  const { data, width, height } = await readRgba(out);
  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] === 0xcc && data[i + 1] === 0xcc && data[i + 2] === 0x33) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  assert.ok(maxX > minX && maxY > minY, 'yellow tile present');
  const ratio = (maxX - minX + 1) / (maxY - minY + 1);
  assert.ok(Math.abs(ratio - 2194 / 7000) < 0.01, `aspect ratio ${ratio}`);
});

test('contact sheet respects a smaller maxWidth and explicit columns', async () => {
  const items = [
    { path: await makePng('s1.png', 1000, 600, '#888'), label: 'one' },
    { path: await makePng('s2.png', 1000, 600, '#444'), label: 'two' },
  ];
  const out = path.join(dir, 'narrow.png');
  await contactSheet(items, out, { maxWidth: 800, columns: 1 });
  const meta = await sharp(out).metadata();
  assert.ok(meta.width <= 800, `width ${meta.width}`);
  // One column: two tiles stacked, each with its own label strip.
  const tileHeight = Math.round(600 * ((800 - 2 * PAD) / 1000));
  assert.equal(meta.height, PAD + 2 * (tileHeight + LABEL_HEIGHT) + GAP + PAD);
});

// Count near-black pixels in the label strip under the tile at (PAD, PAD).
async function darkPixelsInLabelStrip(file, tileHeight, stripWidth) {
  const { data, width } = await readRgba(file);
  const top = PAD + tileHeight;
  let dark = 0;
  let nonWhite = 0;
  for (let y = top; y < top + LABEL_HEIGHT; y++) {
    for (let x = PAD; x < PAD + stripWidth; x++) {
      const i = (y * width + x) * 4;
      if (data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90) dark++;
      if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) nonWhite++;
    }
  }
  return { dark, nonWhite };
}

test('the label is drawn as dark text on a white strip under its tile', async () => {
  const tile = await makePng('lab.png', 600, 300, '#468');
  const labelled = path.join(dir, 'labelled.png');
  const blank = path.join(dir, 'blank.png');
  await contactSheet([{ path: tile, label: 'Label text' }], labelled, { maxWidth: 700 });
  await contactSheet([{ path: tile, label: '' }], blank, { maxWidth: 700 });

  const withText = await darkPixelsInLabelStrip(labelled, 300, 600);
  const without = await darkPixelsInLabelStrip(blank, 300, 600);
  assert.ok(withText.dark > 50, `dark pixels with label: ${withText.dark}`);
  assert.equal(without.dark, 0);
  assert.equal(without.nonWhite, 0, 'strip is plain white when the label is empty');
});

test('a single tile is not upscaled', async () => {
  const items = [{ path: await makePng('small.png', 200, 100, '#369'), label: 'small' }];
  const out = path.join(dir, 'single.png');
  await contactSheet(items, out);
  const meta = await sharp(out).metadata();
  assert.ok(meta.width < 400, `width ${meta.width}`);
});

test('labels with XML characters and non-ASCII render without throwing', async () => {
  const items = [
    { path: await makePng('x.png', 300, 200, '#999'), label: `a&b <c> "d" 'e' Ünïcödé →` },
    { path: await makePng('y.png', 300, 200, '#777'), label: '' },
  ];
  const out = path.join(dir, 'escaped.png');
  await contactSheet(items, out);
  const meta = await sharp(out).metadata();
  assert.ok(meta.width > 0 && meta.height > 0);
});

test('contact sheet rejects an empty item list', async () => {
  await assert.rejects(contactSheet([], path.join(dir, 'none.png')), /no images/i);
});

test('sideBySide width is about the sum of three equal-height panes', async () => {
  const before = await makePng('before.png', 800, 400, '#c00');
  const afterP = await makePng('after.png', 600, 300, '#0c0');
  const diff = await makePng('diff.png', 1000, 500, '#00c');
  const out = path.join(dir, 'sbs.png');
  const result = await sideBySide(before, afterP, diff, out);
  assert.equal(result, out);
  const meta = await sharp(out).metadata();
  // Common height 300: panes are 600, 600, 600 wide.
  assert.ok(meta.width >= 1800 && meta.width <= 1800 + 100, `width ${meta.width}`);
  // Panes plus a label strip.
  assert.ok(meta.height > 300 && meta.height < 400, `height ${meta.height}`);
});

test('sideBySide downscales results wider than 2400', async () => {
  const a = await makePng('wa.png', 1920, 1080, '#c00');
  const b = await makePng('wb.png', 1920, 1080, '#0c0');
  const c = await makePng('wc.png', 1920, 1080, '#00c');
  const out = path.join(dir, 'sbs-wide.png');
  await sideBySide(a, b, c, out);
  const meta = await sharp(out).metadata();
  assert.ok(meta.width <= 2400, `width ${meta.width}`);
});

test('toGif of 10 frames makes a 10-page animated GIF', async () => {
  const frames = [];
  for (let i = 0; i < 10; i++) {
    frames.push(await makePng(`f${i}.png`, 320, 200, { r: i * 25, g: 100, b: 200 - i * 20 }));
  }
  const out = path.join(dir, 'anim.gif');
  const result = await toGif(frames, out, 10);
  assert.equal(result, out);
  const meta = await sharp(out, { animated: true }).metadata();
  assert.equal(meta.pages, 10);
  assert.equal(meta.width, 320);
  assert.equal(meta.pageHeight, 200);
});

test('toGif downscales to maxWidth and tolerates differing frame sizes', async () => {
  const frames = [
    await makePng('g0.png', 1920, 1080, '#c00'),
    await makePng('g1.png', 1280, 720, '#0c0'),
  ];
  const out = path.join(dir, 'big.gif');
  await toGif(frames, out, 5);
  const meta = await sharp(out, { animated: true }).metadata();
  assert.equal(meta.pages, 2);
  assert.equal(meta.width, 960);
  assert.equal(meta.pageHeight, 540);
});

test('toGif rejects an empty frame list', async () => {
  await assert.rejects(toGif([], path.join(dir, 'empty.gif'), 10), /no frames/i);
});

test('readRgba returns raw RGBA pixels with dimensions', async () => {
  const file = await makePng('rgba.png', 4, 3, '#102030');
  const { data, width, height } = await readRgba(file);
  assert.equal(width, 4);
  assert.equal(height, 3);
  assert.equal(data.length, 4 * 3 * 4);
  assert.deepEqual([...data.subarray(0, 4)], [0x10, 0x20, 0x30, 255]);
});
