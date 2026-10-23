// CSS and Web animations run on the browser's own timeline, which the fixed clock does not control.
// With `clock: fixed` (and in `eyes film`) that timeline is frozen before the page loads, so no
// animation moves in real time however long setup takes, and Eyes moves them itself: whenever it
// advances the page clock it advances the animations the page has running by the same amount.

// Runs before navigation: freezes the document timeline (a rate of 0 through the DevTools protocol).
// The setting belongs to the page, so it also holds for pages reached by navigating.
export async function freezeAnimations(page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Animation.enable');
  await session.send('Animation.setPlaybackRate', { playbackRate: 0 });
}

// In the page, before the clock moves: the animations the page has running right now.
function markRunning() {
  window.__eyesRunning = new Set(document.getAnimations().filter(isRunning));
  function isRunning(animation) {
    return animation.timeline === document.timeline && animation.playState === 'running';
  }
}

// In the page, after the clock moved by `ms`: moves forward every animation that was running before
// and still is, which are the ones the page considers running throughout, by ms times its own
// playbackRate. One the page paused or never started stays put; one it started or resumed during
// the step moves from the next. Animations on scroll or view timelines are not time-driven, so they
// are left alone.
function advanceRunning(ms) {
  const before = window.__eyesRunning ?? new Set();
  for (const animation of document.getAnimations()) {
    if (!before.has(animation) || animation.playState !== 'running') continue;
    const now = animation.currentTime;
    if (typeof now !== 'number' || !Number.isFinite(now)) continue;
    animation.currentTime = now + ms * animation.playbackRate;
  }
  window.__eyesRunning = null;
}

// Moves the fixed clock and the page's running animations forward by `ms`.
export async function advanceTime(page, ms) {
  await page.evaluate(markRunning);
  await page.clock.runFor(ms);
  await page.evaluate(advanceRunning, ms);
}
