// Headless verification for the menu site. Loads the real page over HTTP in
// jsdom against a locally-served build and asserts:
//   - every manifest path actually resolves over HTTP (the check that was
//     missing before, which is why a 404 shipped to production)
//   - every image 200s with Content-Type image/webp and a WebP body
//   - the deck is exactly the menu: 11 pages, in order, and never spliced
//   - every image has its source attached at boot, with no observer involved
//   - scrolling runs 1..11 without jumps, and stops cleanly at both ends
//   - reaching the bottom wraps back to page 1
//   - the wrap cooldown blocks the momentum re-wrap that would bounce the page
//   - the page counter tracks the page being read
//   - the lightbox opens, loads the large variant, and closes
//   - no console errors or unhandled exceptions anywhere in the run
//
// jsdom has no layout engine, so page geometry, scroll clamping and document
// height are all synthesised here. That matters most for the wrap assertions:
// they only mean anything if scrollHeight and the scroll clamp behave like a
// real browser.
//
// Usage:  python -m http.server 8123 --bind 127.0.0.1   (from project root)
//         node check.mjs

import fs from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

const ORIGIN = process.env.ORIGIN ?? "http://127.0.0.1:8123";
const H = 1000; // pretend every page is 1000px tall; jsdom has no layout
const BOTTOM_PAD = 88; // body padding-bottom reserving room for the FAB
const MANIFEST = JSON.parse(fs.readFileSync("assets/menu.json", "utf8"));
const N = MANIFEST.pageCount;

// app.js reads scrollHeight to decide the reader has hit the end. jsdom has
// no layout, so synthesise the document height from the fake page size and
// clamp scrolling the way a real browser would. Without the clamp, atBottom()
// would compare against a bogus number and the wrap assertions would pass
// without proving anything.
const docHeight = () => N * H + BOTTOM_PAD;
const maxScroll = () => Math.max(0, docHeight() - H);
const WRAP_COOLDOWN_MS = 700; // must match app.js

const fail = [];
let passed = 0;
const check = (label, cond, detail = "") => {
  if (cond) passed++;
  else fail.push(`${label}${detail ? ` ${detail}` : ""}`);
};

// Print the tally and the failures, then set the exit code. Shared so an
// early abort still reports instead of dying on an unrelated TypeError.
const report = (extra = {}) => {
  console.log(`\npages in menu: ${N}`);
  console.log(`distinct pages visited: ${seen.size}`);
  console.log(`DOM nodes after full scroll: ${kids().length}`);
  console.log(`checks passed: ${passed}`);
  for (const [k, v] of Object.entries(extra)) console.log(`${k}: ${v}`);
  if (fail.length) {
    console.error(`\nFAILED (${fail.length}):`);
    for (const f of fail) console.error("  -", f);
  }
  if (window) window.close();
  process.exit(fail.length ? 1 : 0);
};

// --- 1. every asset the manifest names must actually be served -------------
console.log(`checking ${N} pages over HTTP at ${ORIGIN}`);

const contentTypes = new Map();
for (const page of MANIFEST.pages) {
  for (const key of ["small", "large"]) {
    const url = `${ORIGIN}/${page[key]}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      check(`GET ${page[key]} reachable`, false, e.message);
      continue;
    }
    check(`GET ${page[key]} returns 200`, res.status === 200, `got ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    // Python's http.server has no mapping for .webp and sends octet-stream;
    // Vercel sends image/webp. Reject only text/html, which would mean we are
    // looking at an error page. The magic-byte check below is what really
    // proves the body is an image.
    const acceptable = type.startsWith("image/webp") || type.startsWith("application/octet-stream");
    check(`GET ${page[key]} is not an HTML error page`, acceptable, type);
    contentTypes.set(key, type);
    const body = Buffer.from(await res.arrayBuffer());
    check(`GET ${page[key]} has a body`, body.length > 1000, `${body.length} B`);
    // RIFF....WEBP magic: proves it is a real image, not an HTML error page.
    check(
      `GET ${page[key]} is a valid WebP`,
      body.subarray(0, 4).toString("ascii") === "RIFF" &&
        body.subarray(8, 12).toString("ascii") === "WEBP",
      body.subarray(0, 12).toString("ascii")
    );
  }
}

