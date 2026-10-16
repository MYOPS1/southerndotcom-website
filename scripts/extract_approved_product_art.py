#!/usr/bin/env python3
"""Extract approved OpsWMS/OpsHR character art from MYOPS design reference.

Run: python3 scripts/extract_approved_product_art.py
Requires Pillow: python3 -m pip install Pillow
The source screenshot is an approved visual reference, not a source for other cards.
"""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
images = root / "public" / "images"
reference = images / "myops-product-cards-approved-design-reference.png.png"
if not reference.is_file():
    raise SystemExit(f"Reference not found: {reference}")
source = Image.open(reference).convert("RGB")
if source.size != (1774, 887):
    raise SystemExit(f"Unexpected reference dimensions {source.size}; expected (1774, 887). Do not crop blindly.")

# Coordinates are measured on the approved 1774 x 887 reference.
# Crop above the overlaid badges so the website's original badges stay independent.
regions = {
    "opswms": (1050, 310, 1365, 470),
    "opshr": (1388, 310, 1711, 470),
}
for product, bounds in regions.items():
    art = source.crop(bounds).resize((760, 392), Image.Resampling.LANCZOS)
    target = images / f"{product}-card-art.png"
    art.save(target, "PNG", optimize=True)
    print(f"Created {target.relative_to(root)} ({art.width}x{art.height})")

print("Preview both crops before committing; the screenshot source limits resolution.")
