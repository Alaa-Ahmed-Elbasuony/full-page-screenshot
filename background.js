// chrome.tabs.captureVisibleTab is limited to 2 calls per second.
const MIN_CAPTURE_INTERVAL_MS = 550;
// Time for the page to repaint after scrolling (lazy images, scroll handlers).
const SCROLL_SETTLE_MS = 200;
// Time for the page to re-layout after unrolling scroll areas.
const PREPARE_SETTLE_MS = 400;
// Guard against infinite-scroll pages producing hundreds of frames.
const MAX_PAGE_HEIGHT = 30000;
// Rounding slack so a 1px overflow doesn't cost an extra capture.
const OVERFLOW_TOLERANCE = 2;
// Time for the page to re-render (and fetch sharper srcset images) at the new pixel density.
const HD_SETTLE_MS = 800;

// Captures waiting to be picked up by the result page, keyed by id.
const pending = new Map();
let lastCaptureAt = 0;
let busy = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "capture") {
    if (busy) {
      sendResponse({ ok: false, error: "A capture is already in progress." });
      return;
    }
    handleCapture(msg).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: err.message }),
    );
    return true; // keep the channel open for the async response
  }
  if (msg.type === "getCapture") {
    sendResponse(pending.get(msg.id) ?? null);
    pending.delete(msg.id);
  }
});

async function handleCapture({ mode, tabId, expand, quality }) {
  busy = true;
  try {
    const tab = await chrome.tabs.get(tabId);
    const capturer = await createCapturer(tab, quality);
    let result;
    try {
      result =
        mode === "full"
          ? await captureFullPage(tab, expand, capturer.capture)
          : await captureVisible(capturer.capture);
    } finally {
      await capturer.dispose();
    }

    const id = crypto.randomUUID();
    pending.set(id, {
      ...result,
      title: tab.title,
      url: tab.url,
      hdUnavailable: capturer.hdUnavailable,
    });
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`result.html?id=${id}`),
      index: tab.index + 1,
    });
  } finally {
    busy = false;
    chrome.action.setBadgeText({ text: "" });
  }
}

function reportProgress(done, total) {
  const percent = Math.min(100, Math.round((done / total) * 100));
  chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
  chrome.action.setBadgeText({ text: `${percent}%` });
  // The popup may already be closed; that's fine.
  chrome.runtime.sendMessage({ type: "progress", done, total }).catch(() => {});
}

// quality 1 = the screen's own pixel density via captureVisibleTab.
// quality 2/3 = re-render the tab at that density through the debugger protocol
// (Chrome shows a "started debugging this browser" bar while it runs).
async function createCapturer(tab, quality) {
  const standard = {
    capture: () => captureThrottled(tab.windowId),
    dispose: async () => {},
  };
  if (!(quality > 1)) return standard;

  const target = { tabId: tab.id };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch {
    // e.g. another extension is already debugging this tab.
    return { ...standard, hdUnavailable: true };
  }

  const dispose = async () => {
    await chrome.debugger
      .sendCommand(target, "Emulation.clearDeviceMetricsOverride")
      .catch(() => {});
    await chrome.debugger.detach(target).catch(() => {});
  };

  try {
    // width/height 0 keep the real window size; only the pixel density changes.
    await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
      width: 0,
      height: 0,
      deviceScaleFactor: quality,
      mobile: false,
    });
  } catch (err) {
    await dispose();
    throw err;
  }
  await sleep(HD_SETTLE_MS);

  return {
    capture: async () => {
      const { data } = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
      });
      return `data:image/png;base64,${data}`;
    },
    dispose,
  };
}

async function captureVisible(capture) {
  const dataUrl = await capture();
  return { frames: [{ dataUrl }] };
}

// Each frame carries "crops": rectangles (CSS px) cut from the viewport capture
// (sx, sy, sw, sh) and where they land in the final image (dx, dy).
async function captureFullPage(tab, expand, capture) {
  const run = async (func, args = []) => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func,
      args,
    });
    return result;
  };

  try {
    const page = await run(preparePage, [expand]);
    // An exception inside an injected function comes back as a null result.
    if (!page) throw new Error("Couldn't prepare this page for capture. Try turning off \"Expand scroll areas\".");
    await sleep(expand ? PREPARE_SETTLE_MS : SCROLL_SETTLE_MS);
    return page.scroller === "window"
      ? await captureWindowScroll(page, run, capture)
      : await captureElementScroll(page, run, capture);
  } finally {
    await run(restorePage);
  }
}

