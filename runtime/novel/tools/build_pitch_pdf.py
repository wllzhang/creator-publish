#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parameterized Pitch Deck PDF compiler.
Converts a Markdown proposal (.md) or pre-rendered HTML (.html) into an A4 PDF via headless Edge/Chrome
with bounded timeout and an isolated temporary browser user-data-dir.
"""
from __future__ import annotations

import argparse
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _inline_md(text: str) -> str:
    esc = html.escape(text)
    esc = re.sub(r"`([^`]+)`", r"<code>\1</code>", esc)
    esc = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", esc)
    esc = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", esc)
    return esc


def markdown_to_html(md_text: str, doc_title: str = "Pitch Deck") -> str:
    lines = md_text.splitlines()
    body_parts: list[str] = []
    in_ul = False
    in_table = False

    def close_lists():
        nonlocal in_ul, in_table
        if in_ul:
            body_parts.append("</ul>")
            in_ul = False
        if in_table:
            body_parts.append("</tbody></table>")
            in_table = False

    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped:
            close_lists()
            continue

        if stripped.startswith("|") and stripped.endswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if all(re.match(r"^:?-{2,}:?$", c) for c in cells if c):
                continue
            if not in_table:
                close_lists()
                in_table = True
                ths = "".join(f"<th>{_inline_md(c)}</th>" for c in cells)
                body_parts.append(f"<table><thead><tr>{ths}</tr></thead><tbody>")
            else:
                tds = "".join(f"<td>{_inline_md(c)}</td>" for c in cells)
                body_parts.append(f"<tr>{tds}</tr>")
            continue

        if stripped.startswith("#"):
            close_lists()
            m = re.match(r"^(#{1,4})\s+(.+)$", stripped)
            if m:
                lvl = len(m.group(1))
                body_parts.append(f"<h{lvl}>{_inline_md(m.group(2))}</h{lvl}>")
                continue

        if re.match(r"^[-*•]\s+", stripped):
            if in_table:
                close_lists()
            if not in_ul:
                body_parts.append("<ul>")
                in_ul = True
            item = re.sub(r"^[-*•]\s+", "", stripped)
            body_parts.append(f"<li>{_inline_md(item)}</li>")
            continue

        close_lists()
        if stripped in ("---", "***"):
            body_parts.append("<hr/>")
        elif re.match(r"^(INT\.|EXT\.|SCENE\s+\d+|EPISODE\s+\d+)", stripped):
            body_parts.append(f'<p class="scene-head">{_inline_md(stripped)}</p>')
        elif stripped.startswith(">"):
            body_parts.append(f"<blockquote>{_inline_md(stripped.lstrip('> ').strip())}</blockquote>")
        else:
            body_parts.append(f"<p>{_inline_md(stripped)}</p>")

    close_lists()
    body_html = "\n".join(body_parts)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{html.escape(doc_title)}</title>
  <style>
    @page {{
      size: A4;
      margin: 18mm 18mm 22mm 18mm;
      @bottom-right {{
        content: counter(page);
        font-family: "Courier New", monospace;
        font-size: 9pt;
        color: #666;
      }}
    }}
    body {{
      font-family: "Segoe UI", "Helvetica Neue", Arial, "Microsoft YaHei", sans-serif;
      color: #1c1e24;
      line-height: 1.55;
      font-size: 10.5pt;
    }}
    h1 {{ font-size: 20pt; color: #0f172a; border-bottom: 2px solid #b48c46; padding-bottom: 6px; margin-top: 0; }}
    h2 {{ font-size: 14pt; color: #1e293b; border-left: 4px solid #b48c46; padding-left: 8px; margin-top: 18px; page-break-after: avoid; }}
    h3 {{ font-size: 11.5pt; color: #334155; margin-top: 12px; page-break-after: avoid; }}
    p {{ margin: 6px 0; }}
    ul {{ margin: 6px 0 10px 18px; padding: 0; }}
    li {{ margin-bottom: 4px; }}
    blockquote {{ margin: 10px 0; padding: 8px 12px; background: #f8fafc; border-left: 3px solid #64748b; color: #334155; }}
    table {{ width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 9.5pt; }}
    th, td {{ border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; vertical-align: top; }}
    th {{ background: #f1f5f9; font-weight: 600; }}
    .scene-head {{ font-family: "Courier New", monospace; font-weight: 700; text-transform: uppercase; margin-top: 12px; color: #0f172a; }}
    code {{ font-family: "Courier New", monospace; background: #f1f5f9; padding: 1px 4px; border-radius: 3px; }}
    hr {{ border: none; border-top: 1px solid #cbd5e1; margin: 14px 0; }}
  </style>
</head>
<body>
{body_html}
</body>
</html>
"""


