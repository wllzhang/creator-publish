#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parameterized Amazon KDP / international EPUB3 builder.
Supports CLI and Python import; embeds cover image properly in OPF/spine and uses deterministic UUID5.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _parse_markdown_chapters(md_path: Path) -> list[dict[str, str]]:
    text = md_path.read_text(encoding="utf-8-sig")
    chapters: list[dict[str, str]] = []
    cur_title = ""
    cur_lines: list[str] = []

    for line in text.splitlines():
        m = re.match(r"^(#{1,2})\s+(.+?)\s*$", line)
        if m:
            if cur_title or any(x.strip() for x in cur_lines):
                chapters.append({
                    "title": cur_title or f"Chapter {len(chapters) + 1}",
                    "content": "\n".join(cur_lines).strip(),
                })
            cur_title = m.group(2).strip()
            cur_lines = []
        else:
            cur_lines.append(line)

    if cur_title or any(x.strip() for x in cur_lines):
        chapters.append({
            "title": cur_title or f"Chapter {len(chapters) + 1}",
            "content": "\n".join(cur_lines).strip(),
        })
    return [c for c in chapters if c["content"] or c["title"]]


def _cover_mime_and_name(cover_path: Path) -> tuple[str, str]:
    ext = cover_path.suffix.lower()
    if ext == ".png":
        return "image/png", "cover.png"
    if ext == ".webp":
        return "image/webp", "cover.webp"
    return "image/jpeg", "cover.jpg"


def _render_paragraphs(raw_content: str) -> str:
    paragraphs: list[str] = []
    for line in (raw_content or "").splitlines():
        p_str = line.strip()
        if not p_str:
            continue
        if p_str in ("---", "***", "* * *"):
            paragraphs.append('<p class="scene-break">* * *</p>')
            continue
        escaped = html.escape(p_str)
        escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
        escaped = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", escaped)
        paragraphs.append(f"<p>{escaped}</p>")
    return "\n".join(paragraphs)