// The document itself scrolls (always the case once scroll areas are unrolled).
async function captureWindowScroll(page, run, capture) {
  const height = Math.min(page.height, MAX_PAGE_HEIGHT);
  const rows = countSteps(height, page.viewHeight);
  const cols = countSteps(page.width, page.viewWidth);
  const frames = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Elements that turn fixed/sticky via JS while scrolling are hidden after the
      // first frame, otherwise they'd repeat in every slice of the stitched image.
      const pos = await run(scrollPage, [
        col * page.viewWidth,
        row * page.viewHeight,
        frames.length > 0,
      ]);
      await sleep(SCROLL_SETTLE_MS);
      const dataUrl = await capture();
      frames.push({
        dataUrl,
        crops: [
          { sx: 0, sy: 0, sw: page.viewWidth, sh: page.viewHeight, dx: pos.x, dy: pos.y },
        ],
      });
      reportProgress(frames.length, rows * cols);
    }
  }

  return {
    width: cols > 1 ? page.width : page.viewWidth,
    height: rows > 1 ? height : page.viewHeight,
    viewWidth: page.viewWidth,
    truncated: page.height > MAX_PAGE_HEIGHT,
    frames,
  };
}

// Expand mode off and the window doesn't scroll: step through the main inner
// container. The final image is the viewport with that container stretched out.
async function captureElementScroll(page, run, capture) {
  const r = page.rect;
  const contentHeight = Math.min(page.scrollHeight, MAX_PAGE_HEIGHT);
  const extra = Math.max(0, contentHeight - r.height);
  const total = countSteps(contentHeight, r.height);
  const frames = [];

  for (let y = 0; ; y += r.height) {
    const pos = await run(scrollPage, [0, y, frames.length > 0]);
    await sleep(SCROLL_SETTLE_MS);
    const dataUrl = await capture();

    const crops = [];
    if (frames.length === 0) {
      // Everything around the container: above/beside it stays put, below it moves down.
      const bottom = r.top + r.height;
      crops.push(
        { sx: 0, sy: 0, sw: page.viewWidth, sh: bottom, dx: 0, dy: 0 },
        { sx: 0, sy: bottom, sw: page.viewWidth, sh: page.viewHeight - bottom, dx: 0, dy: bottom + extra },
      );
    }
    crops.push({ sx: r.left, sy: r.top, sw: r.width, sh: r.height, dx: r.left, dy: r.top + pos.y });

    const stuck = frames.length > 0 && pos.y === frames.at(-1).scrollY;
    frames.push({ dataUrl, crops, scrollY: pos.y });
    reportProgress(Math.min(frames.length, total), total);
    if (pos.y + r.height >= contentHeight || stuck) break;
  }

  return {
    width: page.viewWidth,
    height: page.viewHeight + extra,
    viewWidth: page.viewWidth,
    truncated: page.scrollHeight > MAX_PAGE_HEIGHT,
    frames,
  };
}

function countSteps(length, step) {
  return length - step > OVERFLOW_TOLERANCE ? Math.ceil(length / step) : 1;
}

