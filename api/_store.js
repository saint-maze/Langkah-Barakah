const fs = require("fs");
const crypto = require("crypto");

const TMP_FILE = "/tmp/langkah_barakah_state.json";
const STATE_KEY = process.env.LB_STATE_KEY || "langkah_barakah:state:v1";
const VER_KEY = `${STATE_KEY}:ver`;
const DEFAULT_ADMIN_PASS = (process.env.ADMIN_PASSWORD || "cihuymenang").trim() || "cihuymenang";
const SESSION_COOKIE_SECURE = "__Host-lb_admin";
const SESSION_COOKIE_PLAIN = "lb_admin";
const SESSION_TTL_MS = Math.max(60 * 1000, Number(process.env.LB_SESSION_TTL_MS || 12 * 60 * 60 * 1000));
const LOGIN_RL_WINDOW_MS = Math.max(10 * 1000, Number(process.env.LB_LOGIN_RL_WINDOW_MS || 5 * 60 * 1000));
const LOGIN_RL_MAX_FAILS = Math.max(2, Number(process.env.LB_LOGIN_RL_MAX || 8));
const PIN_RL_MAX_FAILS = Math.max(3, Number(process.env.LB_PIN_RL_MAX || 15));
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const HAS_REDIS = !!(KV_URL && KV_TOKEN);
const STORAGE_KIND = HAS_REDIS ? "redis" : "tmp";

// Warm container L1 cache TTL before checking Redis version key (ms)
const L1_TTL_MS = Math.max(0, Number(process.env.LB_CACHE_TTL_MS || 800));
const REDIS_TIMEOUT_MS = Math.max(500, Number(process.env.LB_REDIS_TIMEOUT_MS || 2500));

function getSessionSecret() {
  const explicit = (process.env.LB_SESSION_SECRET || process.env.SESSION_SECRET || "").trim();
  if (explicit) {
    return crypto.createHash("sha256").update(explicit, "utf8").digest();
  }
  const seed = [
    KV_TOKEN,
    DEFAULT_ADMIN_PASS,
    STATE_KEY,
    (process.env.ADMIN_PASSWORD || "").trim(),
    "lb-session-key-v1"
  ].join("|");
  return crypto.createHash("sha256").update(seed, "utf8").digest();
}

function timingSafeStrEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a || ""), "utf8").digest();
  const hb = crypto.createHash("sha256").update(String(b || ""), "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sanitizeData(val, depth = 0) {
  if (depth > 25) return null;
  if (val === null || val === undefined) return val;
  if (typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(item => sanitizeData(item, depth + 1));
  const clean = {};
  for (const [k, v] of Object.entries(val)) {
    if (POISON_KEYS.has(k)) continue;
    clean[k] = sanitizeData(v, depth + 1);
  }
  return clean;
}

function isSecureRequest(req) {
  if (!req || !req.headers) return false;
  const xfp = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (xfp === "https") return true;
  return !!(req.socket && req.socket.encrypted);
}

function parseCookies(req) {
  const out = Object.create(null);
  const raw = req && req.headers && req.headers.cookie;
  if (!raw || typeof raw !== "string") return out;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k || POISON_KEYS.has(k)) continue;
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch (e) {
      out[k] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

function getClientIp(req) {
  if (!req) return "local";
  const realIp = req.headers && req.headers["x-real-ip"];
  if (realIp) return String(realIp).trim().slice(0, 64);
  const xff = req.headers && req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim().slice(0, 64) || "local";
  return String((req.socket && req.socket.remoteAddress) || "local").slice(0, 64);
}

function getRateLimitMap() {
  if (!(global.__LB_RL__ instanceof Map)) {
    global.__LB_RL__ = new Map();
  }
  return global.__LB_RL__;
}

function checkRateLimit(bucket, maxFails, windowMs) {
  const map = getRateLimitMap();
  const rec = map.get(bucket);
  if (!rec) return { allowed: true };
  const now = Date.now();
  if (now >= rec.resetAt) {
    map.delete(bucket);
    return { allowed: true };
  }
  if (rec.count >= maxFails) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((rec.resetAt - now) / 1000)) };
  }
  return { allowed: true };
}

