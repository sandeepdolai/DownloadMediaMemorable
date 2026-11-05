from pathlib import Path
from zipfile import ZipFile
from PIL import Image, ImageDraw, ImageFont
import json

ARCHIVE = Path("memorableday_assets.zip")
OUTPUT = Path("asset-inspection")
OUTPUT.mkdir(exist_ok=True)

with ZipFile(ARCHIVE) as zf:
    files = [i for i in zf.infolist() if not i.is_dir()]
    entries = []
    image_groups = {"transparent_png": [], "high_res_renders": [], "other_images": []}

    for info in files:
        name = info.filename
        suffix = Path(name).suffix.lower()
        record = {"path": name, "size_bytes": info.file_size}
        entries.append(record)

        if suffix == ".png" and "png_cutouts_transparent/" in name:
            image_groups["transparent_png"].append(name)
        elif suffix in {".jpg", ".jpeg"} and "high_res_original_renders/" in name:
            image_groups["high_res_renders"].append(name)
        elif suffix in {".png", ".jpg", ".jpeg", ".webp"}:
            image_groups["other_images"].append(name)

    inventory = {
        "archive": ARCHIVE.name,
        "archive_size_bytes": ARCHIVE.stat().st_size,
        "file_count": len(files),
        "entries": entries,
        "image_groups": {key: values for key, values in image_groups.items()},
    }
    (OUTPUT / "inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")

    for group_name, names in image_groups.items():
        if not names:
            continue

        cell_w, cell_h = 250, 230
        cols = 4
        rows = (len(names) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * cell_w, rows * cell_h), "#ededed")
        draw = ImageDraw.Draw(sheet)

        for idx, name in enumerate(names):
            x = (idx % cols) * cell_w
            y = (idx // cols) * cell_h
            raw = zf.read(name)
            try:
                im = Image.open(__import__("io").BytesIO(raw)).convert("RGBA")
                im.thumbnail((cell_w - 24, cell_h - 58), Image.Resampling.LANCZOS)
                preview = Image.new("RGBA", im.size, "white")
                preview.alpha_composite(im)
                sheet.paste(preview.convert("RGB"), (x + (cell_w - im.width)//2, y + 8))
                label = Path(name).name
                draw.text((x + 8, y + cell_h - 42), label[:34], fill="#111")
                draw.text((x + 8, y + cell_h - 23), f"{Image.open(__import__('io').BytesIO(raw)).size[0]} × {Image.open(__import__('io').BytesIO(raw)).size[1]}", fill="#555")
            except Exception as exc:
                draw.text((x + 8, y + 8), f"Cannot preview: {name}", fill="#900")
                draw.text((x + 8, y + 30), str(exc)[:30], fill="#900")

        sheet.save(OUTPUT / f"{group_name}.jpg", quality=92)

    # Export original transparent artwork and the full-resolution section mockup
    export_dir = OUTPUT / "source-materials"
    export_dir.mkdir(exist_ok=True)
    selected = image_groups["transparent_png"] + [
        "high_res_original_renders/website_ui_mockup_bottom_section.jpg",
        "high_res_original_renders/website_ui_mockup_full_page.jpg",
    ]
    for name in selected:
        target = export_dir / Path(name).name
        target.write_bytes(zf.read(name))

    (OUTPUT / "inventory.txt").write_text(
        "\\n".join([f"{x['path']} ({x['size_bytes']} bytes)" for x in entries]),
        encoding="utf-8",
    )
