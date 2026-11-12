import socket
import webbrowser
import http.server
import socketserver
import os
import json
import time
import random

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE_DIR, 'game_state.json')

# Live reload: browsers auto-refresh when .html/.css/.js files change.
# Disable with environment variable LIVERELOAD=0.
LIVE_RELOAD = os.environ.get('LIVERELOAD', '1') != '0'
LIVE_EXTS = ('.html', '.htm', '.css', '.js')
LIVE_SCRIPT = b"""<script>(function(){var tok=null;function chk(){fetch('/__livereload',{cache:'no-store'}).then(function(r){return r.text()}).then(function(t){if(tok===null)tok=t;else if(t!==tok){location.reload();return}setTimeout(chk,1000)}).catch(function(){setTimeout(chk,2000)})}chk()})();</script>"""
_live_cache = {"t": 0.0, "sig": ""}


def live_signature():
    now = time.time()
    if now - _live_cache["t"] < 0.5:
        return _live_cache["sig"]
    latest = 0.0
    count = 0
    for root, dirs, files in os.walk(BASE_DIR):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d != '__pycache__']
        for name in files:
            if name.lower().endswith(LIVE_EXTS):
                try:
                    latest = max(latest, os.path.getmtime(os.path.join(root, name)))
                    count += 1
                except OSError:
                    pass
    _live_cache["t"] = now
    _live_cache["sig"] = f"{latest:.3f}-{count}"
    return _live_cache["sig"]

DEFAULT_CFG = {
    "ver": 3,
    "adminPass": "1234",
    "start": 10000000,
    "startBonus": 1000000,
    "dd": 500000,
    "ins": 500000,
    "debtMax": 1500000,
    "price": {
        "sukuk": 1000000,
        "saham": 500000,
        "rpu": 100000,
        "apt": 1800000,
        "rumah": 2500000
    },
    "cap": {
        "sukuk": 20,
        "saham": 100,
        "rpu": 200,
        "apt": 15,
        "rumah": 10
    },
    "inc": {
        "sukuk": 50000,
        "saham": 50000,
        "rpu": 5000
    },
    "rent": {
        "apt": 180000,
        "rumah": 250000
    }
}

ASSET_KEYS = ["sukuk", "saham", "rpu", "apt", "rumah"]

# Default 116-card deck index mapping:
# 0..49 -> positif (50 cards)
# 50..85 -> negatif (36 cards)
# 86..115 -> tantangan/quiz (30 cards)
DEFAULT_ORD = {
    "positif": list(range(0, 50)),
    "negatif": list(range(50, 86)),
    "tantangan": list(range(86, 116))
}


def make_uid(prefix=""):
    base = f"{int(time.time() * 1000):x}{random.randint(1000, 9999):x}"
    return f"{prefix}{base}" if prefix else base


def create_blank_team(team_id, name, pin, cfg=None):
    c = cfg or DEFAULT_CFG
    return {
        "id": team_id,
        "name": name,
        "pin": str(pin),
        "members": [],
        "cash": int(c.get("start", 10000000)),
        "dd": 1,
        "ins": 1,
        "debt": {"used": False, "out": 0},
        "assets": {a: {"q": 0, "v": 0, "c": 0} for a in ASSET_KEYS},
        "skip": 0,
        "fx": [],
        "years": 0,
        "vc": [],
        "pos": 0,
        "sp": 0
    }


def create_default_game():
    cfg = json.loads(json.dumps(DEFAULT_CFG))
    gid = make_uid("g_")
    default_pins = ["1111", "2222", "3333", "4444"]
    teams = {}
    order = []
    for i in range(4):
        tid = f"t{i + 1}"
        teams[tid] = create_blank_team(tid, f"Tim {i + 1}", default_pins[i], cfg)
        order.append(tid)

    now_ms = int(time.time() * 1000)
    g = {
        "gid": gid,
        "round": 1,
        "turn": 0,
        "order": order,
        "teams": teams,
        "stock": dict(cfg["cap"]),
        "cfg": cfg,
        "used": {"positif": [], "negatif": [], "tantangan": []},
        "ord": json.loads(json.dumps(DEFAULT_ORD)),
        "open": None,
        "over": False,
        "created": now_ms,
        "spin": None,
        "land": {},
        "tgt": {},
        "t0": None
    }
    logs = [
        {
            "id": make_uid("l_"),
            "kind": "info",
            "gid": gid,
            "t": now_ms,
            "r": 1,
            "by": "admin",
            "src": "Permainan siap",
            "txt": "4 tim awal dibuat dengan saldo Rp10.000.000, 1 Dana Darurat, dan 1 Asuransi All Risk."
        }
    ]
    return {
        "version": 1,
        "G": g,
        "L": logs,
        "CARDS": None
    }


