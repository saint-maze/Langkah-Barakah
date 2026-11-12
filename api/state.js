const { STORAGE_KIND, getStatePacket, applyAction, sendJson, sendNotModified, parseJsonBody } = require("./_store");

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
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET") {
    try {
      const pkt = await getStatePacket();
      const hdrs = {
        ETag: pkt.etag,
        "X-LB-Storage": pkt.storage,
        "X-LB-Cache": pkt.cache
      };
      const inm = String((req.headers && req.headers["if-none-match"]) || "").trim();
      const qv = getQueryVer(req);
      if ((inm && (inm === pkt.etag || inm === `W/${pkt.etag}`)) || (qv && qv === String(pkt.version))) {
        return sendNotModified(res, hdrs);
      }
      return sendJson(res, 200, pkt.json, hdrs);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "Gagal memuat state permainan." });
    }
  }
  if (req.method === "POST") {
    try {
      const body = await parseJsonBody(req);
      const resData = await applyAction(body);
      return sendJson(res, resData.code || 200, resData, { "X-LB-Storage": resData.storage || STORAGE_KIND });
    } catch (e) {
      return sendJson(res, 400, { ok: false, status: "error", error: "JSON tidak valid." });
    }
  }
  return sendJson(res, 405, { ok: false, error: "Method not allowed" });
};
