#!/usr/bin/env python3
"""Convert supported documents (currently PDF) to Markdown using PyMuPDF."""

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, Optional, Tuple

try:
    import fitz  # PyMuPDF
except ImportError as exc:  # pragma: no cover - handled at runtime
    raise SystemExit(json.dumps({"error": f"PyMuPDF (fitz) not available: {exc}"}))


def pdf_to_markdown(path: Path, max_pages: Optional[int] = None) -> Tuple[str, int]:
    """Return markdown string and total page count for a PDF."""
    doc = fitz.open(path)
    try:
        lines: list[str] = []
        page_limit = max_pages if max_pages is not None and max_pages > 0 else None
        for idx, page in enumerate(doc):
            if page_limit is not None and idx >= page_limit:
                break
            text = page.get_text("markdown") or ""
            text = text.strip()
            if not text:
                text = page.get_text("text") or ""
                text = text.strip()
            if text:
                lines.append(text)
        markdown = "\n\n".join(lines).strip()
        return markdown, doc.page_count
    finally:
        doc.close()


def convert_file(input_path: Path, max_pages: Optional[int] = None) -> Tuple[str, Dict[str, object]]:
    suffix = input_path.suffix.lower()
    if suffix == ".pdf":
        markdown, page_count = pdf_to_markdown(input_path, max_pages=max_pages)
        meta = {"pages": page_count, "type": "pdf"}
        return markdown, meta
    if suffix in {".md", ".markdown"}:
        markdown = input_path.read_text(encoding="utf-8")
        return markdown, {"type": "markdown", "pages": None}
    if suffix in {".txt", ""}:
        markdown = input_path.read_text(encoding="utf-8")
        return markdown, {"type": "text", "pages": None}
    raise ValueError(f"Unsupported file extension: {suffix or 'unknown'}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert documents to Markdown using PyMuPDF")
    parser.add_argument("--input", required=True, help="Path to the input file (PDF/Markdown/Text)")
    parser.add_argument("--output", help="Optional path to write the markdown output")
    parser.add_argument("--max-pages", type=int, default=None, help="Limit the number of pages converted")
    parser.add_argument("--format", choices=["json", "text"], default="json", help="Stdout output format")
    parser.add_argument("--metadata", action="store_true", help="Include metadata when using JSON output")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists():
        parser.error(f"Input file not found: {input_path}")

    try:
        markdown, meta = convert_file(input_path, max_pages=args.max_pages)
    except Exception as exc:  # pragma: no cover - runtime conversion errors
        payload = {"error": str(exc)}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        sys.exit(1)

    if args.output:
        Path(args.output).expanduser().resolve().write_text(markdown, encoding="utf-8")

    if args.format == "json":
        payload: Dict[str, object] = {"markdown": markdown}
        if args.metadata:
            payload["metadata"] = meta
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    else:
        sys.stdout.write(markdown)

    if not args.output:
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()

