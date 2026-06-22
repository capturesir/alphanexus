#!/usr/bin/env python3
import markdown, sys, os
from weasyprint import HTML

INPUT = sys.argv[1] if len(sys.argv) > 1 else "docs/UX_IMPROVEMENTS.md"
OUTPUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/AlphaNexus_UX_Improvements.pdf"

with open(INPUT, "r", encoding="utf-8") as f:
    md = f.read()

html_body = markdown.markdown(md, extensions=["tables", "fenced_code", "toc"])

CSS = """
@page {
  size: A4;
  margin: 2cm 1.8cm 2cm 1.8cm;
  @bottom-center { content: "AlphaNexus UX 改善建議"; font-size: 7.5pt; color: #94a3b8; }
  @bottom-right { content: counter(page) " / " counter(pages); font-size: 7.5pt; }
}
body {
  font-family: 'Noto Sans TC', 'Noto Sans', 'Helvetica Neue', Arial, sans-serif;
  font-size: 10pt;
  line-height: 1.7;
  color: #1e293b;
}
h1 { font-size: 18pt; color: #1e40af; border-bottom: 2px solid #1e40af; padding-bottom: 6px; margin-top: 0; }
h2 { font-size: 14pt; color: #1e3a8a; margin-top: 18px; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; }
h3 { font-size: 12pt; color: #334155; margin-top: 12px; }
p { margin: 6px 0; }
ul, ol { margin: 4px 0; padding-left: 20px; }
li { margin: 2px 0; }
code { background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-size: 9pt; }
pre { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; font-size: 9pt; overflow-x: auto; }
table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid #cbd5e1; border-radius: 4px; overflow: hidden; margin: 8px 0; }
th { background: #1e40af; color: #fff; padding: 5px 8px; border-bottom: 1px solid #1e3a8a; border-right: 1px solid #2d4a9a; font-size: 9pt; }
th:last-child { border-right: none; }
td { padding: 5px 8px; border-bottom: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; font-size: 9pt; }
td:last-child { border-right: none; }
tr:last-child td { border-bottom: none; }
tbody tr:nth-child(even) { background: #f8fafc; }
blockquote { border-left: 3px solid #3b82f6; margin: 8px 0; padding: 4px 12px; background: #eff6ff; color: #1e40af; }
strong { color: #0f172a; }
hr { border: none; border-top: 1px solid #e2e8f0; margin: 12px 0; }
"""

full_html = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head><meta charset="UTF-8"><style>{CSS}</style></head>
<body>{html_body}</body>
</html>"""

HTML(string=full_html).write_pdf(OUTPUT)
print(f"PDF: {OUTPUT} ({os.path.getsize(OUTPUT)/1024:.0f} KB)")
