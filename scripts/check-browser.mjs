// Real-browser verification. jsdom has no rendering engine, so it cannot tell
// you whether a page is actually visible: it happily passes while every image
// is still invisible. That gap is not hypothetical. The menu once drove image
// loading from an IntersectionObserver, this repo's jsdom suite stubbed the
// observer out, and the suite stayed green while the deployed site could
// render an empty grey page. So the things that only a real engine can answer
// live here instead.
//
// Checks:
//   - every page's image actually decodes (naturalWidth > 0)
//   - the image in view is visible (opacity 1, not stuck at 0)
//   - images further down decode as they are scrolled to
//   - the deck stays exactly the size the menu says it is
//   - scrolling to the bottom wraps back to page 1, counter included
//   - the end-of-menu button returns to the top
//   - nothing is logged to the console and nothing throws
//
// Requires Chrome or Edge on the machine. Driven over the DevTools protocol
// with no npm dependencies, using Node's global fetch and WebSocket.
//
// Usage:  python -m http.server 8123 --bind 127.0.0.1   (from project root)
//         node scripts/check-browser.mjs
//         ORIGIN=https://dabels-menu.vercel.app node scripts/check-browser.mjs

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGIN = (process.env.ORIGIN ?? "http://127.0.0.1:8123").replace(/\/$/, "");
const PORT = 9333;
const MOBILE = { width: 390, height: 844 };
const N = JSON.parse(readFileSync("assets/menu.json", "utf8")).pageCount;

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error("No Chrome or Edge found. Set CHROME_PATH to a browser binary.");
  process.exit(2);
}

const fail = [];
let passed = 0;
const check = (label, cond, detail = "") => {
  if (cond) passed++;
  else fail.push(`${label}${detail ? ` ${detail}` : ""}`);
};

const profile = mkdtempSync(join(tmpdir(), "menu-chrome-"));
const chrome = spawn(
  browser,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--remote-debugging-port=" + PORT,
    `--user-data-dir=${profile}`,
    `--window-size=${MOBILE.width},${MOBILE.height}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

// Windows keeps the profile locked for a moment after the browser exits, so
// removing it can fail on the first attempt. It is scratch space: cleanup must
// never change the result of the run.
let tornDown = false;
async function shutdown() {
  if (tornDown) return;
  tornDown = true;
  try {
    chrome.kill();
  } catch {}
  await new Promise((r) => setTimeout(r, 400));
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  console.warn(`could not remove scratch profile ${profile}; delete it by hand`);
}

process.on("exit", () => {
  if (tornDown) return;
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
});

// Wait for the DevTools endpoint rather than sleeping a fixed amount.
let version = null;
for (let i = 0; i < 60 && !version; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch {}
}
if (!version) {
  console.error(`Could not reach DevTools on port ${PORT}`);
  process.exit(2);
}
console.log(`checking ${ORIGIN} in ${version.Browser} at ${MOBILE.width}x${MOBILE.height}`);

const created = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(ORIGIN)}`, { method: "PUT" })
).json();
const ws = new WebSocket(created.webSocketDebuggerUrl);

let seq = 0;
const pending = new Map();
const problems = [];

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    return msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
  if (msg.method === "Log.entryAdded" && ["error", "warning"].includes(msg.params.entry.level)) {
    problems.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    problems.push(`[exception] ${d.exception?.description ?? d.text}`);
  }
};

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.navigate", { url: ORIGIN });

// Real wall-clock time, not --virtual-time-budget: virtual time skips the
// rendering lifecycle, which is exactly why an earlier headless run showed a
// blank menu that a real browser renders perfectly.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(6000);

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate threw");
  return r.result.value;
};

const PROBE = `(() => {
  const figs = [...document.querySelectorAll("#deck figure.page")];
  const imgs = figs.map((f) => f.querySelector("img"));
  return {
    figures: figs.length,
    withSrc: imgs.filter((i) => i.getAttribute("src")).length,
    lazy: imgs.filter((i) => i.getAttribute("loading") === "lazy").length,
    decoded: imgs.filter((i) => i.naturalWidth > 0).length,
    visible: imgs.filter((i) => getComputedStyle(i).opacity === "1").length,
    firstNaturalWidth: imgs[0]?.naturalWidth ?? 0,
    firstOpacity: imgs[0] ? getComputedStyle(imgs[0]).opacity : null,
    placeholders: figs.filter((f) => (f.style.backgroundImage || "").includes("data:image")).length,
    statusHidden: document.getElementById("status")?.hidden,
    statusText: document.getElementById("status")?.textContent.trim().slice(0, 80),
    counter: document.getElementById("page-counter")?.textContent,
    counterVisible: !document.getElementById("page-counter")?.hidden,
    scrollY: Math.round(window.scrollY),
    maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
  };
})()`;

