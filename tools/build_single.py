#!/usr/bin/env python3
"""Bundle the app into one self-contained HTML file.

Everything is inlined -- no separate CSS, JS, or icon requests -- so the result
can be hosted anywhere, AirDropped, or opened straight off disk. The multi-file
version under the repo root stays the source of truth; this is derived.

    python3 tools/build_single.py

Writes:
  dist/lanechange.html   full standalone document
  dist/artifact.html     same page as body content, for hosts that supply
                         their own <!doctype>/<head>/<body> wrapper
"""

import base64
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")


def read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as handle:
        return handle.read()


def bundled_script():
    """nav.js + openings.js + app.js as one inline module."""
    nav = read("nav.js")
    openings = read("openings.js")
    app = read("app.js")

    # Inlining removes the module boundary, so the export/import pair goes too.
    nav = re.sub(r"^export (?=const|function|class)", "", nav, flags=re.MULTILINE)
    openings = re.sub(r"^export (?=const|function|class)", "", openings, flags=re.MULTILINE)
    # MULTILINE matters: these imports do not all sit at the top of their file.
    strip = lambda src, mod: re.sub(
        r"^import \{[\s\S]*?\} from '\./" + mod + r"\.js';\n", "", src, count=1, flags=re.MULTILINE
    )
    openings = strip(openings, "nav")
    app = strip(app, "nav")
    app = strip(app, "openings")

    # There is no sw.js beside a single-file build, and registering it would
    # just 404 in the console.
    app, swept = re.subn(
        r"if \('serviceWorker' in navigator\) \{[\s\S]*?\n\}\n", "", app, count=1
    )
    if not swept:
        raise SystemExit("service worker registration not found — check the pattern")

    if "from './openings.js'" in app:
        raise SystemExit("app.js still imports openings.js after stripping")
    if "from './nav.js'" in openings:
        raise SystemExit("openings.js still imports nav.js after stripping")
    if re.search(r"^export ", openings, flags=re.MULTILINE):
        raise SystemExit("openings.js still has exports after stripping")
    if "from './nav.js'" in app:
        raise SystemExit("app.js still imports nav.js after stripping — check the pattern")
    if re.search(r"^export ", nav, flags=re.MULTILINE):
        raise SystemExit("nav.js still has exports after stripping — check the pattern")

    return (
        f"/* --- nav.js --- */\n{nav}\n"
        f"/* --- openings.js --- */\n{openings}\n"
        f"/* --- app.js --- */\n{app}"
    )


def data_uri(name):
    with open(os.path.join(ROOT, name), "rb") as handle:
        return "data:image/png;base64," + base64.b64encode(handle.read()).decode()


def build():
    html = read("index.html").replace("__BUILD__", "single-file")
    icon = data_uri("icons/icon-180.png")

    # The bundle has no service worker and no separate files to fetch.
    html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', "")
    html = html.replace('<link rel="stylesheet" href="styles.css">',
                        "<style>\n" + read("styles.css") + "</style>")
    html = html.replace('<link rel="apple-touch-icon" href="icons/icon-180.png">',
                        f'<link rel="apple-touch-icon" href="{icon}">')
    html = html.replace('<link rel="icon" href="icons/icon-192.png">',
                        f'<link rel="icon" href="{icon}">')
    html = html.replace('<script type="module" src="app.js"></script>',
                        '<script type="module">\n' + bundled_script() + "\n</script>")

    if "src=" in html or 'href="styles' in html or "icons/" in html:
        raise SystemExit("something is still loaded from a separate file")

    os.makedirs(DIST, exist_ok=True)
    full = os.path.join(DIST, "lanechange.html")
    with open(full, "w", encoding="utf-8") as handle:
        handle.write(html)

    # Body-content form: keep <title>, drop the document scaffolding.
    body = re.sub(r"^[\s\S]*?<title>", "<title>", html, count=1)
    body = body.replace("</title>", "</title>\n", 1)
    body = re.sub(r"</head>\s*<body>", "", body, count=1)
    body = re.sub(r"\s*</body>\s*</html>\s*$", "\n", body, count=1)
    frag = os.path.join(DIST, "artifact.html")
    with open(frag, "w", encoding="utf-8") as handle:
        handle.write(body)

    for path in (full, frag):
        print(f"{os.path.relpath(path, ROOT)}  {os.path.getsize(path):,} bytes")


if __name__ == "__main__":
    build()
