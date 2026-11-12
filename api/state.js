const { HAS_REDIS, loadState, applyAction, sendJson, parseJsonBody } = require("./_store");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET") {
    try {
      const state = await loadState();
      return sendJson(res, 200, Object.assign({}, state, { storage: HAS_REDIS ? "redis" : "tmp" }));
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "Gagal memuat state permainan." });
    }
  }
  if (req.method === "POST") {
    try {
      const body = await parseJsonBody(req);
      const resData = await applyAction(body);
      return sendJson(res, resData.code || 200, resData);
    } catch (e) {
      return sendJson(res, 400, { ok: false, status: "error", error: "JSON tidak valid." });
    }
  }
  return sendJson(res, 405, { ok: false, error: "Method not allowed" });
};