function recordFailure(bucket, windowMs) {
  const map = getRateLimitMap();
  const now = Date.now();
  if (map.size >= 2000) {
    for (const [k, v] of map.entries()) {
      if (now >= v.resetAt) map.delete(k);
    }
    if (map.size >= 2000) map.delete(map.keys().next().value);
  }
  const cur = map.get(bucket);
  if (!cur || now >= cur.resetAt) {
    map.set(bucket, { count: 1, resetAt: now + windowMs });
  } else {
    cur.count += 1;
  }
}

function clearFailures(bucket) {
  getRateLimitMap().delete(bucket);
}

function getRequestHost(req) {
  if (!req || !req.headers) return "";
  return String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
}

function checkMutationOrigin(req) {
  if (!req || !req.headers) return { ok: true };
  const sfs = String(req.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (sfs === "cross-site") {
    return { ok: false, code: 403, status: "forbidden", error: "Permintaan cross-site ditolak." };
  }
  const origin = req.headers.origin;
  const host = getRequestHost(req);
  if (origin && host) {
    try {
      const oHost = new URL(origin).host.toLowerCase();
      if (!oHost || oHost !== host) {
        return { ok: false, code: 403, status: "forbidden", error: "Origin tidak diizinkan." };
      }
    } catch (e) {
      return { ok: false, code: 403, status: "forbidden", error: "Origin tidak valid." };
    }
  }
  return { ok: true };
}

const DEFAULT_CFG = {
  ver: 3,
  adminPass: DEFAULT_ADMIN_PASS,
  start: 10000000,
  startBonus: 1000000,
  dd: 500000,
  ins: 500000,
  debtMax: 1500000,
  price: { sukuk: 1000000, saham: 500000, rpu: 100000, apt: 1800000, rumah: 2500000 },
  cap: { sukuk: 20, saham: 100, rpu: 200, apt: 15, rumah: 10 },
  inc: { sukuk: 50000, saham: 50000, rpu: 5000 },
  rent: { apt: 180000, rumah: 250000 }
};

const ASSET_KEYS = ["sukuk", "saham", "rpu", "apt", "rumah"];
const DEFAULT_ORD = {
  positif: Array.from({ length: 50 }, (_, i) => i),
  negatif: Array.from({ length: 36 }, (_, i) => i + 50),
  tantangan: Array.from({ length: 40 }, (_, i) => i + 86)
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function makeUid(prefix = "") {
  const base = Date.now().toString(36) + Math.floor(1000 + Math.random() * 9000).toString(36);
  return prefix ? prefix + base : base;
}

function createBlankTeam(id, name, pin, cfg) {
  const c = cfg || DEFAULT_CFG;
  const assets = {};
  for (const a of ASSET_KEYS) assets[a] = { q: 0, v: 0, c: 0 };
  return {
    id,
    name,
    pin: String(pin),
    members: [],
    cash: Number(c.start || 10000000),
    dd: 1,
    ins: 1,
    debt: { used: false, out: 0 },
    assets,
    skip: 0,
    fx: [],
    years: 0,
    vc: [],
    pos: 0,
    sp: 0
  };
}

function createDefaultGame() {
  const cfg = clone(DEFAULT_CFG);
  const teams = {};
  const order = [];
  for (let i = 1; i <= 4; i++) {
    const tid = "t" + i;
    teams[tid] = createBlankTeam(tid, "Tim " + i, String(1111 * i), cfg);
    order.push(tid);
  }
  return {
    version: 1,
    G: {
      gid: makeUid(),
      round: 1,
      turn: 0,
      order,
      teams,
      stock: clone(cfg.cap),
      cfg,
      used: { positif: [], negatif: [], tantangan: [] },
      ord: clone(DEFAULT_ORD),
      open: null,
      spin: null,
      land: {},
      lq: {},
      pause: null,
      pzTot: 0,
      tgt: null,
      t0: null,
      over: false,
      created: Date.now()
    },
    L: [
      {
        id: makeUid("l_"),
        kind: "info",
        t: Date.now(),
        r: 1,
        by: "lokal",
        src: "Permainan dibuat",
        txt: "4 tim awal dibuat dengan saldo Rp10.000.000, 1 Dana Darurat, dan 1 Asuransi All Risk."
      }
    ],
    CARDS: null
  };
}

function getConfiguredAdminPass(state) {
  return String((state && state.G && state.G.cfg && state.G.cfg.adminPass) || DEFAULT_ADMIN_PASS).trim() || DEFAULT_ADMIN_PASS;
}

function pwFingerprint(pw) {
  return crypto.createHmac("sha256", getSessionSecret()).update(String(pw || ""), "utf8").digest("hex").slice(0, 16);
}

function createAdminCookieHeader(req, adminPass) {
  const now = Date.now();
  const payload = { r: "admin", iat: now, exp: now + SESSION_TTL_MS, pv: pwFingerprint(adminPass) };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sigB64 = crypto.createHmac("sha256", getSessionSecret()).update(payloadB64, "utf8").digest("base64url");
  const secure = isSecureRequest(req);
  const name = secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const attrs = [`${name}=${payloadB64}.${sigB64}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function clearAdminCookieHeaders(req) {
  const exp = "Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
  const out = [`${SESSION_COOKIE_PLAIN}=; Path=/; HttpOnly; SameSite=Lax; ${exp}`];
  if (isSecureRequest(req)) {
    out.unshift(`${SESSION_COOKIE_SECURE}=; Path=/; HttpOnly; SameSite=Lax; Secure; ${exp}`);
  }
  return out;
}

function verifyAdminRequest(req, state) {
  const cookies = parseCookies(req);
  const tok = isSecureRequest(req)
    ? (cookies[SESSION_COOKIE_SECURE] || cookies[SESSION_COOKIE_PLAIN] || "")
    : (cookies[SESSION_COOKIE_SECURE] || cookies[SESSION_COOKIE_PLAIN] || "");
  if (!tok || typeof tok !== "string") return { valid: false };
  const dot = tok.indexOf(".");
  if (dot <= 0 || dot === tok.length - 1 || tok.indexOf(".", dot + 1) !== -1) return { valid: false };
  const payloadB64 = tok.slice(0, dot);
  const sigB64 = tok.slice(dot + 1);
  let sigBuf;
  try {
    sigBuf = Buffer.from(sigB64, "base64url");
  } catch (e) {
    return { valid: false };
  }
  const expectedBuf = crypto.createHmac("sha256", getSessionSecret()).update(payloadB64, "utf8").digest();
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch (e) {
    return { valid: false };
  }
  if (!payload || payload.r !== "admin" || typeof payload.exp !== "number" || payload.exp <= Date.now()) {
    return { valid: false };
  }
  const expectedPv = pwFingerprint(getConfiguredAdminPass(state));
  if (!payload.pv || !timingSafeStrEqual(payload.pv, expectedPv)) {
    return { valid: false };
  }
  return { valid: true, payload };
}

function redactAdminPass(state) {
  const pub = clone(state);
  if (pub && pub.G && pub.G.cfg) {
    pub.G.cfg.adminPass = "";
  }
  return pub;
}

function normalizeStore(raw) {
  if (!raw || typeof raw !== "object" || !("G" in raw)) return createDefaultGame();
  if (raw.G !== null && typeof raw.G !== "object") return createDefaultGame();
  const cleanRaw = sanitizeData(raw);
  const g = cleanRaw.G;
  if (g && (!Array.isArray(g.order) || !g.teams || typeof g.teams !== "object" || !g.cfg || typeof g.cfg !== "object")) return createDefaultGame();
  if (g && !g.cfg.adminPass) g.cfg.adminPass = DEFAULT_ADMIN_PASS;
  const logs = Array.isArray(cleanRaw.L) ? cleanRaw.L.slice(0, 1000) : [];
  const cards = Array.isArray(cleanRaw.CARDS) ? cleanRaw.CARDS : null;
  const version = Number(cleanRaw.version) || 1;
  return { version, G: g, L: logs, CARDS: cards };
}

function makeEtag(version, scope = "pub") {
  return `"lb-v${Number(version) || 1}-${scope}"`;
}

function buildCacheEntry(state) {
  const norm = normalizeStore(state);
  const pubState = redactAdminPass(norm);
  const pubPayload = Object.assign({}, pubState, { storage: STORAGE_KIND, auth: false });
  const admPayload = Object.assign({}, norm, { storage: STORAGE_KIND, auth: true });
  const pubJson = JSON.stringify(pubPayload);
  const admJson = JSON.stringify(admPayload);
  const pubEtag = makeEtag(norm.version, "pub");
  const admEtag = makeEtag(norm.version, "adm");
  return {
    state: norm,
    version: norm.version,
    etag: pubEtag,
    pubEtag,
    admEtag,
    json: pubJson,
    pubJson,
    admJson,
    fetchedAt: Date.now()
  };
}

function getMemCache() {
  const cur = global.__LB_STORE__;
  if (cur && typeof cur === "object" && cur.state && typeof cur.json === "string") {
    return cur;
  }
  return null;
}

function setMemCache(entry) {
  global.__LB_STORE__ = entry;
  return entry;
}

function readTmp() {
  try {
    if (fs.existsSync(TMP_FILE)) {
      return JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
    }
  } catch (e) { }
  return null;
}

function writeTmp(state) {
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(state), "utf8");
  } catch (e) { }
}

async function kvFetch(pathOrPipeline, options = {}) {
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const tm = ac ? setTimeout(() => { try { ac.abort(); } catch (e) { } }, REDIS_TIMEOUT_MS) : null;
  try {
    const r = await fetch(`${KV_URL}${pathOrPipeline}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        ...(options.headers || {})
      },
      cache: "no-store",
      signal: ac ? ac.signal : undefined
    });
    if (!r.ok) throw new Error(`KV HTTP ${r.status}`);
    return await r.json();
  } finally {
    if (tm) clearTimeout(tm);
  }
}

