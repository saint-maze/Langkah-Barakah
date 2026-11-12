const fs = require("fs");

const TMP_FILE = "/tmp/langkah_barakah_state.json";
const STATE_KEY = process.env.LB_STATE_KEY || "langkah_barakah:state:v1";
const VER_KEY = `${STATE_KEY}:ver`;
const DEFAULT_ADMIN_PASS = (process.env.ADMIN_PASSWORD || "cihuymenang").trim() || "cihuymenang";

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const HAS_REDIS = !!(KV_URL && KV_TOKEN);
const STORAGE_KIND = HAS_REDIS ? "redis" : "tmp";

// Warm container L1 cache TTL before checking Redis version key (ms)
const L1_TTL_MS = Math.max(0, Number(process.env.LB_CACHE_TTL_MS || 800));
const REDIS_TIMEOUT_MS = Math.max(500, Number(process.env.LB_REDIS_TIMEOUT_MS || 2500));

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

function normalizeStore(raw) {
  if (!raw || typeof raw !== "object" || !("G" in raw)) return createDefaultGame();
  if (raw.G !== null && typeof raw.G !== "object") return createDefaultGame();
  const g = raw.G;
  if (g && (!Array.isArray(g.order) || !g.teams || !g.cfg)) return createDefaultGame();
  if (g && !g.cfg.adminPass) g.cfg.adminPass = DEFAULT_ADMIN_PASS;
  const logs = Array.isArray(raw.L) ? raw.L.slice(0, 1000) : [];
  const cards = Array.isArray(raw.CARDS) ? raw.CARDS : null;
  const version = Number(raw.version) || 1;
  return { version, G: g, L: logs, CARDS: cards };
}

function makeEtag(version) {
  return `"lb-v${Number(version) || 1}"`;
}

function buildCacheEntry(state) {
  const norm = normalizeStore(state);
  const payload = Object.assign({}, norm, { storage: STORAGE_KIND });
  return {
    state: norm,
    version: norm.version,
    etag: makeEtag(norm.version),
    json: JSON.stringify(payload),
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
  const mem = getMemCache();
  const now = Date.now();

  if (mem) {
    if (!HAS_REDIS) {
      return { ...mem, storage: STORAGE_KIND, cache: "HIT" };
    }
    if (!bypassTtl && now - mem.fetchedAt < L1_TTL_MS) {
      return { ...mem, storage: STORAGE_KIND, cache: "HIT" };
    }
  }

  // Coalesce concurrent cold starts / TTL refreshes into a single Redis roundtrip
  if (global.__LB_INFLIGHT__) {
    return await global.__LB_INFLIGHT__;
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
    return await work;
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

async function checkAdminLogin(password) {
  const pw = String(password || "").trim();
  const pkt = await getStatePacket({ bypassTtl: true });
  const state = pkt.state;
  const configured = String((state.G && state.G.cfg && state.G.cfg.adminPass) || DEFAULT_ADMIN_PASS).trim();
  const envPass = (process.env.ADMIN_PASSWORD || "").trim();
  const valid = new Set(configured === "1234" ? ["1234", "admin123", "admin"] : [configured]);
  if (envPass) valid.add(envPass);
  if (valid.has(pw)) {
    return { ok: true, code: 200, status: "ok", storage: STORAGE_KIND };
  }
  return { ok: false, code: 403, status: "forbidden", error: "Kata sandi admin salah." };
}

async function applyAction(incoming) {
  const current = await loadState({ bypassTtl: true });
  const action = incoming && incoming.action;

  if (action === "saveG") {
    current.G = incoming.G;
  } else if (action === "addLog") {
    const entry = incoming.entry;
    if (entry && typeof entry === "object") {
      const eid = entry.id;
      current.L = [entry, ...current.L.filter(x => x && x.id !== eid)].slice(0, 1000);
    }
  } else if (action === "updLog") {
    const lid = incoming.id;
    const patch = incoming.patch;
    if (lid && patch && typeof patch === "object") {
      const item = current.L.find(x => x && x.id === lid);
      if (item) Object.assign(item, patch);
    }
  } else if (action === "saveCards") {
    current.CARDS = incoming.CARDS;
  } else if (action === "joinTeam") {
    const tid = incoming.tid;
    const pin = String(incoming.pin || "").trim();
    const uid = String(incoming.uid || "").trim();
    const uname = String(incoming.uname || "").trim();
    const g = current.G;
    if (!g || typeof g !== "object" || !g.teams || !g.teams[tid]) {
      return { ok: false, code: 400, status: "error", error: "Tim tidak ditemukan.", state: current };
    }
    const team = g.teams[tid];
    if (String(team.pin || "").trim() !== pin) {
      return { ok: false, code: 403, status: "forbidden", error: "Kode PIN 4 angka salah.", state: current };
    }
    for (const tObj of Object.values(g.teams)) {
      tObj.members = (tObj.members || []).filter(m => m !== uid);
    }
    if (uid) team.members.push(uid);
    if (uname && uid) {
      g.names = g.names || {};
      g.names[uid] = uname;
    }
  } else if (incoming && typeof incoming === "object") {
    if ("G" in incoming) current.G = incoming.G;
    if ("L" in incoming && Array.isArray(incoming.L)) current.L = incoming.L.slice(0, 1000);
    if ("CARDS" in incoming) current.CARDS = incoming.CARDS;
  }

  current.version = (Number(current.version) || 1) + 1;
  const saved = await saveState(current);
  return {
    ok: true,
    code: 200,
    status: "ok",
    version: saved.version,
    storage: STORAGE_KIND,
    state: saved.state
  };
}

function setCommonHeaders(res, extraHeaders = {}) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-None-Match");
  res.setHeader("Access-Control-Expose-Headers", "ETag, X-LB-Storage, X-LB-Cache");
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v !== undefined && v !== null) res.setHeader(k, String(v));
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  setCommonHeaders(res, extraHeaders);
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

function sendNotModified(res, extraHeaders = {}) {
  res.statusCode = 304;
  setCommonHeaders(res, extraHeaders);
  res.end();
}

async function parseJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string") {
    return JSON.parse(req.body || "{}");
  }
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > 4 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
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
  sendJson,
  sendNotModified,
  parseJsonBody
};