const POSITION = `(() => {
  const figs = [...document.querySelectorAll("#deck figure.page")];
  const mid = window.innerHeight / 2;
  let centred = null;
  for (const f of figs) {
    const r = f.getBoundingClientRect();
    if (r.top <= mid && r.bottom >= mid) { centred = Number(f.dataset.index); break; }
  }
  return {
    centred,
    scrollY: Math.round(window.scrollY),
    counter: document.getElementById("page-counter").textContent,
    figures: figs.length,
  };
})()`;

const boot = await evaluate(PROBE);

check("deck rendered every page", boot.figures === N, `${boot.figures} figures`);
check("every image has a src", boot.withSrc === boot.figures, `${boot.withSrc}/${boot.figures}`);
check("every image is natively lazy", boot.lazy === boot.figures, `${boot.lazy}/${boot.figures}`);
check("every page has a blurred placeholder", boot.placeholders === boot.figures, `${boot.placeholders}/${boot.figures}`);
check("loading finished, status hidden", boot.statusHidden === true, boot.statusText);
check("page counter is visible", boot.counterVisible === true, `counter=${boot.counter}`);

// The assertion that matters most. An image with no src, or one stuck at
// opacity 0, is invisible: this is what "the pages do not show up" means.
check("the first page actually decoded pixels", boot.firstNaturalWidth > 0, `naturalWidth=${boot.firstNaturalWidth}`);
check("the first page is not stuck transparent", boot.firstOpacity === "1", `opacity=${boot.firstOpacity}`);
check("images in view have faded in", boot.visible >= 1, `${boot.visible} visible`);

// Scroll the whole menu and confirm images arrive as pages are reached.
for (let i = 0; i < 14; i++) {
  await evaluate(`window.scrollBy(0, window.innerHeight * 0.85); true`);
  await wait(280);
}
await wait(1200);
const afterScroll = await evaluate(PROBE);
check("every image decoded after scrolling through", afterScroll.decoded === afterScroll.figures, `${afterScroll.decoded}/${afterScroll.figures}`);

// The wrap. Reaching the true bottom must land back on page 1.
await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight); true`);
await wait(1200);
const wrapped = await evaluate(POSITION);
check("reaching the bottom wraps to the top", wrapped.scrollY === 0, `scrollY=${wrapped.scrollY}`);
check("wrap lands on page 1", wrapped.centred === 1, `centred=${wrapped.centred}`);
check("wrap resets the counter", wrapped.counter === `Page 1 of ${N}`, `counter=${wrapped.counter}`);
check("wrap leaves the deck intact", wrapped.figures === N, `${wrapped.figures} figures`);

await evaluate(`window.scrollTo(0, 2500); true`);
await wait(600);
await evaluate(`document.getElementById("back-to-top").click(); true`);
await wait(800);
const viaButton = await evaluate(POSITION);
check("back-to-top button returns to page 1", viaButton.scrollY === 0 && viaButton.centred === 1, `scrollY=${viaButton.scrollY} centred=${viaButton.centred}`);

check("nothing logged to the console", problems.length === 0, problems.join(" | "));

console.log(`\nfirst page decoded: ${boot.firstNaturalWidth}px wide, opacity ${boot.firstOpacity}`);
console.log(`images decoded after scrolling: ${afterScroll.decoded}/${afterScroll.figures}`);
console.log(`document scrolls ${afterScroll.maxScroll}px before wrapping`);
console.log(`checks passed: ${passed}`);

await fetch(`http://127.0.0.1:${PORT}/json/close/${created.id}`).catch(() => {});
ws.close();
await shutdown();

if (fail.length) {
  console.error(`\nFAILED (${fail.length}):`);
  for (const f of fail) console.error("  -", f);
  process.exit(1);
}
console.log("\nAll real-browser rendering checks passed.");
process.exit(0);