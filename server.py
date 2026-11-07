#!/usr/bin/env python3
"""Local server for sparkgap.

Serves the web app and stores practice history as JSON Lines, so the data
stays in plain files that are easy to inspect, back up, or analyse.
Standard library only.

    python3 server.py [--port 8073] [--data-dir ./data]
"""

import argparse
import json
import threading
import webbrowser
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
MAX_BODY = 64 * 1024


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".woff2": "font/woff2",
    }

    def __init__(self, *args, data_dir: Path, lock: threading.Lock, **kwargs):
        self.data_dir = data_dir
        self.lock = lock
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    # Paths -----------------------------------------------------------------

    @property
    def attempts_file(self) -> Path:
        return self.data_dir / "attempts.jsonl"

    @property
    def settings_file(self) -> Path:
        return self.data_dir / "settings.json"

    def route(self) -> str:
        return urlsplit(self.path).path

    # HTTP verbs ------------------------------------------------------------

    def do_GET(self):
        path = self.route()
        if path == "/api/health":
            return self.send_json({"ok": True})
        if path == "/api/attempts":
            return self.send_json(self.read_attempts())
        if path == "/api/settings":
            return self.send_json(self.read_settings())
        return super().do_GET()

    def do_POST(self):
        if self.route() != "/api/attempts":
            return self.send_error(HTTPStatus.NOT_FOUND)
        record = self.read_body()
        if record is None:
            return
        with self.lock, self.attempts_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, separators=(",", ":")) + "\n")
        self.send_json({"ok": True}, HTTPStatus.CREATED)

    def do_PUT(self):
        if self.route() != "/api/settings":
            return self.send_error(HTTPStatus.NOT_FOUND)
        settings = self.read_body()
        if settings is None:
            return
        with self.lock:
            tmp = self.settings_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(settings, indent=2), encoding="utf-8")
            tmp.replace(self.settings_file)
        self.send_json({"ok": True})

    # Helpers ---------------------------------------------------------------

    def end_headers(self):
        # The app is served from disk during development; always revalidate.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def read_body(self):
        """Parse a JSON object from the request body, or reply 400 and return None."""
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            self.send_error(HTTPStatus.BAD_REQUEST, "Body must be 1 byte to 64 KiB")
            return None
        try:
            data = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Body is not valid JSON")
            return None
        if not isinstance(data, dict):
            self.send_error(HTTPStatus.BAD_REQUEST, "Body must be a JSON object")
            return None
        return data

    def read_attempts(self):
        if not self.attempts_file.exists():
            return []
        out = []
        with self.lock, self.attempts_file.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue  # skip a line truncated by a crash
        return out

    def read_settings(self):
        try:
            return json.loads(self.settings_file.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if self.route().startswith("/api/") and self.command == "GET":
            return  # keep the console readable
        super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser(description="Serve sparkgap and store practice data.")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8073)
    ap.add_argument("--data-dir", type=Path, default=ROOT / "data",
                    help="where practice history is stored (default: ./data)")
    ap.add_argument("--open", action="store_true", help="open the app in a browser")
    args = ap.parse_args()

    args.data_dir.mkdir(parents=True, exist_ok=True)
    handler = partial(Handler, data_dir=args.data_dir.resolve(), lock=threading.Lock())
    server = ThreadingHTTPServer((args.host, args.port), handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"sparkgap running at {url}")
    print(f"Practice data: {args.data_dir.resolve()}")
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