def find_browser_exe() -> str | None:
    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        shutil.which("msedge"),
        shutil.which("google-chrome"),
        shutil.which("chromium"),
    ]
    for cand in candidates:
        if cand and os.path.isfile(cand):
            return cand
    return None


def compile_pitch_pdf(
    input_path: str | Path,
    output_pdf: str | Path,
    *,
    title: str = "",
    keep_html: bool = False,
    timeout_sec: int = 60,
) -> Path:
    src = Path(input_path).resolve()
    if not src.is_file():
        raise FileNotFoundError(f"Input file not found: {src}")

    out_pdf = Path(output_pdf).resolve()
    out_pdf.parent.mkdir(parents=True, exist_ok=True)

    browser_exe = find_browser_exe()
    if not browser_exe:
        raise RuntimeError("No Edge or Chrome browser executable found for headless PDF rendering.")

    doc_title = title.strip() or src.stem.replace("_", " ")
    cleanup_html = False
    if src.suffix.lower() in (".html", ".htm"):
        html_path = src
    else:
        html_text = markdown_to_html(src.read_text(encoding="utf-8-sig"), doc_title=doc_title)
        if keep_html:
            html_path = out_pdf.with_suffix(".html")
        else:
            fd, tmp_html = tempfile.mkstemp(prefix="pitch-deck-", suffix=".html")
            os.close(fd)
            html_path = Path(tmp_html)
            cleanup_html = True
        html_path.write_text(html_text, encoding="utf-8")

    profile_dir = Path(tempfile.mkdtemp(prefix="pitch-pdf-profile-"))
    try:
        cmd = [
            browser_exe,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--no-first-run",
            f"--user-data-dir={profile_dir}",
            "--no-pdf-header-footer",
            f"--print-to-pdf={out_pdf}",
            html_path.resolve().as_uri(),
        ]
        res = subprocess.run(cmd, capture_output=True, timeout=timeout_sec)
        if res.returncode != 0 or not out_pdf.is_file() or out_pdf.stat().st_size == 0:
            err = res.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"Headless PDF render failed (rc={res.returncode}): {err}")
        print(f"[OK] Generated PDF: {out_pdf} ({out_pdf.stat().st_size:,} bytes)")
        return out_pdf
    finally:
        if cleanup_html:
            try:
                html_path.unlink(missing_ok=True)
            except OSError:
                pass
        shutil.rmtree(profile_dir, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Compile a Markdown or HTML pitch deck to A4 PDF.")
    ap.add_argument("--input", required=True, help="Input .md or .html file")
    ap.add_argument("--out", required=True, help="Output .pdf file path")
    ap.add_argument("--title", default="", help="Optional HTML/PDF document title")
    ap.add_argument("--keep-html", action="store_true", help="Keep rendered .html beside output .pdf")
    ap.add_argument("--timeout", type=int, default=60, help="Browser render timeout in seconds")
    args = ap.parse_args()

    try:
        compile_pitch_pdf(
            args.input,
            args.out,
            title=args.title,
            keep_html=args.keep_html,
            timeout_sec=args.timeout,
        )
        return 0
    except Exception as exc:
        print(f"[Error] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