def normalize_store(raw):
    if not isinstance(raw, dict):
        return create_default_game()

    # If migrating from an older non-Langkah-Barakah state file (missing "G"), reset cleanly
    if "G" not in raw or (raw.get("G") is not None and not isinstance(raw.get("G"), dict)):
        return create_default_game()

    g = raw.get("G")
    if isinstance(g, dict) and ("order" not in g or "teams" not in g or "cfg" not in g):
        return create_default_game()

    logs = raw.get("L")
    if not isinstance(logs, list):
        logs = []
    else:
        logs = logs[:1000]

    cards = raw.get("CARDS")
    if cards is not None and not isinstance(cards, list):
        cards = None

    version = int(raw.get("version", 1) or 1)
    return {
        "version": version,
        "G": g,
        "L": logs,
        "CARDS": cards
    }


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                raw = json.load(f)
            norm = normalize_store(raw)
            if "G" not in raw:
                save_state(norm)
            return norm
        except Exception:
            pass
    state = create_default_game()
    save_state(state)
    return state


def save_state(state):
    try:
        with open(STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[ERROR] Gagal menyimpan game_state.json: {e}")


def check_admin_login(password):
    pw = str(password or "").strip()
    state = load_state()
    g = state.get("G") or {}
    cfg = g.get("cfg") or {}
    configured = str(cfg.get("adminPass") or "1234").strip()
    valid = {configured, "1234", "admin123", "admin"} if configured == "1234" else {configured}
    if pw in valid:
        return {"ok": True, "code": 200, "status": "ok"}
    return {"ok": False, "code": 403, "status": "forbidden", "error": "Kode / kata sandi admin salah."}


def apply_action(incoming):
    current = load_state()
    action = incoming.get("action")

    if action == "saveG":
        current["G"] = incoming.get("G")
    elif action == "addLog":
        entry = incoming.get("entry")
        if isinstance(entry, dict):
            eid = entry.get("id")
            current["L"] = [x for x in current["L"] if x.get("id") != eid]
            current["L"].insert(0, entry)
            current["L"] = current["L"][:1000]
    elif action == "updLog":
        lid = incoming.get("id")
        patch = incoming.get("patch")
        if lid and isinstance(patch, dict):
            for item in current["L"]:
                if item.get("id") == lid:
                    item.update(patch)
                    break
    elif action == "saveCards":
        current["CARDS"] = incoming.get("CARDS")
    elif action == "joinTeam":
        tid = incoming.get("tid")
        pin = str(incoming.get("pin", "")).strip()
        uid = str(incoming.get("uid", "")).strip()
        uname = str(incoming.get("uname", "")).strip()
        g = current.get("G")
        if not isinstance(g, dict) or tid not in g.get("teams", {}):
            return {"ok": False, "code": 400, "status": "error", "error": "Tim tidak ditemukan.", "state": current}
        team = g["teams"][tid]
        if str(team.get("pin", "")).strip() != pin:
            return {"ok": False, "code": 403, "status": "forbidden", "error": "Kode PIN 4 angka salah.", "state": current}
        for t_obj in g["teams"].values():
            members = t_obj.get("members") or []
            t_obj["members"] = [m for m in members if m != uid]
        team_members = team.get("members") or []
        if uid and uid not in team_members:
            team_members.append(uid)
        team["members"] = team_members
        if uname and uid:
            names = g.get("names") or {}
            names[uid] = uname
            g["names"] = names
    else:
        if "G" in incoming:
            current["G"] = incoming["G"]
        if "L" in incoming and isinstance(incoming["L"], list):
            current["L"] = incoming["L"][:1000]
        if "CARDS" in incoming:
            current["CARDS"] = incoming["CARDS"]

    current["version"] = int(current.get("version", 1)) + 1
    normalized = normalize_store(current)
    save_state(normalized)
    return {"ok": True, "code": 200, "status": "ok", "version": normalized["version"], "state": normalized}


class BoardGameRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if self.command == 'GET' and (self.path.startswith('/api/state') or self.path.startswith('/__livereload')):
            return
        super().log_message(fmt, *args)

    def send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store')

    def send_json(self, status_code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        clean_path = self.path.split('?')[0].rstrip('/')
        if not clean_path:
            clean_path = '/'

        if self.path.startswith('/api/state'):
            state = load_state()
            self.send_json(200, state)
        elif self.path.startswith('/__livereload'):
            data = live_signature().encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', str(len(data)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(data)
        elif clean_path in ('/admin', '/admin.html'):
            self.path = '/operator.html'
            self.serve_file()
        elif clean_path in ('/play', '/play.html'):
            self.path = '/play.html'
            self.serve_file()
        elif clean_path in ('/qr', '/qr.html', '/barcode', '/barcode.html'):
            self.path = '/barcode.html'
            self.serve_file()
        elif clean_path in ('/', '/landing', '/landing.html'):
            self.path = '/landing.html'
            self.serve_file()
        else:
            self.serve_file()

    def serve_file(self):
        if not LIVE_RELOAD:
            return super().do_GET()
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            landing_candidate = os.path.join(path, 'landing.html')
            path = landing_candidate if os.path.isfile(landing_candidate) else os.path.join(path, 'index.html')
        if not (path.lower().endswith(('.html', '.htm')) and os.path.isfile(path)):
            return super().do_GET()
        try:
            with open(path, 'rb') as f:
                body = f.read()
        except OSError:
            return super().do_GET()
        idx = body.lower().rfind(b'</body>')
        body = body[:idx] + LIVE_SCRIPT + body[idx:] if idx != -1 else body + LIVE_SCRIPT
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.startswith('/api/admin-login'):
            content_len = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_len).decode('utf-8')
            try:
                incoming = json.loads(body) if body else {}
                result = check_admin_login(incoming.get("password", ""))
                code = result.pop("code", 200)
                self.send_json(code, result)
            except Exception as e:
                self.send_json(400, {"ok": False, "error": str(e)})
        elif self.path.startswith('/api/state'):
            content_len = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_len).decode('utf-8')
            try:
                incoming = json.loads(body)
                result = apply_action(incoming)
                code = result.pop("code", 200)
                self.send_json(code, result)
            except Exception as e:
                self.send_json(400, {"error": str(e)})
        elif self.path.startswith('/api/reset'):
            current = load_state()
            state = create_default_game()
            state["version"] = int(current.get("version", 1)) + 1
            save_state(state)
            self.send_json(200, {"status": "ok", "version": state["version"], "state": state})
        else:
            self.send_response(404)
            self.end_headers()


