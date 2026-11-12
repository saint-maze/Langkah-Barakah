const { checkAdminLogin, sendJson, parseJsonBody } = require("./_store");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  }
  try {
    const body = await parseJsonBody(req);
    const resData = await checkAdminLogin(body && body.password);
    return sendJson(res, resData.code || 200, resData);
  } catch (e) {
    return sendJson(res, 400, { ok: false, status: "error", error: "JSON tidak valid." });
  }
};