def create_epub(
    output_path: str | Path,
    title: str,
    author: str,
    language: str = "en",
    description: str = "",
    chapters: list[dict[str, str]] | None = None,
    cover_image_path: str | Path | None = None,
) -> str:
    """Build a KDP-compliant EPUB3 package with deterministic UUID5 and optional embedded cover."""
    out_file = Path(output_path).resolve()
    out_file.parent.mkdir(parents=True, exist_ok=True)
    chapters = chapters or []

    cover_path: Path | None = None
    if cover_image_path:
        cand = Path(cover_image_path).resolve()
        if not cand.is_file():
            raise FileNotFoundError(f"Cover image not found: {cand}")
        cover_path = cand

    book_uuid = str(uuid.uuid5(uuid.NAMESPACE_OID, f"{title}|{author}|{language}"))

    with zipfile.ZipFile(out_file, "w") as epub:
        # Spec: mimetype must be the first entry and stored uncompressed
        epub.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)

        container_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
            "  <rootfiles>\n"
            '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
            "  </rootfiles>\n"
            "</container>"
        )
        epub.writestr("META-INF/container.xml", container_xml, compress_type=zipfile.ZIP_DEFLATED)

        css = (
            "body {\n"
            '    font-family: Georgia, "Times New Roman", serif;\n'
            "    line-height: 1.6;\n"
            "    margin: 5% 5%;\n"
            "    text-align: justify;\n"
            "}\n"
            "h1, h2, h3 {\n"
            "    text-align: center;\n"
            "    font-weight: normal;\n"
            "    margin-top: 1.5em;\n"
            "    margin-bottom: 0.8em;\n"
            "}\n"
            "p {\n"
            "    text-indent: 1.5em;\n"
            "    margin-top: 0;\n"
            "    margin-bottom: 0.5em;\n"
            "}\n"
            ".first-p { text-indent: 0; }\n"
            ".scene-break { text-indent: 0; text-align: center; margin: 1.2em 0; }\n"
            ".cover-wrap { text-align: center; margin: 0; padding: 0; }\n"
            ".cover-wrap img { max-width: 100%; max-height: 100%; }\n"
            ".copyright {\n"
            "    font-size: 0.85em;\n"
            "    color: #555;\n"
            "    text-align: center;\n"
            "    margin-top: 35%;\n"
            "}\n"
        )
        epub.writestr("OEBPS/style.css", css, compress_type=zipfile.ZIP_DEFLATED)

        manifest_items = [
            '<item id="style" href="style.css" media-type="text/css"/>',
        ]
        spine_items: list[str] = []
        metadata_extra: list[str] = []

        if cover_path is not None:
            cover_mime, cover_filename = _cover_mime_and_name(cover_path)
            epub.writestr(f"OEBPS/{cover_filename}", cover_path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
            cover_xhtml = (
                '<?xml version="1.0" encoding="utf-8"?>\n'
                "<!DOCTYPE html>\n"
                f'<html xmlns="http://www.w3.org/1999/xhtml" lang="{html.escape(language)}">\n'
                "<head>\n"
                "  <title>Cover</title>\n"
                '  <link rel="stylesheet" type="text/css" href="style.css"/>\n'
                "</head>\n"
                '<body><div class="cover-wrap">'
                f'<img src="{cover_filename}" alt="{html.escape(title)}"/>'
                "</div></body>\n"
                "</html>"
            )
            epub.writestr("OEBPS/cover.xhtml", cover_xhtml, compress_type=zipfile.ZIP_DEFLATED)
            manifest_items.append(
                f'<item id="cover-image" href="{cover_filename}" media-type="{cover_mime}" properties="cover-image"/>'
            )
            manifest_items.append(
                '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>'
            )
            spine_items.append('<itemref idref="cover"/>')
            metadata_extra.append('<meta name="cover" content="cover-image"/>')

        year = datetime.now().year
        copyright_html = (
            '<?xml version="1.0" encoding="utf-8"?>\n'
            "<!DOCTYPE html>\n"
            f'<html xmlns="http://www.w3.org/1999/xhtml" lang="{html.escape(language)}">\n'
            "<head>\n"
            "  <title>Copyright</title>\n"
            '  <link rel="stylesheet" type="text/css" href="style.css"/>\n'
            "</head>\n"
            "<body>\n"
            '  <div class="copyright">\n'
            f'    <p class="first-p"><strong>{html.escape(title)}</strong></p>\n'
            f'    <p class="first-p">Copyright &#169; {year} {html.escape(author)}</p>\n'
            '    <p class="first-p">All rights reserved.</p>\n'
            '    <p class="first-p">This is a work of fiction. Names, characters, businesses, places, events, and incidents are either the products of the author\'s imagination or used in a fictitious manner.</p>\n'
            "  </div>\n"
            "</body>\n"
            "</html>"
        )
        epub.writestr("OEBPS/copyright.xhtml", copyright_html, compress_type=zipfile.ZIP_DEFLATED)
        manifest_items.append('<item id="copyright" href="copyright.xhtml" media-type="application/xhtml+xml"/>')
        spine_items.append('<itemref idref="copyright"/>')

        toc_nav_links: list[str] = []
        for idx, ch in enumerate(chapters, 1):
            ch_filename = f"chapter_{idx:02d}.xhtml"
            ch_title = str(ch.get("title") or f"Chapter {idx}")
            raw_content = str(ch.get("content") or "")
            body_html = _render_paragraphs(raw_content)

            ch_html = (
                '<?xml version="1.0" encoding="utf-8"?>\n'
                "<!DOCTYPE html>\n"
                f'<html xmlns="http://www.w3.org/1999/xhtml" lang="{html.escape(language)}">\n'
                "<head>\n"
                f"  <title>{html.escape(ch_title)}</title>\n"
                '  <link rel="stylesheet" type="text/css" href="style.css"/>\n'
                "</head>\n"
                "<body>\n"
                f"  <h1>{html.escape(ch_title)}</h1>\n"
                f"  {body_html}\n"
                "</body>\n"
                "</html>"
            )
            epub.writestr(f"OEBPS/{ch_filename}", ch_html, compress_type=zipfile.ZIP_DEFLATED)
            manifest_items.append(f'<item id="ch_{idx}" href="{ch_filename}" media-type="application/xhtml+xml"/>')
            spine_items.append(f'<itemref idref="ch_{idx}"/>')
            toc_nav_links.append(f'<li><a href="{ch_filename}">{html.escape(ch_title)}</a></li>')

        nav_html = (
            '<?xml version="1.0" encoding="utf-8"?>\n'
            "<!DOCTYPE html>\n"
            f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="{html.escape(language)}">\n'
            "<head>\n"
            "  <title>Table of Contents</title>\n"
            '  <link rel="stylesheet" type="text/css" href="style.css"/>\n'
            "</head>\n"
            "<body>\n"
            '  <nav epub:type="toc" id="toc">\n'
            "    <h1>Table of Contents</h1>\n"
            f"    <ol>{''.join(toc_nav_links)}</ol>\n"
            "  </nav>\n"
            "</body>\n"
            "</html>"
        )
        epub.writestr("OEBPS/nav.xhtml", nav_html, compress_type=zipfile.ZIP_DEFLATED)
        manifest_items.append('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')

        extra_meta_xml = ("\n    " + "\n    ".join(metadata_extra)) if metadata_extra else ""
        opf_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">\n'
            '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
            f'    <dc:identifier id="pub-id">urn:uuid:{book_uuid}</dc:identifier>\n'
            f"    <dc:title>{html.escape(title)}</dc:title>\n"
            f"    <dc:creator>{html.escape(author)}</dc:creator>\n"
            f"    <dc:language>{html.escape(language)}</dc:language>\n"
            f"    <dc:description>{html.escape(description)}</dc:description>\n"
            f'    <meta property="dcterms:modified">{datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}</meta>'
            f"{extra_meta_xml}\n"
            "  </metadata>\n"
            "  <manifest>\n    "
            + "\n    ".join(manifest_items)
            + "\n  </manifest>\n"
            "  <spine>\n    "
            + "\n    ".join(spine_items)
            + "\n  </spine>\n"
            "</package>"
        )
        epub.writestr("OEBPS/content.opf", opf_xml, compress_type=zipfile.ZIP_DEFLATED)

    print(f"Successfully built EPUB: {out_file} (Size: {out_file.stat().st_size} bytes)")
    return str(out_file)


