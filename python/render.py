"""Stdlib SSR HTML/Markdown/ANSI/Sanitizer renderer for ipynb-peek."""

from __future__ import annotations

import base64
import html
from html.parser import HTMLParser
import json
import os
import re
from typing import Any
import urllib.parse

import dag

try:
    from pygments import highlight as _pyg_highlight
    from pygments.formatters import HtmlFormatter as _PygHtmlFormatter
    from pygments.lexers import TextLexer as _PygTextLexer
    from pygments.lexers import get_lexer_by_name as _pyg_get_lexer

    HAS_PYGMENTS = True
except Exception:
    HAS_PYGMENTS = False

try:
    import latex2mathml.converter as _latex2mathml

    HAS_LATEX2MATHML = True
except Exception:
    HAS_LATEX2MATHML = False

_TEMPLATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "page.html")
_BASE64_RE = re.compile(r"^[A-Za-z0-9+/=]+$")


def apply_carriage_returns(text: str) -> str:
    """Collapse lone \\r overwrites (e.g. tqdm) while preserving \\r\\n."""
    if "\r" not in text:
        return text
    normalized = text.replace("\r\n", "\n")
    out_lines: list[str] = []
    for line in normalized.split("\n"):
        if "\r" not in line:
            out_lines.append(line)
            continue
        parts = line.split("\r")
        chosen = parts[-1] or next((p for p in reversed(parts[:-1]) if p), "")
        out_lines.append(chosen)
    return "\n".join(out_lines)


_ANSI_CSI_RE = re.compile(r"\x1b\[([0-9;]*)([A-Za-z])")
_ANSI_FG = {
    30: "#1f2328", 31: "#cf222e", 32: "#1a7f37", 33: "#9a6700",
    34: "#0969da", 35: "#8250df", 36: "#1b7c83", 37: "#6e7781",
    90: "#6e7781", 91: "#f85149", 92: "#3fb950", 93: "#d29922",
    94: "#58a6ff", 95: "#bc8cff", 96: "#39c5cf", 97: "#f0f6fc",
}
_ANSI_BG = {k + 10: v for k, v in _ANSI_FG.items()}


def strip_ansi(text: str) -> str:
    return _ANSI_CSI_RE.sub("", text)


def _apply_sgr_code(code: int, state: dict[str, Any]) -> None:
    if code == 0:
        state.update(fg=None, bg=None, bold=False, dim=False, italic=False, ul=False)
    elif code == 1:
        state["bold"] = True
    elif code == 2:
        state["dim"] = True
    elif code == 3:
        state["italic"] = True
    elif code == 4:
        state["ul"] = True
    elif code == 22:
        state["bold"] = state["dim"] = False
    elif code == 23:
        state["italic"] = False
    elif code == 24:
        state["ul"] = False
    elif code == 39:
        state["fg"] = None
    elif code == 49:
        state["bg"] = None
    elif code in _ANSI_FG:
        state["fg"] = _ANSI_FG[code]
    elif code in _ANSI_BG:
        state["bg"] = _ANSI_BG[code]


def _sgr_style_str(state: dict[str, Any]) -> str:
    styles: list[str] = []
    if state["fg"]:
        styles.append(f"color:{state['fg']}")
    if state["bg"]:
        styles.append(f"background:{state['bg']}")
    if state["bold"]:
        styles.append("font-weight:700")
    if state["dim"]:
        styles.append("opacity:0.7")
    if state["italic"]:
        styles.append("font-style:italic")
    if state["ul"]:
        styles.append("text-decoration:underline")
    return ";".join(styles)


