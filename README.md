# Davels Kitchen — menu site

The menu PDF, published as a scrolling web page. Scanning the QR code on a
table card lands here; you scroll through the 11 pages, and reaching the end
sends you back to the top so browsing never dead-ends.

Plain HTML, CSS and one small JavaScript file. No framework, no build step on
Vercel.

## Updating the menu

1. Replace the PDF in this folder. The script picks up the only PDF it finds.
2. Re-render the images:

   ```
   python scripts/render-pages.py
   ```

3. Commit and deploy. Vercel serves the static output as-is.

`scripts/render-pages.py` needs PyMuPDF and Pillow:

```
pip install pymupdf pillow
```

After rendering it verifies that every path it wrote into the manifest resolves
to a real file from the site root, and exits non-zero if not. Manifest paths are
relative to the site root because the browser resolves them against the document
URL, not against the manifest's own folder.

## Verifying

`scripts/check-site.mjs` serves nothing itself, so start a server first:

```
python -m http.server 8123 --bind 127.0.0.1
npm install jsdom
node scripts/check-site.mjs
```

It makes real HTTP requests for all 22 images and asserts each one 200s and
carries a valid WebP body, then drives the page through every page asserting
the deck holds exactly 11 figures and never changes size, that scrolling runs
1..11 without jumps and stops cleanly at both ends, that the bottom wraps back
to page 1 and then respects its cooldown, and that the lightbox opens and
closes. jsdom has no layout engine, so it synthesises page geometry, scroll
clamping and document height itself — without a clamped `scrollHeight` the
wrap assertions would pass without proving anything.

## Verifying in a real browser

```
python -m http.server 8123 --bind 127.0.0.1
node scripts/check-browser.mjs
```

`check-site.mjs` runs in jsdom, which has no rendering engine and therefore
cannot tell you whether a page is *visible*. That gap is not hypothetical: the
menu once loaded images from an `IntersectionObserver` callback, the jsdom suite
stubbed that observer out, and the suite stayed green while a browser which
never delivered the callback rendered an empty page. So anything that needs
pixels lives in this script instead.

It drives Chrome or Edge over the DevTools protocol (no npm dependencies —
Node's global `fetch` and `WebSocket`) and asserts that images actually decode
(`naturalWidth > 0`) and are not stuck at `opacity: 0`, that they decode as you
scroll, that the wrap works, and that the console stays clean. Set `CHROME_PATH`
if the browser is somewhere unusual, or `ORIGIN` to point at a deployed URL.

Do not verify this site with `chrome --headless --dump-dom` or
`--screenshot`. Both imply `--virtual-time-budget`, which skips the rendering
lifecycle, so `IntersectionObserver` never fires and lazy loading never runs.
That combination reports a completely blank menu for a site that renders
perfectly in front of a person.

Set `ORIGIN` on either script to check a deployed URL instead.

## Deploying

```
vercel
vercel --prod
```

The source PDF and the `scripts/` folder are excluded from the upload via
`.vercelignore`, so the deploy payload is roughly 5.8 MB.

Production is <https://dabels-menu.vercel.app>. Vercel is connected to the
GitHub repo, so pushing to `main` redeploys automatically.

Once you have the final URL, generate a QR code pointing at
`https://dabels-menu.vercel.app` and print it for the table cards.

### Caching, and what not to cache

`vercel.json` serves `assets/pages/` as `immutable` for a year. That is safe
for the images and only for the images: their filenames are fixed, so a given
URL always means the same bytes.

`assets/menu.json` is the exception and is deliberately **not** in that
directory. It lists the image paths, so a manifest cached too long stops a
corrected menu from reaching anyone. This is not hypothetical — `vercel.json`
once cached `assets/pages/manifest.json` for a year, and a manifest published
with image paths missing the `assets/` prefix was pinned in browsers and at the
edge. Every image then 404'd, `app.js` had no `error` handler, and every page sat
at `opacity: 0`: a permanently blank menu with no error on screen. The
pre-commit before it worked, which is what made it so confusing to diagnose.

Two rules keep that from recurring. Never put a file whose contents can change
behind the `immutable` rule, and never let an image reach `opacity: 0` without
an `error` path that reveals it anyway.

## Local preview

Any static file server works, but fetch the manifest over HTTP rather than
opening the file directly:

```
python -m http.server 8000
```

Then open `http://localhost:8000`. To test on a phone, use your machine's LAN
address and bind to all interfaces:

```
python -m http.server 8000 --bind 0.0.0.0
```

## How it works

| Piece | File | Role |
| --- | --- | --- |
| Pages | `assets/pages/` | WebP per page at 144 and 216 dpi |
| Manifest | `assets/menu.json` | Page count, dimensions, alt text, placeholders |
| Shell | `index.html` | Page container, call button, counter, end-of-menu footer, lightbox markup |
| Styles | `assets/styles.css` | Layout, fit-to-width pages, button, overlay |
| Behaviour | `assets/app.js` | Lazy loading, end-of-menu wrap, zoom |

The deck is exactly the menu: 11 figures rendered once, numbered 1..11 by
`data-index`. Nothing is spliced in or trimmed out while the reader scrolls,
which is what keeps the scroll smooth — an earlier version kept a sliding
window of pages and corrected `scrollTop` by the height it had inserted, and
that fought the browser's own scroll anchoring and made the page judder.

Images use native `loading="lazy"` with `src` attached as the figure is built,
so the browser defers the fetch without any JavaScript having to notice. An
earlier version attached sources from an `IntersectionObserver` callback,
which made a page invisible if that callback never arrived and left no error
to explain the blank page. The blurred placeholder is painted on the figure
rather than the image, because the image is transparent until it has loaded,
and a `load` *or* `error` event reveals it so a 404 cannot leave a blank box.

The only scroll handler updates the "Page X of 11" counter and, when the
reader reaches the bottom, jumps back to the top. That jump is instant rather
than animated, since it often spans fifteen thousand pixels. It is also rate
limited by `WRAP_COOLDOWN`: momentum scrolling keeps firing scroll events
afterwards, and on iOS it keeps travelling too, so without the cooldown the
page would bounce straight back down. Page 1 is a hard stop — scrolling up
past it does nothing.