def main() -> int:
    ap = argparse.ArgumentParser(description="Build an Amazon KDP-compliant EPUB3 file.")
    ap.add_argument("--out", required=True, help="Output .epub path")
    ap.add_argument("--title", required=True, help="Book title")
    ap.add_argument("--author", default="William Vance", help="Author name")
    ap.add_argument("--lang", default="en", help="Language tag (default: en)")
    ap.add_argument("--description", default="", help="Book blurb / description")
    ap.add_argument("--manuscript-md", default="", help="Markdown manuscript file split on # / ## headings")
    ap.add_argument("--chapters-json", default="", help="JSON file containing [{title, content}, ...]")
    ap.add_argument("--cover", default="", help="Optional cover image (.jpg/.png/.webp)")
    args = ap.parse_args()

    chapters: list[dict[str, str]] = []
    if args.chapters_json:
        chapters = json.loads(Path(args.chapters_json).read_text(encoding="utf-8-sig"))
    elif args.manuscript_md:
        chapters = _parse_markdown_chapters(Path(args.manuscript_md))
    else:
        ap.error("Either --manuscript-md or --chapters-json is required")

    create_epub(
        output_path=args.out,
        title=args.title,
        author=args.author,
        language=args.lang,
        description=args.description,
        chapters=chapters,
        cover_image_path=args.cover or None,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
