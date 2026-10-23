import './setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { launch, openPage } from '../src/web/browser.mjs';
import { waitReady } from '../src/web/ready.mjs';
import { findLayoutProblems } from '../src/web/layout.mjs';
import { resolveProfiles } from '../src/profiles.mjs';
import { Report } from '../src/report.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
let browser;

before(async () => {
  ({ browser } = await launch());
});

after(async () => {
  await browser?.close();
});

async function problemsFor(file, profile) {
  const page = await openPage(browser, profile, new Report('layout-test', [profile.name]));
  try {
    await page.goto(pathToFileURL(path.join(fixtures, file)).href);
    await waitReady(page);
    return await findLayoutProblems(page);
  } finally {
    await page.context().close();
  }
}

test('clean-busy.html (visually hidden text, collapsed panels, scroll boxes, closed overlays, custom switches) has no problems', async () => {
  for (const profile of resolveProfiles(['desktop', '4k'])) {
    assert.deepEqual(await problemsFor('clean-busy.html', profile), [], profile.name);
  }
});

test('controls behind an open modal <dialog> are inert, not covered (no false FAIL)', async () => {
  for (const profile of resolveProfiles(['desktop', 'laptop'])) {
    assert.deepEqual(await problemsFor('modal.html', profile), [], profile.name);
  }
});

test('a link that wraps is covered only when every line is: the gap between its lines is not a cover', async () => {
  for (const profile of resolveProfiles(['ipad-mini', 'ipad-13', 'desktop'])) {
    const page = await openPage(browser, profile, new Report('layout-test', [profile.name]));
    try {
      await page.goto(pathToFileURL(path.join(fixtures, 'wrap.html')).href);
      await waitReady(page);
      // The page is laid out as the test means: every link wraps, the middle of the free link's box
      // lands on its paragraph, and the strip covers the first line of half-link but not the second.
      const layout = await page.evaluate(() => {
        const lines = (id) => [...document.getElementById(id).getClientRects()];
        const hit = (r) => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).id;
        const box = document.getElementById('wrapped').getBoundingClientRect();
        return {
          lineCounts: ['wrapped', 'half-link', 'covered-link', 'behind-link'].map((id) => lines(id).length),
          wrappedMiddle: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2).id,
          halfLines: lines('half-link').map(hit),
        };
      });
      assert.deepEqual(layout, { lineCounts: [2, 2, 2, 2], wrappedMiddle: 'free', halfLines: ['half', 'half-link'] }, profile.name);
      assert.deepEqual(
        (await findLayoutProblems(page)).map((p) => [p.selector, p.detail]),
        [
          ['#covered-link', 'covered at its centre by #veil'],
          ['#behind-link', 'covered at its centre by #behind'],
        ],
        profile.name,
      );
    } finally {
      await page.context().close();
    }
  }
});