async function kvGetVersion() {
  if (!HAS_REDIS) return null;
  const d = await kvFetch(`/get/${encodeURIComponent(VER_KEY)}`);
  if (!d || d.result == null) return null;
  const parsed = Number(d.result);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function kvGetState() {
  if (!HAS_REDIS) return null;
  const d = await kvFetch(`/get/${encodeURIComponent(STATE_KEY)}`);
  if (!d || d.result == null) return null;
  return typeof d.result === "string" ? JSON.parse(d.result) : d.result;
}

async function kvSetState(state) {
  if (!HAS_REDIS) return;
  const verStr = String(Number(state.version) || 1);
  const res = await kvFetch("/pipeline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      ["SET", STATE_KEY, JSON.stringify(state)],
      ["SET", VER_KEY, verStr]
    ])
  });
  if (!Array.isArray(res) || res.some(item => item && item.error)) {
    throw new Error("KV pipeline set failed");
  }
}

async function getStatePacket(opts = {}) {
  const bypassTtl = !!opts.bypassTtl;
  const req = opts.req || null;
  const finalize = pkt => {
    const isAdmin = req ? verifyAdminRequest(req, pkt.state).valid : false;
    return {
      ...pkt,
      isAdmin,
      viewEtag: isAdmin ? (pkt.admEtag || pkt.etag) : (pkt.pubEtag || pkt.etag),
      viewJson: isAdmin ? (pkt.admJson || pkt.json) : (pkt.pubJson || pkt.json)
    };
  };
  const mem = getMemCache();
  const now = Date.now();

  if (mem) {
    if (!HAS_REDIS) {
      return finalize({ ...mem, storage: STORAGE_KIND, cache: "HIT" });
    }
    if (!bypassTtl && now - mem.fetchedAt < L1_TTL_MS) {
      return finalize({ ...mem, storage: STORAGE_KIND, cache: "HIT" });
    }
  }

  // Coalesce concurrent cold starts / TTL refreshes into a single Redis roundtrip
  if (global.__LB_INFLIGHT__) {
    return finalize(await global.__LB_INFLIGHT__);
  }

  const work = (async () => {
    if (HAS_REDIS) {
      try {
        if (mem) {
          const remoteVer = await kvGetVersion();
          if (remoteVer !== null && remoteVer === mem.version) {
            mem.fetchedAt = Date.now();
            return { ...mem, storage: STORAGE_KIND, cache: "REVALIDATED" };
          }
        }
        const raw = await kvGetState();
        if (raw) {
          const entry = buildCacheEntry(raw);
          setMemCache(entry);
          writeTmp(entry.state);
          // Backfill version key if state existed before VER_KEY was tracked
          kvFetch(`/set/${encodeURIComponent(VER_KEY)}/${encodeURIComponent(String(entry.version))}`).catch(() => { });
          return { ...entry, storage: STORAGE_KIND, cache: "MISS" };
        }
        const seed = readTmp();
        const defEntry = buildCacheEntry(seed || createDefaultGame());
        await kvSetState(defEntry.state);
        setMemCache(defEntry);
        writeTmp(defEntry.state);
        return { ...defEntry, storage: STORAGE_KIND, cache: "MISS" };
      } catch (e) {
        if (mem) {
          mem.fetchedAt = Date.now();
          return { ...mem, storage: STORAGE_KIND, cache: "STALE_FALLBACK" };
        }
      }
    }

    const disk = readTmp();
    const entry = buildCacheEntry(disk || createDefaultGame());
    setMemCache(entry);
    if (!disk) writeTmp(entry.state);
    return { ...entry, storage: STORAGE_KIND, cache: disk ? "TMP_HIT" : "TMP_INIT" };
  })();

  global.__LB_INFLIGHT__ = work;
  try {
    return finalize(await work);
  } finally {
    if (global.__LB_INFLIGHT__ === work) {
      delete global.__LB_INFLIGHT__;
    }
  }
}