// The noscript block used to duplicate these paths by hand; confirm no stale
// markup is left pointing anywhere.
const html = await (await fetch(`${ORIGIN}/index.html`)).text();
check("index.html has no noscript page markup", !/page-\d\d\.(sm|lg)\.webp/.test(html));
check("index.html keeps a noscript fallback", html.includes("<noscript>"));

// app.js fetches the manifest at runtime, so a bad path or a caching policy
// that hides a correction takes the whole menu down silently. This file was once
// served immutable for a year while naming image paths that 404'd, and every
// page then sat at opacity 0 with no error on screen.
const menuRes = await fetch(`${ORIGIN}/assets/menu.json`);
check("manifest is reachable over HTTP", menuRes.ok, `status=${menuRes.status}`);
const menu = await menuRes.json().catch(() => null);
check("manifest parses as JSON", menu !== null);
check("manifest lists every page", menu?.pageCount === N, `pageCount=${menu?.pageCount} expected=${N}`);

const menuCC = String(menuRes.headers.get("cache-control") ?? "");
// Only enforced against a real host, since the local static server sets none.
if (menuCC) {
  check("manifest is never cached immutably", !/immutable/i.test(menuCC), `cache-control="${menuCC}"`);
}

check(
  "manifest names images relative to the site root",
  MANIFEST.pages.every((p) => p.small.startsWith("assets/pages/") && p.large.startsWith("assets/pages/")),
  MANIFEST.pages[0].small
);

// --- 2. drive the page ------------------------------------------------------
const layout = { scrollY: 0 };
const consoleErrors = [];

const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (e) => {
  if (!/Not implemented/.test(e.message)) consoleErrors.push(e.message);
});
virtualConsole.on("error", (...args) => consoleErrors.push(args.join(" ")));

const dom = await JSDOM.fromURL(`${ORIGIN}/index.html`, {
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    // Let app.js use the real fetch instead of a disk-reading stub. Anything
    // it requests must come off the wire, so a bad path cannot pass.
    window.fetch = (url, opts) => fetch(new URL(url, ORIGIN), opts);

    // app.js now uses native loading="lazy" with src set up front, so there is no
    // IntersectionObserver to fake. That is deliberate: the previous version
    // drove loading from an observer, this file stubbed the observer out, and
    // the result was a green suite that could not see a page which never
    // loaded. Anything needing a real rendering engine lives in
    // check-browser.mjs instead.

    // jsdom has no layout and reports a root scrollHeight of 0, which would
    // make app.js's atBottom() bail out and never wrap. Define it on
    // Element.prototype, which is where jsdom actually keeps scrollHeight.
    Object.defineProperty(window.Element.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this === window.document.documentElement ? docHeight() : 0;
      },
    });

    Object.defineProperty(window, "innerHeight", { get: () => H });
    Object.defineProperty(window, "scrollY", { get: () => layout.scrollY });
    window.scrollTo = (_x, y) => {
      layout.scrollY = Math.min(Math.max(y ?? 0, 0), maxScroll());
    };
    window.scrollBy = (_x, y) => {
      window.scrollTo(0, layout.scrollY + (y ?? 0));
    };

    Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return this.classList?.contains("page") ? H : 0;
      },
    });
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      const siblings = this.parentElement ? [...this.parentElement.children] : [this];
      const i = siblings.indexOf(this);
      const top = i * H - layout.scrollY;
      return {
        top,
        bottom: top + H,
        left: 0,
        right: 900,
        width: 900,
        height: H,
        x: 0,
        y: top,
      };
    };
  },
});

const { window } = dom;
const { document } = window;
const deck = document.getElementById("deck");

const tick = () => new Promise((r) => setTimeout(r, 40));
const kids = () => [...deck.children];
const indices = () => kids().map((k) => Number(k.dataset.index));
const counterText = () => document.getElementById("page-counter").textContent;
// Declared here rather than beside the first use so the abort path can report.
const seen = new Set();

// The deck is exactly the menu: pages 1..N, in order, and never changing.
const inOrder = (list) => list.every((v, i) => v === i + 1);

