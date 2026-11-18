#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parameterized Amazon KDP ebook cover generator (1600x2560 RGB JPEG by default).
Zero hardcoded book paths or titles; wraps multi-line titles and subtitles automatically.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


THEMES = {
    "dark_fantasy": {
        "top": (10, 18, 32),
        "bottom": (4, 6, 12),
        "accent": (210, 175, 100),
        "border_outer": (180, 140, 70),
        "border_inner": (80, 90, 110),
        "title_primary": (245, 245, 245),
        "subtitle": (180, 195, 210),
        "muted": (140, 155, 175),
    },
    "crimson": {
        "top": (28, 10, 16),
        "bottom": (8, 4, 8),
        "accent": (215, 165, 95),
        "border_outer": (185, 120, 70),
        "border_inner": (110, 70, 80),
        "title_primary": (248, 242, 240),
        "subtitle": (210, 185, 185),
        "muted": (165, 135, 140),
    },
    "silver": {
        "top": (14, 18, 26),
        "bottom": (6, 8, 12),
        "accent": (195, 215, 235),
        "border_outer": (150, 175, 200),
        "border_inner": (75, 90, 110),
        "title_primary": (245, 248, 252),
        "subtitle": (185, 200, 215),
        "muted": (140, 155, 170),
    },
}


