const {
  STORAGE_KIND,
  getStatePacket,
  applyAction,
  checkMutationOrigin,
  clearAdminCookieHeaders,
  sendJson,
  sendNotModified,
  parseJsonBody
} = require("./_store");

function getQueryVer(req) {
  if (req && req.query && req.query.v != null) return String(req.query.v).trim();
  const url = (req && req.url) || "";
  const idx = url.indexOf("?");
  if (idx === -1) return "";
  try {
    return (new URLSearchParams(url.slice(idx + 1)).get("v") || "").trim();
  } catch (e) {
    return "";
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true }, {}, req);
  }
  if (req.method === "GET") {
    try {
      const pkt = await getStatePacket({ req });
      const etag = pkt.viewEtag || pkt.etag;
      const hdrs = {
        ETag: etag,
        "X-LB-Storage": pkt.storage,
        "X-LB-Cache": pkt.cache
      };
      const inm = String((req.headers && req.headers["if-none-match"]) || "").trim();
      const qv = getQueryVer(req);
      const scopeTag = `${pkt.version}-${pkt.isAdmin ? "adm" : "pub"}`;
      const verMatch = qv && (qv === scopeTag || (!pkt.isAdmin && qv === String(pkt.version)));
      if ((inm && (inm === etag || inm === `W/${etag}`)) || verMatch) {
        return sendNotModified(res, hdrs, req);
      }
      return sendJson(res, 200, pkt.viewJson || pkt.json, hdrs, req);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "Gagal memuat state permainan." }, {}, req);
    }
  }
  if (req.method === "POST") {
    const org = checkMutationOrigin(req);
    if (!org.ok) {
      return sendJson(res, org.code, org, { "X-LB-Storage": STORAGE_KIND }, req);
    }
    try {
      const body = await parseJsonBody(req);
      if (body && body.action === "logout") {
        return sendJson(res, 200, { ok: true, status: "logged_out" }, {
          "Set-Cookie": clearAdminCookieHeaders(req),
          "Clear-Site-Data": '"cookies"',
          "X-LB-Storage": STORAGE_KIND
        }, req);
      }
      const resData = await applyAction(body, req);
      const hdrs = { "X-LB-Storage": resData.storage || STORAGE_KIND };
      if (resData.cookieHeader) {
        hdrs["Set-Cookie"] = resData.cookieHeader;
        delete resData.cookieHeader;
      }
      if (resData.retryAfter) {
        hdrs["Retry-After"] = String(resData.retryAfter);
      }
      return sendJson(res, resData.code || 200, resData, hdrs, req);
    } catch (e) {
      const status = e && e.statusCode === 413 ? 413 : 400;
      const msg = status === 413 ? "Ukuran payload terlalu besar." : "JSON tidak valid.";
      return sendJson(res, status, { ok: false, status: "error", error: msg }, {}, req);
    }
  }
  return sendJson(res, 405, { ok: false, error: "Method not allowed" }, {}, req);
};
