// Run results: one model, rendered as a short text report and a full JSON file.

export class EyesError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'EyesError';
    this.exitCode = exitCode;
  }
}

const MAX_LINES = 40;
// Errors of these kinds mean Eyes' own environment failed (Chromium died, the dev server stopped),
// which says nothing about the page: the run exits 3, not 1.
export const ENVIRONMENT_KINDS = new Set(['browser', 'server']);
const SECTION_CAPS = [10, 5, 3, 1];
const MAX_ITEM_CHARS = 200;

// Collapse all whitespace (including newlines) to single spaces and bound the length,
// so one report item is always exactly one line.
function oneLine(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS - 1)}…` : text;
}

export class Report {
  constructor(name, profiles = []) {
    this.name = name;
    this.profiles = [...profiles];
    this.errors = [];
    this.checks = [];
    this.layout = [];
    this.shots = [];
    this.diffs = [];
    this.notes = [];
    this.gpu = null;
    this.sheet = null;
  }

  addError({ profile, kind, text, location }) {
    this.errors.push({ profile, kind, text, location });
  }

  addCheck({ profile, step, label, passed, detail }) {
    this.checks.push({ profile, step, label, passed, detail });
  }

  addLayout({ profile, kind, selector, detail }) {
    this.layout.push({ profile, kind, selector, detail });
  }

  addShot({ name, profile, path }) {
    this.shots.push({ name, profile, path });
  }

  addDiff({ name, profile, ratio, status, sideBySide }) {
    this.diffs.push({ name, profile, ratio, status, sideBySide });
  }

  addNote(text) {
    this.notes.push(text);
  }

  setGpu({ renderer, software, headed = false }) {
    this.gpu = { renderer, software, headed };
  }

  setSheet(path) {
    this.sheet = path;
  }

  // A point to roll back to: everything recorded after it can be dropped, for example when a
  // profile is run again after Chromium died under it.
  mark() {
    return { errors: this.errors.length, checks: this.checks.length, layout: this.layout.length, shots: this.shots.length, diffs: this.diffs.length, notes: this.notes.length };
  }

  // What was recorded since `mark`: problems is true for any error, layout problem or failed check.
  since(mark) {
    const errors = this.errors.slice(mark.errors);
    const failedChecks = this.checks.slice(mark.checks).filter((c) => !c.passed);
    const layout = this.layout.slice(mark.layout);
    return { errors, problems: errors.length + failedChecks.length + layout.length > 0 };
  }

  rollback(mark) {
    for (const key of Object.keys(mark)) this[key].length = mark[key];
  }

  get environmentFailure() {
    return this.errors.some((e) => ENVIRONMENT_KINDS.has(e.kind));
  }

  get passed() {
    return (
      this.errors.length === 0 &&
      this.layout.length === 0 &&
      this.checks.every((c) => c.passed) &&
      this.diffs.every((d) => d.status !== 'changed')
    );
  }

  exitCode() {
    if (this.environmentFailure) return 3;
    return this.passed ? 0 : 1;
  }

  toText() {
    for (const cap of SECTION_CAPS) {
      const lines = this.#render(cap);
      if (lines.length < MAX_LINES) return lines.join('\n');
    }
    return this.#render(1).join('\n');
  }

  toJSON() {
    return {
      name: this.name,
      profiles: this.profiles,
      passed: this.passed,
      environmentFailure: this.environmentFailure,
      gpu: this.gpu,
      errors: this.errors,
      checks: this.checks,
      layout: this.layout,
      shots: this.shots,
      diffs: this.diffs,
      notes: this.notes,
      sheet: this.sheet,
    };
  }

  #render(cap) {
    const lines = [`${this.passed ? 'PASS' : 'FAIL'} ${this.name} (${this.profiles.join(', ')})`];
    if (this.gpu) {
      const software = this.gpu.software ? ' (software rendering)' : '';
      const headed = this.gpu.headed ? ' (headed off-screen fallback)' : '';
      lines.push(`GPU: ${oneLine(this.gpu.renderer)}${software}${headed}`);
    }
    const section = (items, format) => {
      for (const item of items.slice(0, cap)) lines.push(format(item));
      if (items.length > cap) lines.push(`…and ${items.length - cap} more`);
    };
    const tag = (profile) => (profile ? `[${oneLine(profile)}] ` : '');
    const tail = (prefix, value) => (value ? `${prefix}${oneLine(value)}` : '');

    section(this.errors, (e) => `error ${tag(e.profile)}${oneLine(e.kind)}: ${oneLine(e.text)}${e.location ? ` (${oneLine(e.location)})` : ''}`);
    section(
      this.checks.filter((c) => !c.passed),
      (c) => `check failed ${tag(c.profile)}step ${oneLine(c.step)} ${oneLine(c.label)}${tail(': ', c.detail)}`,
    );
    section(this.layout, (l) => `layout ${tag(l.profile)}${oneLine(l.kind)} ${oneLine(l.selector)}${tail(': ', l.detail)}`);
    section(
      this.diffs.filter((d) => d.status !== 'same'),
      (d) =>
        d.status === 'new'
          ? `diff ${tag(d.profile)}${oneLine(d.name)}: new (no baseline)`
          : `diff ${tag(d.profile)}${oneLine(d.name)}: changed ${(d.ratio * 100).toFixed(2)}%${d.sideBySide ? ` -> ${d.sideBySide}` : ''}`,
    );
    for (const note of this.notes) lines.push(oneLine(note));
    if (this.environmentFailure) {
      lines.push('Environment failure (exit 3): Chromium or the dev server failed, which says nothing about the page. Run it again.');
    }

    if (this.sheet) lines.push(`Read: ${this.sheet}`);
    return lines;
  }
}
