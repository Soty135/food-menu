# Davels Kitchen — menu site

The menu PDF, published as a continuously scrolling web page. Scanning the QR
code on a table card lands here; scrolling moves through the 11 pages and loops
back to page 1, so it never ends.

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
carries a valid WebP body, then drives the page through 60 swipes asserting the
scroll advances one page at a time, the modulo image mapping stays correct past
page 11, and the lightbox opens and closes. Set `ORIGIN` to point it at a
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
| Shell | `index.html` | Page container, call button, lightbox markup |
| Styles | `assets/styles.css` | Layout, fit-to-width pages, button, overlay |
| Behaviour | `assets/app.js` | Lazy loading, page wrapping, zoom |

Only 11 pages exist, so the endless scroll is virtual: `app.js` tracks a virtual
page number and splices in more figures as the reader nears either end, mapping
image sources back to the 11 originals with modulo arithmetic. After a splice
above the viewport it corrects `scrollTop` by the height it added, so the page
under the reader's thumb never moves. Pages far from the reader are trimmed to
keep the DOM bounded.