async function loadState(opts = {}) {
  const pkt = await getStatePacket(opts);
  return clone(pkt.state);
}

async function saveState(state) {
  const entry = buildCacheEntry(state);
  setMemCache(entry);
  writeTmp(entry.state);
  if (HAS_REDIS) {
    try {
      await kvSetState(entry.state);
    } catch (e) { }
  }
  return entry;
}

async function checkAdminLogin(password, req = null) {
  const ip = getClientIp(req);
  const rlBucket = `login:${ip}`;
  const rl = checkRateLimit(rlBucket, LOGIN_RL_MAX_FAILS, LOGIN_RL_WINDOW_MS);
  if (!rl.allowed) {
    return {
      ok: false,
      code: 429,
      status: "too_many_requests",
      retryAfter: rl.retryAfter,
      error: "Terlalu banyak percobaan login. Coba lagi beberapa menit lagi."
    };
  }
  const pw = String(password || "").trim();
  const pkt = await getStatePacket({ bypassTtl: true });
  const state = pkt.state;
  const configured = getConfiguredAdminPass(state);
  const envPass = (process.env.ADMIN_PASSWORD || "").trim();
  const candidates = configured === "1234" ? ["1234", "admin123", "admin"] : [configured];
  if (envPass && !candidates.includes(envPass)) candidates.push(envPass);

  let matched = false;
  if (pw.length > 0 && pw.length <= 256) {
    for (const c of candidates) {
      if (timingSafeStrEqual(pw, c)) matched = true;
    }
  }
  if (matched) {
    clearFailures(rlBucket);
    return {
      ok: true,
      code: 200,
      status: "ok",
      storage: STORAGE_KIND,
      version: pkt.version,
      cookieHeader: createAdminCookieHeader(req, configured)
    };
  }
  recordFailure(rlBucket, LOGIN_RL_WINDOW_MS);
  return { ok: false, code: 403, status: "forbidden", error: "Kata sandi admin salah." };
}