def ansi_to_html(text: str) -> str:
    """Convert ANSI SGR color/style escapes into escaped HTML spans."""
    if "\x1b" not in text:
        return html.escape(text)
    out: list[str] = []
    state: dict[str, Any] = {
        "fg": None, "bg": None, "bold": False, "dim": False, "italic": False, "ul": False
    }
    open_span = False
    pos = 0

    for match in _ANSI_CSI_RE.finditer(text):
        if match.start() > pos:
            out.append(html.escape(text[pos : match.start()]))
        pos = match.end()
        if match.group(2) != "m":
            continue
        raw_codes = match.group(1).split(";") if match.group(1) else ["0"]
        for tok in raw_codes:
            _apply_sgr_code(int(tok) if tok else 0, state)
        if open_span:
            out.append("</span>")
            open_span = False
        style = _sgr_style_str(state)
        if style:
            out.append(f'<span style="{style}">')
            open_span = True

    if pos < len(text):
        out.append(html.escape(text[pos:]))
    if open_span:
        out.append("</span>")
    return "".join(out)


_ALLOWED_TAGS: frozenset[str] = frozenset(
    {
        "a", "abbr", "b", "blockquote", "br", "caption", "code", "col", "colgroup",
        "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure",
        "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li",
        "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span", "strong",
        "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
        "tr", "u", "ul",
        "math", "mrow", "mi", "mn", "mo", "msup", "msub", "msubsup", "mfrac",
        "msqrt", "mroot", "mtable", "mtr", "mtd", "mtext", "mspace", "mover",
        "munder", "munderover", "semantics", "annotation",
    }
)
_DROP_CONTENT_TAGS: frozenset[str] = frozenset(
    {"script", "style", "iframe", "object", "embed", "applet", "noscript"}
)
_VOID_TAGS: frozenset[str] = frozenset({"br", "col", "hr", "img"})
_ALLOWED_ATTRS: frozenset[str] = frozenset(
    {
        "align", "alt", "border", "class", "colspan", "dir", "display", "height",
        "href", "id", "rel", "rowspan", "scope", "src", "target", "title",
        "valign", "width", "xmlns",
    }
)
_URL_ATTRS: frozenset[str] = frozenset({"href", "src"})
_SAFE_DATA_IMAGE_RE = re.compile(
    r"^data:image/(png|jpeg|jpg|gif|webp|bmp|svg\+xml)\s*;", re.IGNORECASE
)


def _is_safe_url(url: str, *, allow_data_image: bool = False) -> bool:
    cleaned = re.sub(r"[\x00-\x20]+", "", url).lower()
    if not cleaned:
        return True
    if cleaned.startswith(("javascript:", "vbscript:")):
        return False
    if cleaned.startswith("data:"):
        return allow_data_image and bool(_SAFE_DATA_IMAGE_RE.match(cleaned))
    head = cleaned.split("/", 1)[0].split("#", 1)[0].split("?", 1)[0]
    if ":" in head:
        return cleaned.startswith(("http:", "https:", "mailto:"))
    return True


def _format_safe_attrs(tag: str, attrs: list[tuple[str, str | None]]) -> str:
    safe_attrs: list[str] = []
    for name, value in attrs:
        aname = name.lower()
        if aname.startswith("on") or aname not in _ALLOWED_ATTRS:
            continue
        val = value or ""
        allow_img = tag == "img" and aname == "src"
        if aname in _URL_ATTRS and not _is_safe_url(val, allow_data_image=allow_img):
            continue
        safe_attrs.append(f' {aname}="{html.escape(val, quote=True)}"')
    return "".join(safe_attrs)


class _AllowlistSanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.out: list[str] = []
        self._drop_stack: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if t in _DROP_CONTENT_TAGS:
            self._drop_stack.append(t)
            return
        if self._drop_stack or t not in _ALLOWED_TAGS:
            return
        self.out.append(f"<{t}{_format_safe_attrs(t, attrs)}>")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if t in _DROP_CONTENT_TAGS or self._drop_stack or t not in _ALLOWED_TAGS:
            return
        self.handle_starttag(t, attrs)
        if t not in _VOID_TAGS:
            self.out.append(f"</{t}>")

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if self._drop_stack:
            if self._drop_stack[-1] == t:
                self._drop_stack.pop()
            return
        if t in _ALLOWED_TAGS and t not in _VOID_TAGS:
            self.out.append(f"</{t}>")

    def handle_data(self, data: str) -> None:
        if not self._drop_stack:
            self.out.append(html.escape(data))

    def handle_entityref(self, name: str) -> None:
        if not self._drop_stack:
            self.out.append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        if not self._drop_stack:
            self.out.append(f"&#{name};")


