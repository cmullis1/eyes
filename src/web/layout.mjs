// Layout problem detection: sideways scrolling, covered or off-page controls, cut-off text.
// All measuring happens inside the page in one evaluate call, so results describe exactly
// what the browser laid out at the profile's size.

const MAX_PER_KIND = 20;
// Controls scrolled into view to test for covering; keeps very long pages bounded.
const MAX_SCROLLED_CHECKS = 300;

function measure({ maxPerKind, maxScrolled }) {
  const root = document.documentElement;
  const px = (n) => `${Math.round(n)}px`;

  // Shortest CSS path that selects exactly this element.
  const segment = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const classes = [...el.classList].slice(0, 3).map((c) => `.${CSS.escape(c)}`).join('');
    const parent = el.parentElement;
    let nth = '';
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) nth = `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return `${tag}${classes}${nth}`;
  };
  const isUnique = (selector, el) => {
    try {
      const found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch {
      return false;
    }
  };
  const selectorFor = (el) => {
    if (el === root) return 'html';
    let path = '';
    for (let node = el; node && node !== root; node = node.parentElement) {
      path = path ? `${segment(node)} > ${path}` : segment(node);
      if (isUnique(path, el)) return path;
    }
    return `html > ${path}`;
  };

  const found = { hscroll: [], offscreen: [], textOverflow: [] };
  const add = (kind, selector, detail) => {
    if (found[kind].length < maxPerKind) found[kind].push({ kind, selector, detail });
  };

  // Sideways scrolling: the page is wider than the window.
  const pageWidth = root.scrollWidth;
  if (pageWidth > window.innerWidth + 1) {
    // Name the element reaching furthest right, when one can be found.
    let culprit = root;
    let furthest = window.innerWidth + 1;
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      const right = el.getBoundingClientRect().right + window.scrollX;
      if (right > furthest) {
        furthest = right;
        culprit = el;
      }
    }
    add('hscroll', selectorFor(culprit), `page ${pageWidth}px wide in a ${window.innerWidth}px window`);
  }

  // True when the element, or something around it, keeps it from being seen or used:
  // transparent, hidden, inert, not clickable, or clipped away with clip / clip-path.
  const unseen = (el, { forClicks = false } = {}) => {
    for (let node = el; node && node !== root; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (Number(s.opacity) === 0 || s.visibility === 'hidden' || s.display === 'none') return true;
      if (s.clipPath !== 'none') return true;
      if (s.clip !== 'auto' && (s.position === 'absolute' || s.position === 'fixed')) return true;
      if (forClicks && (s.pointerEvents === 'none' || node.inert === true)) return true;
    }
    return false;
  };

  // Cut-off text: overflow is hidden or clipped without an ellipsis.
  for (const el of document.querySelectorAll('*')) {
    if (el === root || el === document.body) continue;
    if (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth === 0) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue;
    if (style.textOverflow === 'ellipsis') continue;
    if (!(el.textContent || '').trim()) continue;
    if (unseen(el)) continue;
    add(
      'textOverflow',
      selectorFor(el),
      `content ${el.scrollWidth}px wide in a ${el.clientWidth}px box with overflow ${style.overflowX}`,
    );
  }

  // Interactive elements that are partly off the page sideways, or covered at their centre.
  const controls = [];
  const interactive = 'button, a[href], input, select, textarea, [role=button]';
  for (const el of document.querySelectorAll(interactive)) {
    if (el.matches('input[type=hidden]')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (unseen(el, { forClicks: true })) continue;
    controls.push(el);
  }

  // A control inside a scrolling or clipping box is allowed to sit beyond its edge.
  const clippedByAncestor = (el) => {
    for (let node = el.parentElement; node && node !== document.body && node !== root; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.overflowX !== 'visible') return true;
    }
    return false;
  };

  // A control whose centre lies outside a clipping ancestor's box (collapsed panel, item past a
  // scroll box's edge) is clipped by its own container, which is not another element covering it.
  const centreClipped = (el, x, y) => {
    for (let node = el.parentElement; node && node !== document.body && node !== root; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const r = node.getBoundingClientRect();
      if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) return true;
    }
    return false;
  };

  // While a modal <dialog> is open, everything outside it is inert: it cannot be used, so it is
  // not "covered" (the dialog's backdrop sits over it on purpose).
  const modal = document.querySelector('dialog:modal');
  const inertBehindModal = (el) => modal !== null && !modal.contains(el);

  const startX = window.scrollX;
  const startY = window.scrollY;
  let scrolled = 0;
  for (const el of controls) {
    let rect = el.getBoundingClientRect();
    const left = rect.left + window.scrollX;
    const right = rect.right + window.scrollX;
    const partlyOutside = left < -1 || right > pageWidth + 1;
    const entirelyOutside = right <= 0 || left >= pageWidth;
    if (partlyOutside && !entirelyOutside && !clippedByAncestor(el)) {
      add(
        'offscreen',
        selectorFor(el),
        `control spans ${px(left)} to ${px(right)} but the page is ${px(pageWidth)} wide`,
      );
      continue;
    }

    if (inertBehindModal(el)) continue;
    const inView = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    if (!inView) {
      if (scrolled >= maxScrolled) continue;
      scrolled += 1;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      rect = el.getBoundingClientRect();
    }
    // A control that wraps (an inline link) has one box per line, and the centre of its overall box
    // can fall between the lines, on its parent. So the centre of each line's box is tested, and the
    // control counts as covered only when every centre that can be tested is covered.
    let cover = null;
    let reachable = false;
    for (const box of el.getClientRects()) {
      if (box.width < 2 || box.height < 2) continue;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
      if (centreClipped(el, x, y)) continue;
      const top = document.elementFromPoint(x, y);
      if (!top || top === el || el.contains(top) || (el.labels && [...el.labels].some((label) => label.contains(top)))) {
        reachable = true;
        break;
      }
      cover ??= top;
    }
    if (cover && !reachable) add('offscreen', selectorFor(el), `covered at its centre by ${selectorFor(cover)}`);
  }
  window.scrollTo({ left: startX, top: startY, behavior: 'instant' });

  return [...found.hscroll, ...found.offscreen, ...found.textOverflow];
}

export async function findLayoutProblems(page) {
  return page.evaluate(measure, { maxPerKind: MAX_PER_KIND, maxScrolled: MAX_SCROLLED_CHECKS });
}