def get_active_ip():
    probes = [('8.8.8.8', 80), ('1.1.1.1', 80), ('192.168.1.1', 80), ('10.254.254.254', 80)]
    for p in probes:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(0.3)
            s.connect(p)
            ip = s.getsockname()[0]
            s.close()
            if ip and not ip.startswith('127.'):
                return ip
        except Exception:
            pass
    try:
        ip = socket.gethostbyname(socket.gethostname())
        if ip and not ip.startswith('127.'):
            return ip
    except Exception:
        pass
    return '127.0.0.1'


def run():
    port = int(os.environ.get('PORT', 8080))
    ip = get_active_ip()

    print("=" * 60)
    print("   SERVER LANGKAH BARAKAH (DESIGN V2 - LAN SYNC)")
    print("=" * 60)
    print(f"\nAlamat IP Jaringan Terdeteksi : {ip}")
    print(f"\n1. Landing Page / Portal Hub  : http://localhost:{port}/ (atau http://{ip}:{port}/)")
    print(f"2. Halaman Pemain (HP Tim)    : http://{ip}:{port}/play")
    print(f"3. Login & Panel Operator     : http://localhost:{port}/admin (Sandi default: 1234)")
    print(f"4. Layar QR & PIN Aula        : http://localhost:{port}/qr?ip={ip}\n")
    print("Membuka Portal Hub Langkah Barakah di peramban...")

    try:
        webbrowser.open(f"http://localhost:{port}/")
        webbrowser.open(f"http://localhost:{port}/qr?ip={ip}")
    except Exception as e:
        print(f"[CATATAN] Tidak dapat membuka browser otomatis: {e}")

    print("\nServer berjalan di port 8080.")
    print(f"Live reload: {'AKTIF (halaman refresh otomatis saat file .html/.css/.js disimpan)' if LIVE_RELOAD else 'NONAKTIF'}")
    print("Tekan Ctrl+C untuk keluar.")
    print("-" * 60)

    base_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(base_dir)

    load_state()

    socketserver.TCPServer.allow_reuse_address = True
    Handler = BoardGameRequestHandler

    try:
        with socketserver.TCPServer(("", port), Handler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer dihentikan.")
    except Exception as err:
        print(f"\n[KESALAHAN] Gagal menjalankan server: {err}")


if __name__ == '__main__':
    run()