async function applyAction(rawIncoming, req = null) {
  const incoming = sanitizeData(rawIncoming);
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return { ok: false, code: 400, status: "error", error: "Payload tidak valid." };
  }
  const current = await loadState({ bypassTtl: true });
  const prevPass = getConfiguredAdminPass(current);
  const action = typeof incoming.action === "string" ? incoming.action : "";
  const auth = verifyAdminRequest(req, current);

  if (action === "joinTeam") {
    const tid = typeof incoming.tid === "string" ? incoming.tid : "";
    const pin = String(incoming.pin || "").trim();
    const uid = String(incoming.uid || "").trim();
    const uname = String(incoming.uname || "").trim().slice(0, 60);
    const g = current.G;
    if (!g || typeof g !== "object" || !g.teams || !Object.prototype.hasOwnProperty.call(g.teams, tid)) {
      return { ok: false, code: 400, status: "error", error: "Tim tidak ditemukan." };
    }
    const pinBucket = `pin:${getClientIp(req)}:${tid}`;
    const pinRl = checkRateLimit(pinBucket, PIN_RL_MAX_FAILS, LOGIN_RL_WINDOW_MS);
    if (!pinRl.allowed) {
      return { ok: false, code: 429, status: "too_many_requests", retryAfter: pinRl.retryAfter, error: "Terlalu banyak percobaan PIN. Coba lagi nanti." };
    }
    const team = g.teams[tid];
    if (!timingSafeStrEqual(pin, String(team.pin || "").trim())) {
      recordFailure(pinBucket, LOGIN_RL_WINDOW_MS);
      return { ok: false, code: 403, status: "forbidden", error: "Kode PIN 4 angka salah." };
    }
    clearFailures(pinBucket);
    if (uid && uid.length <= 64) {
      for (const tObj of Object.values(g.teams)) {
        tObj.members = (tObj.members || []).filter(m => m !== uid);
      }
      team.members.push(uid);
      if (uname) {
        g.names = g.names || {};
        g.names[uid] = uname;
      }
    }
  } else {
    if (!auth.valid) {
      return {
        ok: false,
        code: 401,
        status: "unauthorized",
        storage: STORAGE_KIND,
        error: "Sesi admin tidak valid atau sudah berakhir. Silakan login ulang."
      };
    }
    if (action === "saveG") {
      const nextG = incoming.G;
      if (!nextG || typeof nextG !== "object" || !Array.isArray(nextG.order) || !nextG.teams || typeof nextG.teams !== "object") {
        return { ok: false, code: 400, status: "error", error: "Format state permainan tidak valid." };
      }
      if (!nextG.cfg || typeof nextG.cfg !== "object") {
        nextG.cfg = current.G && current.G.cfg ? clone(current.G.cfg) : clone(DEFAULT_CFG);
      }
      if (!nextG.cfg.adminPass || typeof nextG.cfg.adminPass !== "string" || !nextG.cfg.adminPass.trim()) {
        nextG.cfg.adminPass = prevPass;
      }
      current.G = nextG;
    } else if (action === "addLog") {
      const entry = incoming.entry;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, code: 400, status: "error", error: "Entri log tidak valid." };
      }
      const eid = entry.id;
      current.L = [entry, ...current.L.filter(x => x && x.id !== eid)].slice(0, 1000);
    } else if (action === "updLog") {
      const lid = incoming.id;
      const patch = incoming.patch;
      if (lid && patch && typeof patch === "object" && !Array.isArray(patch)) {
        const item = current.L.find(x => x && x.id === lid);
        if (item) {
          for (const [pk, pv] of Object.entries(patch)) {
            if (pk !== "id" && !POISON_KEYS.has(pk)) item[pk] = pv;
          }
        }
      }
    } else if (action === "saveCards") {
      if (incoming.CARDS !== null && !Array.isArray(incoming.CARDS)) {
        return { ok: false, code: 400, status: "error", error: "Format dek kartu tidak valid." };
      }
      current.CARDS = Array.isArray(incoming.CARDS) ? incoming.CARDS.slice(0, 500) : null;
    } else {
      if ("G" in incoming) {
        if (incoming.G !== null && (typeof incoming.G !== "object" || !Array.isArray(incoming.G.order) || !incoming.G.teams)) {
          return { ok: false, code: 400, status: "error", error: "Format state permainan tidak valid." };
        }
        if (incoming.G && (!incoming.G.cfg || !String(incoming.G.cfg.adminPass || "").trim())) {
          incoming.G.cfg = Object.assign({}, incoming.G.cfg || {}, { adminPass: prevPass });
        }
        current.G = incoming.G;
      }
      if ("L" in incoming && Array.isArray(incoming.L)) current.L = incoming.L.slice(0, 1000);
      if ("CARDS" in incoming) {
        current.CARDS = Array.isArray(incoming.CARDS) ? incoming.CARDS.slice(0, 500) : null;
      }
    }
  }

  current.version = (Number(current.version) || 1) + 1;
  const saved = await saveState(current);
  const nextPass = getConfiguredAdminPass(saved.state);
  const rotatedCookie = auth.valid && nextPass !== prevPass
    ? createAdminCookieHeader(req, nextPass)
    : null;

  const resObj = {
    ok: true,
    code: 200,
    status: "ok",
    version: saved.version,
    storage: STORAGE_KIND,
    auth: !!auth.valid,
    state: auth.valid ? saved.state : redactAdminPass(saved.state)
  };
  if (rotatedCookie) resObj.cookieHeader = rotatedCookie;
  return resObj;
}