def _load_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = [
        "georgiab.ttf" if bold else "georgia.ttf",
        "timesbd.ttf" if bold else "times.ttf",
        "arialbd.ttf" if bold else "arial.ttf",
        "DejaVuSerif-Bold.ttf" if bold else "DejaVuSerif.ttf",
        "LiberationSerif-Bold.ttf" if bold else "LiberationSerif-Regular.ttf",
    ]
    search_dirs = [
        Path(r"C:\Windows\Fonts"),
        Path("/usr/share/fonts/truetype"),
        Path("/System/Library/Fonts"),
    ]
    for folder in search_dirs:
        if not folder.is_dir():
            continue
        for name in candidates:
            p = folder / name
            if p.is_file():
                try:
                    return ImageFont.truetype(str(p), size)
                except Exception:
                    pass
    return ImageFont.load_default()


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    words = (text or "").split()
    if not words:
        return []
    lines: list[str] = []
    cur = words[0]
    for w in words[1:]:
        cand = f"{cur} {w}"
        bbox = draw.textbbox((0, 0), cand, font=font)
        if (bbox[2] - bbox[0]) <= max_width:
            cur = cand
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def generate_cover(
    output_path: str | Path,
    title: str,
    author: str = "William Vance",
    subtitle: str = "",
    tagline: str = "ORIGINAL FICTION COLLECTION",
    featured: str = "",
    width: int = 1600,
    height: int = 2560,
    theme: str = "dark_fantasy",
) -> str:
    pal = THEMES.get(theme, THEMES["dark_fantasy"])
    out_file = Path(output_path).resolve()
    out_file.parent.mkdir(parents=True, exist_ok=True)

    img = Image.new("RGB", (width, height), color=pal["top"])
    draw = ImageDraw.Draw(img)

    r1, g1, b1 = pal["top"]
    r2, g2, b2 = pal["bottom"]
    for y in range(height):
        ratio = y / max(height - 1, 1)
        r = int(r1 * (1 - ratio) + r2 * ratio)
        g = int(g1 * (1 - ratio) + g2 * ratio)
        b = int(b1 * (1 - ratio) + b2 * ratio)
        draw.line([(0, y), (width, y)], fill=(r, g, b))

    margin = int(width * 0.05)
    draw.rectangle([(margin, margin), (width - margin, height - margin)], outline=pal["border_outer"], width=4)
    draw.rectangle(
        [(margin + 20, margin + 20), (width - margin - 20, height - margin - 20)],
        outline=pal["border_inner"],
        width=1,
    )

    content_w = int(width * 0.78)
    font_tag = _load_font(34, bold=True)
    font_title = _load_font(112, bold=True)
    font_sub = _load_font(44, bold=False)
    font_desc = _load_font(34, bold=False)
    font_author = _load_font(68, bold=True)

    if tagline:
        tag_lines = _wrap_text(draw, tagline.upper(), font_tag, content_w)
        ty = int(height * 0.13)
        for ln in tag_lines:
            bb = draw.textbbox((0, 0), ln, font=font_tag)
            draw.text(((width - (bb[2] - bb[0])) // 2, ty), ln, fill=pal["accent"], font=font_tag)
            ty += 48
        draw.line([(width // 2 - 250, ty + 18), (width // 2 + 250, ty + 18)], fill=pal["border_outer"], width=3)

    title_lines = _wrap_text(draw, title.upper(), font_title, content_w)
    y_cursor = int(height * 0.23)
    for idx, ln in enumerate(title_lines):
        bb = draw.textbbox((0, 0), ln, font=font_title)
        color = pal["title_primary"] if idx == 0 else pal["accent"]
        draw.text(((width - (bb[2] - bb[0])) // 2, y_cursor), ln, fill=color, font=font_title)
        y_cursor += 140

    y_cursor += 35
    draw.line([(width // 2 - 180, y_cursor), (width // 2 + 180, y_cursor)], fill=pal["border_inner"], width=2)
    y_cursor += 55

    if subtitle:
        for ln in _wrap_text(draw, subtitle, font_sub, content_w):
            bb = draw.textbbox((0, 0), ln, font=font_sub)
            draw.text(((width - (bb[2] - bb[0])) // 2, y_cursor), ln, fill=pal["subtitle"], font=font_sub)
            y_cursor += 68

    emblem_y = max(y_cursor + 180, int(height * 0.60))
    if emblem_y < int(height * 0.72):
        draw.arc(
            [(width // 2 - 150, emblem_y - 150), (width // 2 + 150, emblem_y + 150)],
            start=0,
            end=360,
            fill=pal["border_inner"],
            width=3,
        )
        draw.arc(
            [(width // 2 - 110, emblem_y - 110), (width // 2 + 110, emblem_y + 110)],
            start=0,
            end=360,
            fill=pal["border_outer"],
            width=2,
        )
        draw.polygon(
            [(width // 2, emblem_y - 72), (width // 2 + 64, emblem_y + 54), (width // 2 - 64, emblem_y + 54)],
            outline=pal["accent"],
            width=2,
        )

    if featured:
        fy = int(height * 0.75)
        for ln in _wrap_text(draw, featured.upper(), font_desc, content_w)[:3]:
            bb = draw.textbbox((0, 0), ln, font=font_desc)
            draw.text(((width - (bb[2] - bb[0])) // 2, fy), ln, fill=pal["muted"], font=font_desc)
            fy += 46

    auth_y = int(height * 0.84)
    draw.line([(width // 2 - 200, auth_y - 30), (width // 2 + 200, auth_y - 30)], fill=pal["border_outer"], width=3)
    auth_text = author.upper()
    bb_auth = draw.textbbox((0, 0), auth_text, font=font_author)
    draw.text(((width - (bb_auth[2] - bb_auth[0])) // 2, auth_y), auth_text, fill=pal["title_primary"], font=font_author)

    img.save(out_file, format="JPEG", quality=95)
    print(f"Generated KDP Cover: {out_file} ({width}x{height}, {out_file.stat().st_size} bytes)")
    return str(out_file)


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate a 1600x2560 KDP JPEG cover.")
    ap.add_argument("--out", required=True, help="Output cover .jpg path")
    ap.add_argument("--title", required=True, help="Main book title")
    ap.add_argument("--subtitle", default="", help="Optional subtitle")
    ap.add_argument("--author", default="William Vance", help="Author name")
    ap.add_argument("--tagline", default="ORIGINAL FICTION COLLECTION", help="Top tagline")
    ap.add_argument("--featured", default="", help="Optional footer story highlights")
    ap.add_argument("--width", type=int, default=1600, help="Image width (default: 1600)")
    ap.add_argument("--height", type=int, default=2560, help="Image height (default: 2560)")
    ap.add_argument("--theme", choices=sorted(THEMES.keys()), default="dark_fantasy", help="Color theme")
    args = ap.parse_args()

    generate_cover(
        output_path=args.out,
        title=args.title,
        author=args.author,
        subtitle=args.subtitle,
        tagline=args.tagline,
        featured=args.featured,
        width=args.width,
        height=args.height,
        theme=args.theme,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