// Which page sits under the middle of the viewport.
function centrePage() {
  const mid = H / 2;
  for (const k of kids()) {
    const r = k.getBoundingClientRect();
    if (r.top <= mid && r.bottom >= mid) return Number(k.dataset.index);
  }
  return null;
}

const expectedFile = (index) => `page-${String(index).padStart(2, "0")}`;

async function settle() {
  await tick();
  await new Promise((r) => window.requestAnimationFrame(() => r()));
  await tick();
}

// Wait for a condition instead of a fixed delay: over the network the manifest
// fetch can take longer than any reasonable sleep, and asserting too early
// reports an empty deck as a site failure.
async function waitFor(label, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await settle();
  }
  fail.push(`${label} (timed out after ${timeoutMs}ms)`);
  return false;
}

const bootReady = await waitFor("deck populated on boot", () => kids().length > 0);
// The deck is appended before onScroll paints the counter, so a populated deck
// can still be one frame behind. Asserting early made this check flaky.
await settle();
await settle();

check("deck populated on boot", bootReady && kids().length === N, `${kids().length} nodes`);
check("pages are 1..N in document order", inOrder(indices()), indices().join(","));
check("status hidden after load", document.getElementById("status").hidden === true);
check("no error shown to user", !document.getElementById("status").className.includes("error"));
check("page counter revealed after boot", document.getElementById("page-counter").hidden === false);
check("end-of-menu footer revealed", document.getElementById("deck-end").hidden === false);
check("counter seeded on page 1", counterText() === `Page 1 of ${N}`, counterText());

// Everything below this point drives the deck. If boot never happened there is
// nothing to drive, and dereferencing it used to abort with a raw stack trace
// instead of reporting -- which is a poor way to learn that a deploy broke the
// menu, and the whole reason this suite exists.
if (!bootReady || kids().length !== N) {
  report({ boot: "failed, skipped the interaction checks" });
}

// Nothing is spliced above page 1 any more, so the reader starts on it.
check("page 1 under centre after boot", centrePage() === 1, `got ${centrePage()}`);
check("no headroom prepended above page 1", indices()[0] === 1, `first=${indices()[0]}`);

// The regression that mattered: every image must have its source attached the
// moment the figure exists, with no observer callback in between. If these can
// ever be false, a browser that skips the callback renders a blank menu with
// no error to show for it.
const srcAtBoot = kids().filter((k) => {
  const img = k.querySelector("img");
  return img && img.getAttribute("src") && img.getAttribute("srcset");
});
check("every image has src at boot", srcAtBoot.length === N, `${srcAtBoot.length}/${N}`);
check(
  "every image is natively lazy",
  kids().every((k) => k.querySelector("img").getAttribute("loading") === "lazy")
);
check(
  "every page carries its blurred placeholder",
  kids().every((k) => (k.style.backgroundImage || "").includes("data:image/webp"))
);
check(
  "no page still depends on an observer",
  kids().every((k) => k.dataset.observed === undefined),
  kids().map((k) => k.dataset.observed).join(",")
);

// Scroll relatively, like a thumb, through every page in order.
async function swipe(dy, label) {
  const before = centrePage();
  const size = kids().length;
  window.scrollBy(0, dy);
  window.dispatchEvent(new window.Event("scroll"));
  await settle();
  check(`${label}: centred on a page`, centrePage() !== null);
  check(`${label}: deck size unchanged`, kids().length === size, `${kids().length}`);
  check(`${label}: counter tracks the page`, counterText() === `Page ${centrePage()} of ${N}`, counterText());
  return { before, after: centrePage() };
}

seen.add(centrePage());
for (let i = 1; i < N; i++) {
  const { before, after } = await swipe(H, `down ${i}`);
  check(`down ${i}: advanced exactly one page`, after === before + 1, `${before} -> ${after}`);
  seen.add(after);
}
check("reader reached the last page", centrePage() === N, `got ${centrePage()}`);
check("reader saw every page in order", seen.size === N, `${seen.size} positions`);
check("deck still holds exactly N pages after scrolling", kids().length === N, `${kids().length}`);
check("scrolling up from the last page does not wrap", layout.scrollY > 0, `scrollY=${layout.scrollY}`);

