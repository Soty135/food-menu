"""Render the menu PDF into responsive WebP pages plus a JSON manifest.

Run from the project root:

    python scripts/render-pages.py

Produces:
    assets/pages/page-01.sm.webp   (144 dpi, phone)
    assets/pages/page-01.lg.webp   (216 dpi, retina / zoom)
    assets/menu.json              (count, dimensions, alt text, placeholders)
"""

import base64
import io
import json
import re
import sys
from pathlib import Path

import fitz
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PDF_PATH = next(
    (p for p in sorted(ROOT.glob("*.pdf"))),
    None,
)
OUT_DIR = ROOT / "assets" / "pages"

SMALL_DPI = 144
LARGE_DPI = 216
QUALITY = 82
LQIP_WIDTH = 20
LQIP_QUALITY = 45

# Lines that appear on every page and make poor alt text.
SKIP_LINES = {
    "food menu",
    "davels kitchen",
    "dabels_kitchen",
    "delivery order",
    "website coming soon",
    "sp - $",
    "lp - $",
    "c - $",
}


def first_meaningful_line(page):
    """Best-guess dish name for a page, used as image alt text."""
    for raw in page.get_text().splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if len(line) < 3:
            continue
        if line.lower() in SKIP_LINES:
            continue
        if line.lower().startswith(("sp -", "lp -", "c -", "+")):
            continue
        if re.fullmatch(r"[\d\s$.,-]+", line):
            continue
        return line.title()
    return f"Menu page"


def lqip_data_uri(img):
    """Tiny blurred base64 WebP so pages fade in instead of popping."""
    height = max(1, round(img.height * LQIP_WIDTH / img.width))
    small = img.resize((LQIP_WIDTH, height), Image.LANCZOS)
    small = small.filter(ImageFilter.GaussianBlur(1))
    buf = io.BytesIO()
    small.save(buf, "WEBP", quality=LQIP_QUALITY)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def verify_paths(pages):
    """Fail loudly if a manifest path does not resolve to a real file.

    The manifest is written to be read by the browser relative to the site
    root, so a path can be perfectly correct JSON and still 404. Checking it
    here catches that before it ever reaches a customer.
    """
    missing = []
    for page in pages:
        for key in ("small", "large"):
            if not (ROOT / page[key]).is_file():
                missing.append(f"page {page['index']} {key} -> {page[key]}")

    if missing:
        sys.exit(
            "Manifest paths do not resolve from the site root:\n  "
            + "\n  ".join(missing)
        )


def main():
    if PDF_PATH is None:
        sys.exit("No PDF found in project root.")

    doc = fitz.open(PDF_PATH)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    pages = []
    small_total = large_total = 0

    for index, page in enumerate(doc):
        number = index + 1
        stem = f"page-{number:02d}"

        sm_pix = page.get_pixmap(dpi=SMALL_DPI)
        sm_img = Image.frombytes("RGB", (sm_pix.width, sm_pix.height), sm_pix.samples)
        lg_pix = page.get_pixmap(dpi=LARGE_DPI)
        lg_img = Image.frombytes("RGB", (lg_pix.width, lg_pix.height), lg_pix.samples)

        sm_path = OUT_DIR / f"{stem}.sm.webp"
        lg_path = OUT_DIR / f"{stem}.lg.webp"

        sm_img.save(sm_path, "WEBP", quality=QUALITY, method=4)
        lg_img.save(lg_path, "WEBP", quality=QUALITY, method=4)

        small_total += sm_path.stat().st_size
        large_total += lg_path.stat().st_size

        pages.append(
            {
                "index": number,
                # Paths are relative to the site root, not to this manifest,
                # because the browser resolves them against the document URL.
                "small": f"assets/pages/{stem}.sm.webp",
                "large": f"assets/pages/{stem}.lg.webp",
                "width": sm_img.width,
                "height": sm_img.height,
                "largeWidth": lg_img.width,
                "largeHeight": lg_img.height,
                "alt": f"{first_meaningful_line(page)} - menu page {number} of {doc.page_count}",
                "placeholder": lqip_data_uri(sm_img),
            }
        )

        print(f"  page {number:>2}/{doc.page_count}  {sm_path.name} {sm_path.stat().st_size // 1024} KB  {lg_path.name} {lg_path.stat().st_size // 1024} KB")

    manifest = {
        "source": PDF_PATH.name,
        "pageCount": doc.page_count,
        "aspectRatio": round(doc[0].rect.width / doc[0].rect.height, 6),
        "pages": pages,
    }
    verify_paths(pages)

    # Written outside assets/pages/ on purpose. vercel.json serves that whole
    # directory as immutable for a year, which is right for the images because
    # their filenames are fixed, but it would pin this manifest too and stop a
    # re-rendered menu from ever reaching a returning visitor.
    manifest_path = ROOT / "assets" / "menu.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"\n  {doc.page_count} pages -> {OUT_DIR}")
    print("  all manifest paths verified against disk")
    print(f"  sm total {small_total / 1048576:.2f} MB")
    print(f"  lg total {large_total / 1048576:.2f} MB")
    print(f"  manifest {manifest_path}")


if __name__ == "__main__":
    main()