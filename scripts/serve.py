"""Local development server for Earth 3D.

Like `python -m http.server`, but every response carries `Cache-Control: no-cache`, so the
browser revalidates index.html on each load. Without it Chrome caches index.html heuristically
(for hours), and keeps running an old page, with an old Content-Security-Policy and old ?v= tags,
after the files have changed.

    python scripts/serve.py          # http://localhost:8000
    python scripts/serve.py 8080
"""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description='Serve Earth 3D locally without stale caching.')
    parser.add_argument('port', nargs='?', type=int, default=8000)
    parser.add_argument('--bind', default='127.0.0.1', help='address to listen on (default: this computer only)')
    args = parser.parse_args()

    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        host = 'localhost' if args.bind in ('127.0.0.1', '0.0.0.0') else args.bind
        print(f'Earth 3D: http://{host}:{args.port}  (Ctrl+C to stop)')
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
