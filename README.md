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
closes. jsdom has no layout engine, so the harness synthesises page geometry,
scroll clamping and document height itself — without those the wrap
assertions would pass without proving anything. Set `ORIGIN` to point it at a
deployed URL instead.

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
| Pages | `assets/pages/` | WebP per page at 144 and 216 dpi, plus `manifest.json` |
| Shell | `index.html` | Page container, call button, counter, end-of-menu footer, lightbox markup |
| Styles | `assets/styles.css` | Layout, fit-to-width pages, button, overlay |
| Behaviour | `assets/app.js` | Lazy loading, end-of-menu wrap, zoom |

The deck is exactly the menu: 11 figures rendered once, numbered 1..11 by
`data-index`. Nothing is spliced in or trimmed out while the reader scrolls,
which is what keeps the scroll smooth — an earlier version kept a sliding
window of pages and corrected `scrollTop` by the height it had inserted, and
that fought the browser's own scroll anchoring and made the page judder.

The only scroll handler updates the "Page X of 11" counter and, when the
reader reaches the bottom, jumps back to the top. That jump is instant rather
than animated, since it often spans fifteen thousand pixels. It is also rate
limited by `WRAP_COOLDOWN`: momentum scrolling keeps firing scroll events
afterwards, and on iOS it keeps travelling too, so without the cooldown the
page would bounce straight back down. Page 1 is a hard stop — scrolling up
past it does nothing.