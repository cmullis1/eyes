// Flicker score: how much of the picture strobes. A flicker or shimmer flips pixels back and forth
// (A -> B -> A -> B); smooth motion never does, and fast motion (an object that moves its own width
// in a frame) passes a pixel once (A -> B -> A -> A), so only a pixel that alternates over four
// frames in a row is counted.
//
// The picture is cut into tiles of about 64x64 device pixels and each tile is scored on its own,
// so a small strobing element on a big page scores as high as it looks; the score is the worst
// tile's. The share of the whole frame that strobes is kept as detail.

// A pixel "changed" when any colour channel moved by more than LARGE; it "came back" when it ended
// within SMALL of where it was two frames before. Alpha is ignored.
const LARGE = 48;
const SMALL = 16;
export const TILE = 64;
// Above this (as printed, three decimals) the picture visibly strobes.
export const FLICKER_HIGH = 0.02;

// Tile edges along one side: about TILE pixels each, with no sliver at the end.
function edges(length) {
  const count = Math.max(1, Math.round(length / TILE));
  return Array.from({ length: count + 1 }, (_, i) => Math.round((i * length) / count));
}

// Which tile each pixel column (or row) belongs to.
function lookup(bounds, length) {
  const map = new Uint16Array(length);
  for (let t = 0; t < bounds.length - 1; t++) map.fill(t, bounds[t], bounds[t + 1]);
  return map;
}

class Tiling {
  constructor(width, height) {
    this.xs = edges(width);
    this.ys = edges(height);
    this.columns = this.xs.length - 1;
    this.colOf = lookup(this.xs, width);
    this.rowOf = lookup(this.ys, height);
    this.count = this.columns * (this.ys.length - 1);
    this.pixels = new Float64Array(this.count);
    for (let r = 0; r < this.ys.length - 1; r++) {
      for (let c = 0; c < this.columns; c++) {
        this.pixels[r * this.columns + c] = (this.xs[c + 1] - this.xs[c]) * (this.ys[r + 1] - this.ys[r]);
      }
    }
  }

  box(t) {
    const c = t % this.columns;
    const r = Math.floor(t / this.columns);
    return { x: this.xs[c], y: this.ys[r], width: this.xs[c + 1] - this.xs[c], height: this.ys[r + 1] - this.ys[r] };
  }
}

const near = (p, q, i) => Math.max(Math.abs(p.data[i] - q.data[i]), Math.abs(p.data[i + 1] - q.data[i + 1]), Math.abs(p.data[i + 2] - q.data[i + 2]));

// Per tile, the pixels that went A -> B, back near A, and back near B again over frames a, b, c, d.
function strobeCounts(a, b, c, d, tiling) {
  const counts = new Uint32Array(tiling.count);
  const { width, height } = a;
  for (let y = 0; y < height; y++) {
    const rowBase = tiling.rowOf[y] * tiling.columns;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (near(a, b, i) <= LARGE || near(a, c, i) > SMALL || near(b, d, i) > SMALL) continue;
      counts[rowBase + tiling.colOf[x]] += 1;
    }
  }
  return counts;
}

// Takes frames one at a time and keeps only the last three, so a long film never holds them all in memory.
export class FlickerMeter {
  #recent = [];
  #tiling = null;
  #tileSums = null;
  #frameSum = 0;
  #runs = 0;

  push(frame) {
    const last = this.#recent.at(-1);
    if (last && (frame.width !== last.width || frame.height !== last.height)) {
      throw new Error(`flicker: frames differ in size (${last.width}x${last.height} then ${frame.width}x${frame.height})`);
    }
    if (this.#recent.length === 3) {
      this.#tiling ??= new Tiling(frame.width, frame.height);
      this.#tileSums ??= new Float64Array(this.#tiling.count);
      const counts = strobeCounts(...this.#recent, frame, this.#tiling);
      let total = 0;
      for (let t = 0; t < counts.length; t++) {
        this.#tileSums[t] += counts[t] / this.#tiling.pixels[t];
        total += counts[t];
      }
      this.#frameSum += total / (frame.width * frame.height);
      this.#runs += 1;
    }
    this.#recent.push(frame);
    if (this.#recent.length > 3) this.#recent.shift();
  }

  // score: the worst tile's mean strobing share over every run of four consecutive frames; frame:
  // the same over the whole frame; tile: the worst tile's box in pixels. All 0 (and no tile) with
  // fewer than four frames.
  result() {
    if (this.#runs === 0) return { score: 0, frame: 0, tile: null };
    let worst = 0;
    for (let t = 1; t < this.#tileSums.length; t++) if (this.#tileSums[t] > this.#tileSums[worst]) worst = t;
    return {
      score: this.#tileSums[worst] / this.#runs,
      frame: this.#frameSum / this.#runs,
      tile: this.#tiling.box(worst),
    };
  }

  score() {
    return this.result().score;
  }
}

// frames: [{data, width, height}] as 8-bit RGBA. 0 for smooth motion, high for strobing or shimmer.
export function flickerScore(frames) {
  const meter = new FlickerMeter();
  for (const frame of frames) meter.push(frame);
  return meter.score();
}

// The score as printed (three decimals) and the verdict taken on that printed value, so a report
// never says a score is above the threshold when both print the same.
export function judgeFlicker(score) {
  const text = score.toFixed(3);
  return { text, high: Number(text) > FLICKER_HIGH, threshold: FLICKER_HIGH.toFixed(3) };
}
