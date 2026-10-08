#!/usr/bin/env python3
"""Allow `microphone` inside VS Code webviews (code-server build step).

Stock VS Code never grants the microphone to webview iframes, so the Voice
Control side panel could not hear anything. Two files carry the allow-lists:

  1. .../webview/browser/pre/index.html   (inner content iframe, inline script)
  2. .../workbench/workbench.web.main.internal.js   (outer webview host iframe)

The first one is protected by a Content-Security-Policy hash of its own inline
script, so after editing the script the hash in the CSP meta tag must be
recomputed; otherwise the browser blocks the script and EVERY webview dies.

Usage: patch-webview-microphone.py <code-server-root>   (idempotent)
Exit code 0 on success or when already patched; 1 when a pattern is missing
(the build should warn, not fail: the phone/tab remote still works).
"""
import base64
import hashlib
import re
import sys

root = sys.argv[1].rstrip("/")
PRE = f"{root}/lib/vscode/out/vs/workbench/contrib/webview/browser/pre/index.html"
WB = f"{root}/lib/vscode/out/vs/workbench/workbench.web.main.internal.js"
ok = True

# ---- 1. inner iframe allow-list + CSP hash -------------------------------------
try:
    html = open(PRE, encoding="utf-8").read()
except OSError as e:
    print(f"WARNING: cannot read {PRE}: {e}")
    ok = False
else:
    old = "['cross-origin-isolated;', 'autoplay;', 'local-network-access;']"
    new = "['cross-origin-isolated;', 'autoplay;', 'local-network-access;', 'microphone;']"
    if new in html:
        print("Webview content iframe: microphone already allowed")
    elif old in html:
        html = html.replace(old, new, 1)
        print("Webview content iframe: microphone allowed")
    else:
        print("WARNING: webview pre/index.html allow-list pattern not found; side-panel microphone may not work")
        ok = False
    if ok:
        scripts = re.findall(r"<script[^>]*>(.*?)</script>", html, re.S)
        m = re.search(r"script-src 'sha256-([^']+)'", html)
        if len(scripts) != 1 or not m:
            print("WARNING: unexpected pre/index.html layout (scripts=%d, csp=%s); restoring original" % (len(scripts), bool(m)))
            ok = False
        else:
            digest = base64.b64encode(hashlib.sha256(scripts[0].encode("utf-8")).digest()).decode()
            if digest != m.group(1):
                html = html.replace(f"'sha256-{m.group(1)}'", f"'sha256-{digest}'", 1)
                print(f"Webview content iframe: CSP script hash updated to sha256-{digest}")
            else:
                print("Webview content iframe: CSP script hash already current")
            open(PRE, "w", encoding="utf-8").write(html)

# ---- 2. outer iframe allow-list ---------------------------------------------------
try:
    js = open(WB, encoding="utf-8").read()
except OSError as e:
    print(f"WARNING: cannot read {WB}: {e}")
    ok = False
else:
    old = '["cross-origin-isolated","autoplay","local-network-access"]'
    new = '["cross-origin-isolated","autoplay","local-network-access","microphone"]'
    if new in js:
        print("Webview host iframe: microphone already allowed")
    elif js.count(old) == 1:
        open(WB, "w", encoding="utf-8").write(js.replace(old, new, 1))
        print("Webview host iframe: microphone allowed")
    else:
        print(f"WARNING: workbench allow-list pattern found {js.count(old)} times (expected 1); side-panel microphone may not work")
        ok = False

sys.exit(0 if ok else 1)