def sanitize_html(raw_html: str) -> str:
    """Sanitize untrusted HTML using an allowlist HTMLParser."""
    parser = _AllowlistSanitizer()
    parser.feed(raw_html)
    parser.close()
    return "".join(parser.out)


def highlight_code(code: str, language: str = "python") -> str:
    """Highlight code with pygments if installed, else escaped <pre><code>."""
    if not HAS_PYGMENTS:
        return f'<pre class="codehilite"><code>{html.escape(code)}</code></pre>'
    try:
        lexer = _pyg_get_lexer(language) if language else _PygTextLexer()
    except Exception:
        lexer = _PygTextLexer()
    highlighted = _pyg_highlight(code, lexer, _PygHtmlFormatter(nowrap=True)).rstrip("\n")
    return f'<pre class="codehilite"><code>{highlighted}</code></pre>'


def pygments_css() -> str:
    if not HAS_PYGMENTS:
        return ""
    return (
        ".codehilite .k,.codehilite .kn,.codehilite .kd,.codehilite .ow{color:#cf222e}"
        ".codehilite .s,.codehilite .s1,.codehilite .s2,.codehilite .sa,"
        ".codehilite .sb,.codehilite .sd{color:#0a3069}"
        ".codehilite .c,.codehilite .c1,.codehilite .cm{color:var(--muted);font-style:italic}"
        ".codehilite .mi,.codehilite .mf,.codehilite .mh,.codehilite .mo{color:#0550ae}"
        ".codehilite .nf,.codehilite .nc{color:#8250df}"
        ".codehilite .nb,.codehilite .bp{color:#953800}"
        "@media(prefers-color-scheme:dark){"
        ".codehilite .k,.codehilite .kn,.codehilite .kd,.codehilite .ow{color:#ff7b72}"
        ".codehilite .s,.codehilite .s1,.codehilite .s2,.codehilite .sa,"
        ".codehilite .sb,.codehilite .sd{color:#a5d6ff}"
        ".codehilite .mi,.codehilite .mf,.codehilite .mh,.codehilite .mo{color:#79c0ff}"
        ".codehilite .nf,.codehilite .nc{color:#d2a8ff}"
        ".codehilite .nb,.codehilite .bp{color:#ffa657}}"
    )


def render_math(tex: str, display: bool = False) -> str:
    """Render LaTeX math via latex2mathml if available, else styled TeX fallback."""
    cleaned = tex.strip()
    tag = "div" if display else "span"
    cls = "math-block" if display else "math"
    if HAS_LATEX2MATHML:
        try:
            mode = "block" if display else "inline"
            return f'<{tag} class="{cls}">{_latex2mathml.convert(cleaned, display=mode)}</{tag}>'
        except Exception:
            pass
    return f'<{tag} class="{cls}">{html.escape(cleaned)}</{tag}>'


def _rewrite_asset_url(url: str, token: str, *, export: bool = False) -> str:
    u = url.strip()
    if export or not u or u.startswith(("http://", "https://", "data:", "/", "#")):
        return u
    encoded = urllib.parse.quote(u, safe="/")
    if token:
        return f"/asset?path={encoded}&token={urllib.parse.quote(token, safe='')}"
    return f"/asset?path={encoded}"


