"""Keep the Content-Security-Policy in index.html in step with its inline import map.

The CSP allows the import map by the sha256 hash of its exact text, so every change to the
import map (including a ?v= cache-busting bump) needs a new hash, or the browser blocks it
and the app cannot start.

    python scripts/update_csp.py                  # recompute the hash only
    python scripts/update_csp.py --bump 20261020-1  # change every ?v= tag, then recompute
"""
import argparse
import base64
import hashlib
import re
import sys
from pathlib import Path

INDEX = Path(__file__).resolve().parent.parent / 'index.html'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--bump', metavar='TAG', help='new ?v= tag for every local JS/CSS file')
    args = parser.parse_args()

    # newline='' keeps the file's line endings: the hash covers them too.
    with INDEX.open(encoding='utf-8', newline='') as f:
        html = f.read()

    if args.bump:
        if not re.fullmatch(r'[\w.-]+', args.bump):
            sys.exit('tag may only contain letters, digits, ".", "_" and "-"')
        html, count = re.subn(r'\?v=[\w.-]+', f'?v={args.bump}', html)
        print(f'?v= tags updated: {count}')

    importmap = re.search(r'<script type="importmap">(.*?)</script>', html, re.S)
    if not importmap:
        sys.exit('no <script type="importmap"> in index.html')
    digest = base64.b64encode(hashlib.sha256(importmap.group(1).encode('utf-8')).digest()).decode()

    html, count = re.subn(r"'sha256-[^']*'", f"'sha256-{digest}'", html, count=1)
    if not count:
        sys.exit("no 'sha256-…' source in the Content-Security-Policy")

    with INDEX.open('w', encoding='utf-8', newline='') as f:
        f.write(html)
    print(f"import map hash: sha256-{digest}")


if __name__ == '__main__':
    main()
