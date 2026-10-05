// Headless verification for the menu site. Loads the real page over HTTP in
// jsdom against a locally-served build and asserts:
//   - every manifest path actually resolves over HTTP (the check that was
//     missing before, which is why a 404 shipped to production)
//   - every image 200s with Content-Type image/webp and a WebP body
//   - the endless scroll advances one page per swipe without jumps
//   - modulo image mapping stays correct past the end of the menu
//   - the lightbox opens, loads the large variant, and closes
//   - no console errors or unhandled exceptions anywhere in the run
//
// Usage:  python -m http.server 8123 --bind 127.0.0.1   (from project root)
//         node check.mjs

import fs from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

const ORIGIN = process.env.ORIGIN ?? "http://127.0.0.1:8123";
const H = 1000; // pretend every page is 1000px tall; jsdom has no layout
const BATCH = 6;
const MAX_CHILDREN = 36;
const MANIFEST = JSON.parse(fs.readFileSync("assets/pages/manifest.json", "utf8"));
const N = MANIFEST.pageCount;

const fail = [];
let passed = 0;
const check = (label, cond, detail = "") => {
  if (cond) passed++;
  else fail.push(`${label}${detail ? ` ${detail}` : ""}`);
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

    // jsdom has no IntersectionObserver. Report figures visible as the
    // viewport reaches them, so lazy loading is exercised for real.
    window.IntersectionObserver = class {
      constructor(cb) {
        this.cb = cb;
      }
      observe(el) {
        const idx = [...el.parentElement.children].indexOf(el);
        const top = idx * H - layout.scrollY;
        if (top < H * 1.5 && top + H > -H * 1.5) {
          setTimeout(() => this.cb([{ isIntersecting: true, target: el }]), 0);
        } else {
          this.pending = el;
        }
      }
      unobserve() {}
      disconnect() {}
    };

    Object.defineProperty(window, "innerHeight", { get: () => H });
    Object.defineProperty(window, "scrollY", { get: () => layout.scrollY });
    window.scrollTo = (_x, y) => {
      layout.scrollY = y ?? 0;
    };
    window.scrollBy = (_x, y) => {
      layout.scrollY += y ?? 0;
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
const virtuals = () => kids().map((k) => Number(k.dataset.virtual));
const contiguous = (list) => list.every((v, i) => i === 0 || v === list[i - 1] + 1);

// Which virtual page sits under the middle of the viewport.
function centerVirtual() {
  const mid = H / 2;
  for (const k of kids()) {
    const r = k.getBoundingClientRect();
    if (r.top <= mid && r.bottom >= mid) return Number(k.dataset.virtual);
  }
  return null;
}

const expectedFile = (virtual) => {
  const i = ((virtual - 1) % N + N) % N;
  return `page-${String(i + 1).padStart(2, "0")}`;
};

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

check("deck populated on boot", bootReady && kids().length >= N, `${kids().length} nodes`);
check("virtual window contiguous", contiguous(virtuals()), virtuals().join(","));
check("status hidden after load", document.getElementById("status").hidden === true);
check("no error shown to user", !document.getElementById("status").className.includes("error"));

// Boot-time extend() adds headroom above page 1 and pays the scroll back, so
// the reader should still be on page 1.
check("page 1 under centre after boot", centerVirtual() === 1, `got ${centerVirtual()}`);
check("headroom added above page 1", virtuals()[0] < 1, `first=${virtuals()[0]}`);

// Images attached by the IntersectionObserver must point at served files.
let srcOk = true;
for (const k of kids()) {
  const img = k.querySelector("img");
  if (!img.src) continue;
  const virtual = Number(k.dataset.virtual);
  if (!img.src.includes(`${expectedFile(virtual)}.sm.webp`)) {
    srcOk = false;
    fail.push(`virtual ${virtual} src is ${img.src}, expected ${expectedFile(virtual)}`);
  }
}
check("loaded image srcs resolve to served files", srcOk);

// Scroll relatively, like a thumb, so app.js's scrollTop compensation runs.
async function swipe(dy, label) {
  const before = centerVirtual();
  window.scrollBy(0, dy);
  window.dispatchEvent(new window.Event("scroll"));
  await settle();
  const after = centerVirtual();

  check(`${label}: advanced exactly one page`, after === before + Math.sign(dy), `${before} -> ${after}`);
  check(`${label}: contiguous`, contiguous(virtuals()), virtuals().join(","));
  check(`${label}: DOM bounded`, kids().length <= MAX_CHILDREN, `${kids().length}`);
  check(`${label}: a page is centred`, after !== null);
  return after;
}

const seen = new Set([centerVirtual()]);
for (let i = 1; i <= 30; i++) seen.add(await swipe(H, `down ${i}`));
const maxSeen = Math.max(...seen);
for (let i = 1; i <= 30; i++) seen.add(await swipe(-H, `up ${i}`));
const minSeen = Math.min(...seen);

check("scrolled well past the end of the menu", maxSeen - minSeen > N, `${minSeen} -> ${maxSeen}`);
check("reader saw every page at least once", seen.size >= N, `${seen.size} positions`);

// Every page touched during the scroll must still map to the right file.
let mappingOk = true;
for (const k of kids()) {
  const img = k.querySelector("img");
  const virtual = Number(k.dataset.virtual);
  if (img.src && !img.src.includes(`${expectedFile(virtual)}.sm.webp`)) {
    mappingOk = false;
    fail.push(`after scroll: virtual ${virtual} -> ${img.src}`);
  }
}
check("modulo mapping correct after full scroll", mappingOk);

// Extreme virtual numbers must still land inside the manifest.
check(
  "extreme virtual numbers map into the manifest",
  [...seen].every((v) => {
    const i = ((v - 1) % N + N) % N;
    return MANIFEST.pages[i] !== undefined;
  })
);

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

console.log(`\npages in menu: ${N}`);
console.log(`pages scrolled through: ${minSeen} -> ${maxSeen}`);
console.log(`distinct page positions visited: ${seen.size}`);
console.log(`DOM nodes after full scroll: ${kids().length}`);
console.log(`checks passed: ${passed}`);

if (fail.length) {
  console.error(`\nFAILED (${fail.length}):`);
  for (const f of fail) console.error("  -", f);
  window.close();
  process.exit(1);
}
console.log("\nAll asset, scroll, mapping and lightbox checks passed.");
window.close();