def _render_inline(text: str, token: str = "", *, export: bool = False) -> str:
    placeholders: list[str] = []

    def stash(fragment: str) -> str:
        key = f"\x00PH{len(placeholders)}\x00"
        placeholders.append(fragment)
        return key

    s = re.sub(r"`([^`\n]+)`", lambda m: stash(f"<code>{html.escape(m.group(1))}</code>"), text)
    s = re.sub(
        r"(?<!\$)\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)",
        lambda m: stash(render_math(m.group(1), display=False)),
        s,
    )

    def repl_img(match: re.Match[str]) -> str:
        alt = html.escape(match.group(1), quote=True)
        raw_url = match.group(2).strip()
        if not _is_safe_url(raw_url, allow_data_image=True):
            return stash(alt)
        url = _rewrite_asset_url(raw_url, token, export=export)
        return stash(f'<img src="{html.escape(url, quote=True)}" alt="{alt}">')

    def repl_link(match: re.Match[str]) -> str:
        label = html.escape(match.group(1))
        raw_url = match.group(2).strip()
        if not _is_safe_url(raw_url, allow_data_image=False):
            return stash(label)
        safe_href = html.escape(raw_url, quote=True)
        return stash(f'<a href="{safe_href}" target="_blank" rel="noopener">{label}</a>')

    s = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", repl_img, s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", repl_link, s)
    s = html.escape(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"__(.+?)__", r"<strong>\1</strong>", s)
    s = re.sub(r"~~(.+?)~~", r"<del>\1</del>", s)
    s = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"(?<!\w)_([^_]+)_(?!\w)", r"<em>\1</em>", s)

    for idx, frag in enumerate(placeholders):
        s = s.replace(f"\x00PH{idx}\x00", frag)
    return s


_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$")
_FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_HR_RE = re.compile(r"^\s*([-*_])(?:\s*\1){2,}\s*$")
_UL_RE = re.compile(r"^\s*[-*+]\s+")
_OL_RE = re.compile(r"^\s*\d+\.\s+")


def _split_table_row(line: str) -> list[str]:
    stripped = line.strip().removeprefix("|").removesuffix("|")
    return [cell.strip() for cell in stripped.split("|")]


def _consume_fence(lines: list[str], i: int, match: re.Match[str]) -> tuple[str, int]:
    fence_char = match.group(1)[0]
    fence_len = len(match.group(1))
    lang = match.group(2)
    close_re = re.compile(rf"^\s*{re.escape(fence_char)}{{{fence_len},}}\s*$")
    code_lines: list[str] = []
    i += 1
    while i < len(lines) and not close_re.match(lines[i]):
        code_lines.append(lines[i])
        i += 1
    if i < len(lines):
        i += 1
    return highlight_code("\n".join(code_lines), lang or "text"), i


def _consume_math_block(lines: list[str], i: int) -> tuple[str, int]:
    stripped = lines[i].strip()
    if stripped.endswith("$$") and len(stripped) > 4:
        return render_math(stripped[2:-2], display=True), i + 1
    math_lines = [stripped[2:]]
    i += 1
    while i < len(lines) and not lines[i].strip().endswith("$$"):
        math_lines.append(lines[i])
        i += 1
    if i < len(lines):
        tail = lines[i].strip()[:-2]
        if tail:
            math_lines.append(tail)
        i += 1
    return render_math("\n".join(math_lines), display=True), i


def _consume_table(
    lines: list[str], i: int, token: str, *, export: bool
) -> tuple[str, int]:
    headers = _split_table_row(lines[i])
    i += 2
    rows: list[list[str]] = []
    while i < len(lines) and "|" in lines[i] and lines[i].strip():
        rows.append(_split_table_row(lines[i]))
        i += 1
    th = "".join(f"<th>{_render_inline(h, token, export=export)}</th>" for h in headers)
    body = "".join(
        "<tr>"
        + "".join(f"<td>{_render_inline(c, token, export=export)}</td>" for c in r)
        + "</tr>"
        for r in rows
    )
    html_tbl = (
        f'<div class="table-scroll"><table><thead><tr>{th}</tr></thead>'
        f"<tbody>{body}</tbody></table></div>"
    )
    return html_tbl, i


def _consume_list(
    lines: list[str], i: int, pat: re.Pattern[str], tag: str, token: str, *, export: bool
) -> tuple[str, int]:
    items: list[str] = []
    while i < len(lines) and pat.match(lines[i]):
        items.append(pat.sub("", lines[i]))
        i += 1
    li_html = "".join(f"<li>{_render_inline(it, token, export=export)}</li>" for it in items)
    return f"<{tag}>{li_html}</{tag}>", i


