const {
  checkAdminLogin,
  checkMutationOrigin,
  clearAdminCookieHeaders,
  sendJson,
  parseJsonBody
} = require("./_store");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true }, {}, req);
  }
  if (req.method === "DELETE") {
    const org = checkMutationOrigin(req);
    if (!org.ok) return sendJson(res, org.code, org, {}, req);
    return sendJson(res, 200, { ok: true, status: "logged_out" }, {
      "Set-Cookie": clearAdminCookieHeaders(req),
      "Clear-Site-Data": '"cookies"'
    }, req);
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Method not allowed" }, {}, req);
  }
  const org = checkMutationOrigin(req);
  if (!org.ok) {
    return sendJson(res, org.code, org, {}, req);
  }
  try {
    const body = await parseJsonBody(req);
    if (body && body.action === "logout") {
      return sendJson(res, 200, { ok: true, status: "logged_out" }, {
        "Set-Cookie": clearAdminCookieHeaders(req),
        "Clear-Site-Data": '"cookies"'
      }, req);
    }
    const resData = await checkAdminLogin(body && body.password, req);
    const hdrs = {};
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
};