function setCommonHeaders(res, extraHeaders = {}, req = null) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Vary", "Origin, Cookie, Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site");

  const origin = req && req.headers && req.headers.origin;
  const reqHost = getRequestHost(req);
  if (origin && reqHost) {
    try {
      if (new URL(origin).host.toLowerCase() === reqHost) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
    } catch (e) { }
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-None-Match");
  res.setHeader("Access-Control-Expose-Headers", "ETag, X-LB-Storage, X-LB-Cache");
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v !== undefined && v !== null) {
      res.setHeader(k, Array.isArray(v) ? v : String(v));
    }
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}, req = null) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  setCommonHeaders(res, extraHeaders, req);
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

function sendNotModified(res, extraHeaders = {}, req = null) {
  res.statusCode = 304;
  setCommonHeaders(res, extraHeaders, req);
  res.end();
}

async function parseJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string") {
    if (Buffer.byteLength(req.body, "utf8") > 4 * 1024 * 1024) {
      const err = new Error("Payload too large");
      err.statusCode = 413;
      throw err;
    }
    return JSON.parse(req.body || "{}");
  }
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on("data", chunk => {
      if (aborted) return;
      total += chunk.length;
      if (total > 4 * 1024 * 1024) {
        aborted = true;
        const err = new Error("Payload too large");
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        e.statusCode = 400;
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

module.exports = {
  HAS_REDIS,
  STORAGE_KIND,
  DEFAULT_ADMIN_PASS,
  loadState,
  getStatePacket,
  saveState,
  checkAdminLogin,
  applyAction,
  checkMutationOrigin,
  verifyAdminRequest,
  clearAdminCookieHeaders,
  sendJson,
  sendNotModified,
  parseJsonBody
};