async function captureThrottled(windowId) {
  const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Functions below are injected into the page; they must be self-contained. ---

function preparePage(expand) {
  const root = document.documentElement;
  const body = document.body;
  const state = {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    saved: new Map(), // element -> original style attribute
    scrollPositions: [],
    hidden: [],
    scroller: null,
  };
  window.__fullpageCapture = state;

  const set = (el, props) => {
    if (!state.saved.has(el)) state.saved.set(el, el.getAttribute("style"));
    for (const [name, value] of Object.entries(props)) {
      el.style.setProperty(name, value, "important");
    }
  };
  const px = (n) => `${n}px`;

  // Every element, including those inside open and closed shadow roots
  // (Next.js dev overlay, chat widgets, web-component toasts, ...).
  // openOrClosedShadowRoot only accepts HTML elements and throws on SVG/MathML.
  const shadowRootOf = (el) => {
    if (!(el instanceof HTMLElement)) return el.shadowRoot ?? null;
    try {
      return chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot;
    } catch {
      return el.shadowRoot;
    }
  };
  state.allElements = () => {
    const out = [];
    const walk = (scope) => {
      for (const el of scope.querySelectorAll("*")) {
        out.push(el);
        const shadow = shadowRootOf(el);
        if (shadow) walk(shadow);
      }
    };
    walk(body);
    return out;
  };
  // Parent that crosses shadow boundaries.
  const parentOf = (el) => el.parentElement ?? el.getRootNode()?.host ?? null;
  state.containsDeep = (ancestor, el) => {
    for (let node = el; node; node = node.parentElement ?? node.getRootNode()?.host) {
      if (node === ancestor) return true;
    }
    return false;
  };

  set(root, { "scroll-behavior": "auto", "scrollbar-width": "none" });
  window.scrollTo(0, 0);

  const viewWidth = window.innerWidth;
  const viewHeight = window.innerHeight;
  const isSidebar = (rect) =>
    rect.height >= viewHeight * 0.9 && rect.width <= viewWidth * 0.5;

  // One pass over the DOM: scroll areas, fixed and sticky elements.
  const scrollers = [];
  const fixed = [];
  const sticky = [];
  for (const el of state.allElements()) {
    const cs = getComputedStyle(el);
    if (cs.position === "fixed") fixed.push(el);
    else if (cs.position === "sticky") sticky.push(el);
    if (
      el.scrollHeight > el.clientHeight + 1 &&
      /^(auto|scroll|overlay)$/.test(cs.overflowY)
    ) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) scrollers.push(el);
    }
  }
  for (const el of scrollers) {
    state.scrollPositions.push([el, el.scrollLeft, el.scrollTop]);
  }

  // Sticky headers, navs, sidebars and table heads: keep them in their normal
  // spot so they appear once instead of following every slice.
  for (const el of sticky) {
    const rect = el.getBoundingClientRect();
    set(el, { position: "relative", inset: "auto" });
    if (expand && isSidebar(rect)) {
      // Let full-height sidebars stretch alongside the expanded content.
      set(el, { height: "auto", "min-height": px(rect.height), "align-self": "stretch" });
    }
  }

  const windowInfo = () => ({
    scroller: "window",
    width: Math.max(root.scrollWidth, body.scrollWidth, viewWidth),
    height: Math.max(root.scrollHeight, body.scrollHeight, viewHeight),
    viewWidth,
    viewHeight,
  });

  if (!expand) {
    // How far the window itself can actually scroll (0 when html/body are overflow:hidden).
    let windowRange = Math.max(root.scrollHeight, body.scrollHeight) - viewHeight;
    if (windowRange > 0) {
      window.scrollTo(0, 1);
      if (window.scrollY === 0) windowRange = 0;
      window.scrollTo(0, 0);
    }

    // The largest visible scroll area.
    let best = null;
    let bestArea = 0;
    for (const el of scrollers) {
      const rect = el.getBoundingClientRect();
      const visibleWidth = Math.min(rect.right, viewWidth) - Math.max(rect.left, 0);
      const visibleHeight = Math.min(rect.bottom, viewHeight) - Math.max(rect.top, 0);
      const area = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }

    const useElement =
      best &&
      bestArea > viewWidth * viewHeight * 0.25 &&
      best.scrollHeight - best.clientHeight > windowRange;
    if (!useElement) return windowInfo();

    state.scroller = best;
    set(best, { "scrollbar-width": "none", "scroll-behavior": "auto" });

    // Measure after hiding the scrollbar, and clip to the viewport.
    const rect = best.getBoundingClientRect();
    const left = Math.max(0, rect.left + best.clientLeft);
    const top = Math.max(0, rect.top + best.clientTop);
    return {
      scroller: "element",
      scrollHeight: best.scrollHeight,
      rect: {
        left,
        top,
        width: Math.min(best.clientWidth, viewWidth - left),
        height: Math.min(best.clientHeight, viewHeight - top),
      },
      viewWidth,
      viewHeight,
    };
  }

  // --- Expand mode: turn the page into one long document. ---

  const fixedRects = new Map(fixed.map((el) => [el, el.getBoundingClientRect()]));

  // Unroll every vertical scroll area and every ancestor that clips or caps its height.
  const unclipped = new Set();
  const unclip = (el) => {
    if (unclipped.has(el)) return;
    unclipped.add(el);
    const cs = getComputedStyle(el);
    const props = {
      height: "auto",
      "max-height": "none",
      "min-height": px(el.getBoundingClientRect().height),
    };
    if (cs.overflowY !== "visible") props["overflow-y"] = "visible";
    // "clip" keeps horizontal clipping without making it a scroll container again.
    if (cs.overflowX !== "visible") props["overflow-x"] = "clip";
    set(el, props);
  };
  for (const el of scrollers) {
    for (let node = el; node && node !== root; node = parentOf(node)) unclip(node);
  }
  unclip(body);
  set(root, { height: "auto", "max-height": "none", "overflow-y": "visible" });

  const docHeight = Math.max(root.scrollHeight, body.scrollHeight, viewHeight);

  // Fixed elements become absolute so they show up once instead of in every slice:
  // headers, navs and app shells stay at the top of the page; floating things in the
  // lower half of the screen (toasts, chat buttons, cookie bars, dev-error badges)
  // move to the bottom of the page, where a visitor would see them.
  const shells = new Set(
    fixed.filter((el) => scrollers.some((s) => state.containsDeep(el, s))),
  );
  for (const [el, r] of fixedRects) {
    if (r.width === 0 || r.height === 0) continue;
    const bottomAnchored =
      !shells.has(el) &&
      r.height < viewHeight * 0.5 &&
      r.top + r.height / 2 > viewHeight / 2;
    const top = bottomAnchored ? docHeight - (viewHeight - r.top) : r.top;
    set(el, {
      position: "absolute",
      top: px(top),
      left: px(r.left),
      right: "auto",
      bottom: "auto",
      width: px(r.width),
      margin: "0",
      transform: "none",
      translate: "none",
      "box-sizing": "border-box",
      ...(shells.has(el)
        ? { height: "auto", "min-height": px(r.height) }
        : { height: px(r.height) }),
    });
    // The new containing block may not start at the page origin; shift to compensate.
    const now = el.getBoundingClientRect();
    if (now.top !== top || now.left !== r.left) {
      set(el, { top: px(2 * top - now.top), left: px(2 * r.left - now.left) });
    }
  }

  // Full-height fixed sidebars run down the whole page.
  for (const [el, r] of fixedRects) {
    if (r.width > 0 && isSidebar(r)) {
      set(el, { height: "auto", "min-height": px(docHeight - r.top) });
    }
  }

  return windowInfo();
}