for (let i = 1; i < N; i++) {
  const { before, after } = await swipe(-H, `up ${i}`);
  check(`up ${i}: went back exactly one page`, after === before - 1, `${before} -> ${after}`);
}
check("scrolling up past page 1 stops at the top", layout.scrollY === 0, `scrollY=${layout.scrollY}`);
check("reader is back on page 1", centrePage() === 1, `got ${centrePage()}`);

// Sources are attached at construction now, so nothing here depends on a
// page having passed the viewport. Assert the mapping holds regardless.
let mappingOk = true;
for (const k of kids()) {
  const img = k.querySelector("img");
  const index = Number(k.dataset.index);
  if (!img.src.includes(`${expectedFile(index)}.sm.webp`)) {
    mappingOk = false;
    fail.push(`page ${index} src is ${img.src}, expected ${expectedFile(index)}`);
  }
  if (!img.srcset.includes(`${expectedFile(index)}.lg.webp`)) {
    mappingOk = false;
    fail.push(`page ${index} srcset is missing the large variant`);
  }
}
check("each page maps to its own served file", mappingOk);

// Reaching the end sends the reader back to the top.
async function jumpToBottom() {
  window.scrollTo(0, maxScroll());
  window.dispatchEvent(new window.Event("scroll"));
  await settle();
  return layout.scrollY;
}

check("wrap fires at the bottom", (await jumpToBottom()) === 0, `scrollY=${layout.scrollY}`);
check("wrap resets the counter to page 1", counterText() === `Page 1 of ${N}`, counterText());
check("wrap leaves the deck untouched", kids().length === N, `${kids().length}`);

// Momentum keeps firing scroll events after the jump and, on iOS, keeps
// travelling too. A second hit inside the cooldown must not re-wrap or the
// page bounces down the menu again.
check("cooldown blocks an immediate re-wrap", (await jumpToBottom()) === maxScroll(), `scrollY=${layout.scrollY}`);

await new Promise((r) => setTimeout(r, WRAP_COOLDOWN_MS + 200));
check("wrap fires again once the cooldown expires", (await jumpToBottom()) === 0, `scrollY=${layout.scrollY}`);

// The end-of-menu button does the same thing on demand.
window.scrollTo(0, maxScroll() - 4000);
await settle();
document.getElementById("back-to-top").dispatchEvent(new window.Event("click", { bubbles: true }));
await settle();
check("back-to-top button returns to the top", layout.scrollY === 0, `scrollY=${layout.scrollY}`);

// --- 3. lightbox -----------------------------------------------------------
const firstImg = deck.querySelector(".page img");
firstImg.dispatchEvent(new window.Event("click", { bubbles: true }));
await settle();

const lb = document.getElementById("lightbox");
const lbImg = document.getElementById("lightbox-img");
check("lightbox opens on tap", lb.hidden === false);
check("lightbox uses the large variant", /\.lg\.webp$/.test(lbImg.getAttribute("src") ?? ""), lbImg.getAttribute("src"));
check("lightbox image has alt text", (lbImg.alt ?? "").length > 0);
check("body scroll locked while open", document.documentElement.style.overflow === "hidden");

const lbRes = await fetch(new URL(lbImg.getAttribute("src"), ORIGIN));
check("lightbox image serves over HTTP", lbRes.status === 200, `got ${lbRes.status}`);
check(
  "lightbox image is a valid WebP",
  Buffer.from(await lbRes.arrayBuffer()).subarray(8, 12).toString("ascii") === "WEBP"
);

document.querySelector(".lightbox__close").dispatchEvent(new window.Event("click", { bubbles: true }));
await settle();
check("lightbox closes", lb.hidden === true);
check("scroll lock released", document.documentElement.style.overflow === "");

// --- 4. nothing threw ------------------------------------------------------
check("no console errors during the run", consoleErrors.length === 0, consoleErrors.join(" | "));

report();

if (!fail.length) console.log("\nAll asset, scroll, wrap and lightbox checks passed.");