// One Chromium for a whole run, with its own log, and the per-profile loop that survives Chromium dying.
//
// Chromium's log (browser, GPU and renderer processes) is written for every launch and saved as
// <runDir>/browser.log. When Chromium dies under a profile, that profile's results are dropped,
// Chromium is relaunched and the profile runs once more from a fresh context; a second death is an
// environment failure (an error of kind `browser`, exit 3), never a page failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './browser.mjs';

const TAIL_LINES = 15;
const PROBE_TIMEOUT_MS = 5000;

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, 'timeout');
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class BrowserSession {
  #dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-browser-'));
  #logs = []; // [{file, label}], one per Chromium launch, in order
  #runDir = null;
  #browser = null;
  #gpu = null;
  #dead = false;
  #closing = false;

  static async open() {
    const session = new BrowserSession();
    try {
      await session.#start();
    } catch (err) {
      session.#cleanup();
      throw err;
    }
    return session;
  }

  get browser() {
    return this.#browser;
  }

  get gpu() {
    return this.#gpu;
  }

  async #start() {
    const logFile = (mode) => {
      const file = path.join(this.#dir, `launch-${this.#logs.length + 1}.log`);
      this.#logs.push({ file, label: `launch ${this.#logs.length + 1} (${mode})` });
      return file;
    };
    const { browser, gpu } = await launch({ logFile });
    this.#browser = browser;
    this.#gpu = gpu;
    this.#dead = false;
    browser.once('disconnected', () => {
      if (browser === this.#browser && !this.#closing) this.#dead = true;
    });
  }

  // Where browser.log goes when the session closes.
  saveLogIn(runDir) {
    this.#runDir = runDir;
  }

  // The last lines of the current Chromium's log.
  logTail(lines = TAIL_LINES) {
    const current = this.#logs.at(-1);
    try {
      return fs.readFileSync(current.file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
    } catch {
      return '';
    }
  }

  // True when Chromium is gone. `suspicious` (the profile recorded problems) also asks Chromium for
  // a fresh context, since a call can fail before the disconnect event arrives.
  async died(suspicious) {
    if (this.#dead || !this.#browser.isConnected()) return true;
    if (!suspicious) return false;
    const probe = (async () => {
      const context = await this.#browser.newContext();
      await context.close();
      return 'alive';
    })().catch(() => 'dead');
    const result = await withTimeout(probe, PROBE_TIMEOUT_MS);
    return result !== 'alive' || this.#dead;
  }

  async relaunch() {
    const old = this.#browser;
    this.#closing = true;
    await withTimeout(old.close().catch(() => {}), PROBE_TIMEOUT_MS);
    this.#closing = false;
    await this.#start();
  }

  // Closes Chromium and writes <runDir>/browser.log from every launch's log.
  async close() {
    this.#closing = true;
    if (this.#browser) await withTimeout(this.#browser.close().catch(() => {}), PROBE_TIMEOUT_MS);
    if (this.#runDir) {
      const parts = this.#logs.map(({ file, label }) => {
        let text;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          text = '(Chromium wrote no log)\n';
        }
        return `===== ${label} =====\n${text}`;
      });
      try {
        fs.writeFileSync(path.join(this.#runDir, 'browser.log'), parts.join('\n'));
      } catch {
        // The run folder is gone; the report already said what happened.
      }
    }
    this.#cleanup();
  }

  // A killed Chromium's processes can hold their log open for a moment after they are gone.
  #cleanup() {
    try {
      fs.rmSync(this.#dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Left in the temp folder; never worth failing a run over.
    }
  }
}

// Runs capture(browser, profile) for each profile in turn and returns the shots per profile.
// When Chromium died under a profile, its results are dropped and it is run again in a relaunched
// Chromium; a second death records a `browser` error (exit 3) and the remaining profiles are skipped.
export async function captureEach({ session, profiles, report, capture }) {
  const shotsByProfile = [];
  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    const mark = report.mark();
    let shots = await capture(session.browser, profile);
    if (await session.died(report.since(mark).problems)) {
      const tail = session.logTail();
      report.rollback(mark);
      let restarted = true;
      try {
        await session.relaunch();
      } catch (err) {
        restarted = false;
        report.addError({ profile: profile.name, kind: 'browser', text: `Chromium died during ${profile.name} and would not start again: ${firstLine(err)}. Chromium's log (browser.log) ends: ${tail}` });
      }
      if (restarted) {
        report.addNote(`Chromium died during ${profile.name}; it was restarted and ${profile.name} ran again. Its log is browser.log in the run folder; it ended: ${tail}`);
        const retry = report.mark();
        shots = await capture(session.browser, profile);
        if (await session.died(report.since(retry).problems)) {
          const again = session.logTail();
          report.rollback(retry);
          report.addError({ profile: profile.name, kind: 'browser', text: `Chromium died twice during ${profile.name}. Chromium's log (browser.log) ends: ${again}` });
          restarted = false;
        }
      }
      if (!restarted) {
        const skipped = profiles.slice(i + 1).map((p) => p.name);
        if (skipped.length > 0) report.addNote(`Not run because Chromium kept dying: ${skipped.join(', ')}`);
        // One (empty) entry per profile, so callers can still pair them with profiles by index.
        for (let j = i; j < profiles.length; j++) shotsByProfile.push([]);
        break;
      }
    }
    shotsByProfile.push(shots);
  }
  return shotsByProfile;
}