def _starts_block(lines: list[str], i: int) -> bool:
    line = lines[i]
    if not line.strip():
        return True
    if (
        _FENCE_RE.match(line)
        or line.strip().startswith("$$")
        or _HEADING_RE.match(line)
        or re.match(r"^\s*>", line)
        or _UL_RE.match(line)
        or _OL_RE.match(line)
    ):
        return True
    return "|" in line and i + 1 < len(lines) and bool(_TABLE_SEP_RE.match(lines[i + 1]))


def render_markdown(text: str, token: str = "", *, export: bool = False) -> str:
    """Clean pure-Python Markdown renderer (headings, fences, lists, tables, math)."""
    lines = text.replace("\r\n", "\n").split("\n")
    n = len(lines)
    i = 0
    out: list[str] = []

    while i < n:
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue
        fence_m = _FENCE_RE.match(line)
        if fence_m:
            frag, i = _consume_fence(lines, i, fence_m)
            out.append(frag)
            continue
        if stripped.startswith("$$"):
            frag, i = _consume_math_block(lines, i)
            out.append(frag)
            continue
        head_m = _HEADING_RE.match(line)
        if head_m:
            lvl = len(head_m.group(1))
            out.append(f"<h{lvl}>{_render_inline(head_m.group(2), token, export=export)}</h{lvl}>")
            i += 1
            continue
        if _HR_RE.match(line):
            out.append("<hr>")
            i += 1
            continue
        if re.match(r"^\s*>", line):
            bq: list[str] = []
            while i < n and re.match(r"^\s*>", lines[i]):
                bq.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            inner = render_markdown("\n".join(bq), token, export=export)
            out.append(f"<blockquote>{inner}</blockquote>")
            continue
        if "|" in line and i + 1 < n and _TABLE_SEP_RE.match(lines[i + 1]):
            frag, i = _consume_table(lines, i, token, export=export)
            out.append(frag)
            continue
        if _UL_RE.match(line):
            frag, i = _consume_list(lines, i, _UL_RE, "ul", token, export=export)
            out.append(frag)
            continue
        if _OL_RE.match(line):
            frag, i = _consume_list(lines, i, _OL_RE, "ol", token, export=export)
            out.append(frag)
            continue

        para = [line]
        i += 1
        while i < n and not _starts_block(lines, i):
            para.append(lines[i])
            i += 1
        out.append(f"<p>{_render_inline(chr(10).join(para), token, export=export)}</p>")

    return "\n".join(out)


_TB_CELL_RE = re.compile(r"Cell\s+In\[(\d+)\],\s*line\s+(\d+)")
_TB_FILE_RE = re.compile(r'File\s+"([^"]+)",\s*line\s+(\d+)')


def render_traceback(text: str, own_index: int | None = None) -> str:
    """Render Python/IPython traceback with clickable jump buttons for frames."""
    lines = apply_carriage_returns(text).split("\n")
    rendered: list[str] = []
    own_attr = f' data-own-index="{own_index}"' if own_index is not None else ""

    for line in lines:
        plain = strip_ansi(line)
        line_html = ansi_to_html(line)
        cm = _TB_CELL_RE.search(plain)
        if cm:
            ec, ln = cm.group(1), cm.group(2)
            rendered.append(
                f'<button type="button" class="tb-jump" data-kind="cell" '
                f'data-exec-count="{ec}" data-line="{ln}"{own_attr}>{line_html}</button>'
            )
            continue
        fm = _TB_FILE_RE.search(plain)
        if fm:
            fpath = html.escape(fm.group(1), quote=True)
            ln = fm.group(2)
            rendered.append(
                f'<button type="button" class="tb-jump" data-kind="file" '
                f'data-path="{fpath}" data-line="{ln}">{line_html}</button>'
            )
            continue
        rendered.append(line_html)

    joined = "\n".join(rendered)
    return f'<pre class="output error">{joined}</pre>'


