"""Unit tests for python/render.py and python/page.html."""

from __future__ import annotations

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import render


class TestRenderHelpers(unittest.TestCase):
    def test_carriage_return_collapsing_preserves_crlf(self):
        self.assertEqual(render.apply_carriage_returns("a\r\nb\r\n"), "a\nb\n")
        self.assertEqual(render.apply_carriage_returns("10%\r50%\r100%"), "100%")
        self.assertEqual(render.apply_carriage_returns("10%\r50%\r\ndone"), "50%\ndone")
        self.assertEqual(render.apply_carriage_returns("loading...\r"), "loading...")

    def test_ansi_to_html_escapes_and_styles(self):
        out = render.ansi_to_html("\x1b[1;31m<err>\x1b[0m ok")
        self.assertIn("&lt;err&gt;", out)
        self.assertIn("font-weight:700", out)
        self.assertIn("color:#cf222e", out)
        self.assertTrue(out.endswith(" ok"))

    def test_sanitize_html_strips_dangerous_tags_and_attrs(self):
        raw = (
            '<div onclick="alert(1)" class="ok">'
            "<script>evil()</script>"
            "<style>body{display:none}</style>"
            '<iframe src="https://evil.test"></iframe>'
            '<a href="javascript:alert(1)">bad</a>'
            '<a href="https://example.com">good</a>'
            '<img src="data:text/html,<script>x</script>">'
            '<img src="data:image/png;base64,AAAA" alt="ok">'
            "<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>"
            "</div>"
        )
        clean = render.sanitize_html(raw)
        forbidden = (
            "<script", "evil()", "<style", "<iframe", "onclick", "javascript:", "data:text/html"
        )
        for bad in forbidden:
            self.assertNotIn(bad, clean)
        self.assertIn('href="https://example.com"', clean)
        self.assertIn('src="data:image/png;base64,AAAA"', clean)
        self.assertIn("<table>", clean)

    def test_image_base64_xss_blocked(self):
        payload = 'AAAA" onload="alert(1)"><script>evil()</script>'
        out = render.render_output(
            {"output_type": "display_data", "data": {"image/png": payload}},
            own_index=0,
        )
        self.assertNotIn("onload", out)
        self.assertNotIn("<script", out)
        self.assertIn("Invalid base64 image data", out)

        out_jpg = render.render_output(
            {"output_type": "display_data", "data": {"image/jpeg": "AAAA\nBBBB"}},
            own_index=0,
        )
        self.assertIn('src="data:image/jpeg;base64,AAAABBBB"', out_jpg)

    def test_render_markdown_live_vs_export_images(self):
        md = (
            "# Title\n\n"
            "Hello **bold** and *italic* and `code` and $x^2$.\n\n"
            "$$\nE = mc^2\n$$\n\n"
            "> A quote\n\n"
            "- one\n- two\n\n"
            "1. first\n2. second\n\n"
            "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n"
            "![fig](plots/a.png)\n\n"
            "```python\nx = 1\n```\n"
        )
        live = render.render_markdown(md, token="tok123", export=False)
        self.assertIn("<h1>Title</h1>", live)
        self.assertIn("<strong>bold</strong>", live)
        self.assertIn("<em>italic</em>", live)
        self.assertIn("<code>code</code>", live)
        self.assertIn("math-block", live)
        self.assertIn("<blockquote>", live)
        self.assertIn("<ul><li>one</li><li>two</li></ul>", live)
        self.assertIn("<ol><li>first</li><li>second</li></ol>", live)
        self.assertIn('<div class="table-scroll"><table>', live)
        self.assertIn('src="/asset?path=plots/a.png&amp;token=tok123"', live)
        self.assertIn("codehilite", live)

        exported = render.render_markdown(md, token="tok123", export=True)
        self.assertIn('src="plots/a.png"', exported)
        self.assertNotIn("/asset?path=", exported)

    def test_render_traceback_buttons(self):
        tb = (
            "\x1b[31mZeroDivisionError\x1b[0m: division by zero\n"
            "Cell In[3], line 4, in <module>\n"
            'File "/tmp/model.py", line 42, in run\n'
        )
        out = render.render_traceback(tb, own_index=2)
        self.assertIn('class="tb-jump"', out)
        self.assertIn('data-kind="cell"', out)
        self.assertIn('data-exec-count="3"', out)
        self.assertIn('data-line="4"', out)
        self.assertIn('data-own-index="2"', out)
        self.assertIn('data-kind="file"', out)
        self.assertIn('data-path="/tmp/model.py"', out)
        self.assertIn('data-line="42"', out)

    def test_render_cell_and_document_export_modes(self):
        cells = [
            {"index": 0, "cell_type": "markdown", "source": "# Report\n\n![p](img/p.png)"},
            {
                "index": 1,
                "cell_type": "code",
                "source": "x = 1",
                "execution_count": 1,
                "status": "idle",
                "duration_ms": 250,
                "outputs": [
                    {"output_type": "stream", "name": "stdout", "text": "hello\n"},
                    {"output_type": "display_data", "data": {"image/png": "AAAA"}},
                    {
                        "output_type": "display_data",
                        "data": {"text/html": "<table><tr><td>v</td></tr></table>"},
                    },
                ],
            },
        ]
        reason = {"from": 0, "symbols": ["x"], "kind": "upstream_edited"}
        stale = {1: {"edited": False, "reasons": [reason]}}
        live_html = render.render_document(cells, stale, "demo.ipynb", token="secret")
        self.assertIn("EventSource", live_html)
        self.assertIn("badge-stale", live_html)
        self.assertIn('<a class="output img-link"', live_html)
        self.assertIn('<div class="table-scroll"><table>', live_html)
        self.assertIn("/asset?path=img/p.png", live_html)

        export_html = render.render_document(cells, stale, "demo.ipynb", export=True)
        self.assertNotIn("EventSource", export_html)
        self.assertNotIn("<script>", export_html)
        self.assertIn('class="cell-input"', export_html)
        self.assertIn('src="img/p.png"', export_html)
        self.assertNotIn("/asset?path=", export_html)

        report_html = render.render_document(
            cells, stale, "demo.ipynb", report=True, export=True
        )
        self.assertNotIn("EventSource", report_html)
        self.assertNotIn('class="cell-input"', report_html)
        self.assertIn("hello", report_html)
        self.assertIn("<h1>Report</h1>", report_html)

    def test_page_html_script_under_2kb(self):
        page_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "page.html"
        )
        with open(page_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        match = re.search(r"<script>(.*?)</script>", content, re.DOTALL)
        self.assertIsNotNone(match)
        js_bytes = len(match.group(1).encode("utf-8"))
        self.assertLess(js_bytes, 2048, f"Inline JS is {js_bytes} bytes (>= 2048)")


if __name__ == "__main__":
    unittest.main()