function scrollPage(x, y, hideFixed) {
  const state = window.__fullpageCapture;
  const scroller = state.scroller;

  if (hideFixed && !state.fixedHidden) {
    state.fixedHidden = true;
    for (const el of state.allElements()) {
      const position = getComputedStyle(el).position;
      if (position !== "fixed" && position !== "sticky") continue;
      // Never hide the app shell that contains the scrolling container.
      if (scroller && state.containsDeep(el, scroller)) continue;
      state.hidden.push([
        el,
        el.style.getPropertyValue("visibility"),
        el.style.getPropertyPriority("visibility"),
      ]);
      el.style.setProperty("visibility", "hidden", "important");
    }
  }

  // The browser clamps the last scroll position, so report where we actually are.
  if (scroller) {
    scroller.scrollTo(x, y);
    return { x: scroller.scrollLeft, y: scroller.scrollTop };
  }
  window.scrollTo(x, y);
  return { x: window.scrollX, y: window.scrollY };
}

function restorePage() {
  const state = window.__fullpageCapture;
  if (!state) return;
  for (const [el, value, priority] of state.hidden) {
    el.style.setProperty("visibility", value, priority);
  }
  for (const [el, style] of state.saved) {
    if (style === null) el.removeAttribute("style");
    else el.setAttribute("style", style);
  }
  for (const [el, left, top] of state.scrollPositions) {
    el.scrollTo({ left, top, behavior: "instant" });
  }
  window.scrollTo({ left: state.scrollX, top: state.scrollY, behavior: "instant" });
  delete window.__fullpageCapture;
}