def _wrap_tables(safe_html: str) -> str:
    if "<table" not in safe_html.lower():
        return safe_html
    return re.sub(
        r"(<table\b.*?</table>)",
        r'<div class="table-scroll">\1</div>',
        safe_html,
        flags=re.IGNORECASE | re.DOTALL,
    )


def _join_text(val: Any) -> str:
    if isinstance(val, list):
        return "".join(str(x) for x in val)
    return str(val or "")


def _render_image_link(mime: str, raw_b64: str, alt: str) -> str:
    """Validate and escape base64 data URI before rendering clickable <a><img>."""
    cleaned = re.sub(r"\s+", "", raw_b64)
    if not cleaned or not _BASE64_RE.match(cleaned):
        return '<pre class="output error">Invalid base64 image data</pre>'
    src = html.escape(f"data:{mime};base64,{cleaned}", quote=True)
    safe_alt = html.escape(alt, quote=True)
    return (
        f'<a class="output img-link" href="{src}" target="_blank">'
        f'<img src="{src}" alt="{safe_alt}"></a>'
    )


def _render_rich_data(data: dict[str, Any], token: str, *, export: bool) -> str:
    if "image/png" in data:
        return _render_image_link("image/png", _join_text(data["image/png"]), "plot")
    if "image/jpeg" in data:
        return _render_image_link("image/jpeg", _join_text(data["image/jpeg"]), "image")
    if "image/svg+xml" in data:
        b64 = base64.b64encode(_join_text(data["image/svg+xml"]).encode("utf-8")).decode("ascii")
        return _render_image_link("image/svg+xml", b64, "svg")
    if "text/html" in data:
        safe = _wrap_tables(sanitize_html(_join_text(data["text/html"])))
        return f'<div class="output rich-html">{safe}</div>'
    if "text/markdown" in data:
        md_html = render_markdown(_join_text(data["text/markdown"]), token, export=export)
        return f'<div class="output rich-md">{md_html}</div>'
    if "text/latex" in data:
        math_html = render_math(_join_text(data["text/latex"]), display=True)
        return f'<div class="output rich-math">{math_html}</div>'
    if "text/plain" in data:
        text = apply_carriage_returns(_join_text(data["text/plain"]))
        return f'<pre class="output plain">{ansi_to_html(text)}</pre>'
    return ""


def render_output(
    output: dict[str, Any], own_index: int, token: str = "", *, export: bool = False
) -> str:
    if not isinstance(output, dict):
        return ""
    otype = output.get("output_type", "")
    if otype == "stream":
        name = output.get("name", "stdout")
        name = name if name in ("stdout", "stderr") else "stdout"
        text = apply_carriage_returns(_join_text(output.get("text", "")))
        return f'<pre class="output stream stream-{name}">{ansi_to_html(text)}</pre>'
    if otype == "error":
        tb = output.get("traceback")
        fallback = f"{output.get('ename', 'Error')}: {output.get('evalue', '')}"
        raw = "\n".join(str(x) for x in tb) if tb else fallback
        return render_traceback(raw, own_index=own_index)
    if otype in ("execute_result", "display_data"):
        data = output.get("data")
        return _render_rich_data(data, token, export=export) if isinstance(data, dict) else ""
    return ""


def _render_code_header(
    idx: int, cell: dict[str, Any], stale_info: dict[str, Any] | None, *, export: bool
) -> str:
    status = cell.get("status", "idle")
    has_error = bool(cell.get("has_error", False))
    ec = cell.get("execution_count")
    ec_label = f"[{ec}]" if ec is not None else "[ ]"
    badge = ""
    if status == "busy":
        badge = '<span class="badge badge-busy">● running</span>'
    elif has_error:
        badge = '<span class="badge badge-err">✗ error</span>'
    elif stale_info:
        reason_str = dag.format_stale_reasons(stale_info)
        label = f"⚠ stale ({reason_str})" if reason_str else "⚠ stale"
        badge = f'<span class="badge badge-stale">{html.escape(label)}</span>'
    elif ec is not None:
        badge = '<span class="badge badge-ok">✓</span>'

    dur_ms = cell.get("duration_ms")
    dur = f"<span>{dur_ms / 1000:.1f}s</span>" if isinstance(dur_ms, (int, float)) else ""
    interrupt = (
        '<button type="button" class="interrupt-btn" title="Interrupt kernel">■</button>'
        if status == "busy" and not export
        else ""
    )
    return (
        f'<div class="cell-header"><span>#{idx + 1}</span><span>{ec_label}</span>'
        f"{badge}{dur}{interrupt}</div>"
    )


def render_cell_html(
    cell: dict[str, Any],
    stale_info: dict[str, Any] | None = None,
    *,
    token: str = "",
    report: bool = False,
    active: bool = False,
    export: bool = False,
) -> str:
    idx = int(cell.get("index", 0))
    cell_type = str(cell.get("cell_type", "code"))
    source = _join_text(cell.get("source", ""))

    classes = ["cell", f"cell-{cell_type}"]
    if active:
        classes.append("active")
    if stale_info and not report:
        classes.append("stale")
    cls_str = " ".join(classes)

    if cell_type == "markdown":
        body = render_markdown(source, token=token, export=export)
        return f'<section id="cell-{idx}" class="{cls_str}" data-index="{idx}">{body}</section>'
    if cell_type == "raw":
        body = f'<pre class="raw">{html.escape(source)}</pre>'
        return f'<section id="cell-{idx}" class="{cls_str}" data-index="{idx}">{body}</section>'

    outputs = cell.get("outputs") if isinstance(cell.get("outputs"), list) else []
    rendered_outputs = [
        rendered
        for out in outputs
        if (rendered := render_output(out, own_index=idx, token=token, export=export))
    ]
    if report and not rendered_outputs:
        return ""

    parts: list[str] = []
    if not report:
        parts.append(_render_code_header(idx, cell, stale_info, export=export))
        parts.append(f'<div class="cell-input">{highlight_code(source, "python")}</div>')
    if rendered_outputs:
        parts.append(f'<div class="cell-outputs">{"".join(rendered_outputs)}</div>')

    inner = "".join(parts)
    return f'<section id="cell-{idx}" class="{cls_str}" data-index="{idx}">{inner}</section>'


def render_document(
    cells: list[dict[str, Any]],
    stale_map: dict[int, dict[str, Any]] | None = None,
    title: str = "Notebook",
    *,
    report: bool = False,
    export: bool = False,
    token: str = "",
    active_index: int | None = None,
) -> str:
    """Render full standalone HTML document from page.html template."""
    with open(_TEMPLATE_PATH, "r", encoding="utf-8") as fh:
        template = fh.read()

    stale_map = stale_map or {}
    cell_fragments: list[str] = []
    for idx, cell in enumerate(cells):
        c = dict(cell) if isinstance(cell, dict) else {}
        c.setdefault("index", idx)
        frag = render_cell_html(
            c,
            stale_map.get(idx),
            token=token,
            report=report,
            active=(active_index == idx),
            export=export,
        )
        if frag:
            cell_fragments.append(frag)

    if export:
        doc = re.sub(r"<!--LIVE_BAR-->.*?<!--/LIVE_BAR-->\s*", "", template, flags=re.DOTALL)
        doc = re.sub(r"<!--LIVE_SCRIPT-->.*?<!--/LIVE_SCRIPT-->\s*", "", doc, flags=re.DOTALL)
    else:
        qtok = urllib.parse.quote(token, safe="")
        doc = template.replace("<!--LIVE_BAR-->", "").replace("<!--/LIVE_BAR-->", "")
        doc = doc.replace("<!--LIVE_SCRIPT-->", "").replace("<!--/LIVE_SCRIPT-->", "")
        doc = doc.replace("{{TOKEN_URL}}", qtok)
        doc = doc.replace("{{TOKEN_JSON}}", json.dumps(token))

    doc = doc.replace("{{TITLE}}", html.escape(title))
    doc = doc.replace("{{PYGMENTS_CSS}}", pygments_css())
    doc = doc.replace("{{CELLS}}", "\n".join(cell_fragments))
    return doc
