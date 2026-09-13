/*
 * wloc-auth-worker.js — wloc 卡密系统后端（Cloudflare Workers + KV）
 *
 * 卡种：月卡(30天) / 季卡(90天) / 半年卡(180天) / 年卡(365天) / 永久卡 / 自定义天数
 * 规则：
 *   - 激活后计时：生成时不过期，对方首次使用时才开始倒计时（永久卡不计时）
 *   - 一码一机：激活时绑定设备指纹，换设备直接拒绝（可在后台解绑）
 *   - 到期自动失效；永久卡 expiresAt 为 null，永不失效（除非吊销）
 *
 * 部署：
 *   1. 新建 KV 命名空间绑定到本 Worker，变量名必须是：AUTH_KV
 *   2. 环境变量添加：ADMIN_TOKEN = 你的管理密码（建议 openssl rand -hex 16）
 *   3. 部署后地址填到 scripts/wloc.js 的 DEFAULT_CONFIG.authUrl
 *      （默认已指向 https://wloc-1993.575613136.workers.dev/check，
 *        把路由合进现有选点 Worker 则不用改）
 *
 * 接口：
 *   校验（客户端脚本调用，每 6 小时一次）：
 *     GET /check?key=<卡密>&did=<设备指纹>
 *       → {"allowed":true,"expiresAt":1735689600000,"remainingDays":29,"permanent":false}
 *       → {"allowed":false,"reason":"expired"|"revoked"|"not_found"|"device_mismatch"|"disabled"}
 *
 *   管理（都需要 token，浏览器直接访问）：
 *     GET /admin/create?token=xxx&plan=monthly&count=10&note=批次备注
 *         plan: monthly(30天) | season(90天) | halfyear(180天) | yearly(365天) | permanent(永久)
 *         或用 &days=45 自定义天数（plan 与 days 二选一，days 优先）
 *     GET /admin/revoke?token=xxx&code=WLOC-XXXX   → 吊销
 *     GET /admin/unbind?token=xxx&code=WLOC-XXXX   → 解绑设备并重置为未激活（对方换手机用）
 *     GET /admin/list?token=xxx                    → 全部卡密状态
 */

const GLOBAL_ENABLED = true; // 总开关：false = 所有卡密立即全部停用
const CODE_PREFIX = "code:";
// 去掉易混淆字符 0/O、1/I/L
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const PLANS = {
  monthly:   { days: 30,  label: "月卡" },
  season:    { days: 90,  label: "季卡" },
  halfyear:  { days: 180, label: "半年卡" },
  yearly:    { days: 365, label: "年卡" },
  permanent: { days: null, label: "永久卡" }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/check") return await handleCheck(url, env);
      if (url.pathname === "/admin/create") return await handleCreate(url, env);
      if (url.pathname === "/admin/revoke") return await handleRevoke(url, env);
      if (url.pathname === "/admin/unbind") return await handleUnbind(url, env);
      if (url.pathname === "/admin/list") return await handleList(url, env);
      if (url.pathname === "/") return new Response("wloc-auth ok");
      return new Response("not found", { status: 404 });
    } catch (err) {
      return json({ error: "internal: " + err.message }, 500);
    }
  }
};

/* ------------------------------ 工具 ------------------------------ */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function requireKv(env) {
  if (!env || !env.AUTH_KV) {
    return json({ error: "KV 未绑定：请给 Worker 绑定 KV 命名空间，变量名 AUTH_KV" }, 500);
  }
  return null;
}

function tokenOk(env, token) {
  const expect = String(env.ADMIN_TOKEN || "");
  const actual = String(token || "");
  if (!expect || actual.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i += 1) diff |= expect.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

function requireAdmin(url, env) {
  if (!tokenOk(env, url.searchParams.get("token"))) return json({ error: "unauthorized" }, 403);
  return null;
}

function randomSegment(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function generateCode() {
  return "WLOC-" + randomSegment(4) + "-" + randomSegment(4) + "-" + randomSegment(4);
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

async function readRecord(env, code) {
  const raw = await env.AUTH_KV.get(CODE_PREFIX + code);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function publicState(record, now) {
  const permanent = record.days === null;
  const remainingDays = permanent || !record.expiresAt
    ? null
    : Math.max(0, Math.ceil((record.expiresAt - now) / 86400000));
  return { permanent, remainingDays };
}

/* ------------------------------ 校验 ------------------------------ */

async function handleCheck(url, env) {
  const kvErr = requireKv(env);
  if (kvErr) return kvErr;
  if (!GLOBAL_ENABLED) return json({ allowed: false, reason: "disabled" });

  const code = normalizeCode(url.searchParams.get("key"));
  const deviceId = String(url.searchParams.get("did") || "").trim();
  if (!code) return json({ allowed: false, reason: "not_found" });

  const record = await readRecord(env, code);
  if (!record) return json({ allowed: false, reason: "not_found" });
  if (record.revoked === true) return json({ allowed: false, reason: "revoked" });

  const now = Date.now();

  // 首次使用 → 激活：绑定设备，开始计时
  if (!record.activatedAt) {
    if (!deviceId) return json({ allowed: false, reason: "no_device" });
    record.activatedAt = now;
    record.deviceId = deviceId;
    record.expiresAt = record.days === null ? null : now + record.days * 86400000;
    await env.AUTH_KV.put(CODE_PREFIX + code, JSON.stringify(record));
    return json(Object.assign({
      allowed: true,
      activated: true,
      expiresAt: record.expiresAt
    }, publicState(record, now)));
  }

  // 一码一机：设备不一致直接拒绝
  if (record.deviceId && deviceId && record.deviceId !== deviceId) {
    return json({ allowed: false, reason: "device_mismatch" });
  }
  // 没带设备指纹的旧客户端：允许但要求其尽快升级（不绑定，保持原行为）
  if (record.deviceId && !deviceId) {
    return json({ allowed: false, reason: "no_device" });
  }

  // 到期判定（永久卡 expiresAt 为 null，永不过期）
  if (record.expiresAt !== null && now >= record.expiresAt) {
    return json({ allowed: false, reason: "expired", expiresAt: record.expiresAt });
  }
  return json(Object.assign({
    allowed: true,
    expiresAt: record.expiresAt
  }, publicState(record, now)));
}

/* ------------------------------ 管理 ------------------------------ */

async function handleCreate(url, env) {
  const kvErr = requireKv(env);
  if (kvErr) return kvErr;
  const authErr = requireAdmin(url, env);
  if (authErr) return authErr;

  // 卡种：days 参数优先，其次 plan
  let days = null, planLabel = "自定义";
  const daysParam = url.searchParams.get("days");
  if (daysParam !== null && daysParam !== "") {
    days = Number(daysParam);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      return json({ error: "days 必须是 0~3650 之间的数字" }, 400);
    }
    days = Math.round(days);
    planLabel = "自定义" + days + "天";
  } else {
    const plan = String(url.searchParams.get("plan") || "monthly").toLowerCase();
    const p = PLANS[plan];
    if (!p) {
      return json({ error: "plan 必须是 monthly|season|halfyear|yearly|permanent，或用 days= 自定义" }, 400);
    }
    days = p.days;
    planLabel = p.label;
  }

  let count = Math.trunc(Number(url.searchParams.get("count") || "1"));
  if (!Number.isFinite(count) || count < 1) count = 1;
  if (count > 100) return json({ error: "单次最多生成 100 张" }, 400);

  const note = (url.searchParams.get("note") || "").slice(0, 100);
  const now = Date.now();
  const codes = [];

  for (let i = 0; i < count; i += 1) {
    let code = generateCode(), tries = 0;
    while (await env.AUTH_KV.get(CODE_PREFIX + code) && tries < 10) {
      code = generateCode();
      tries += 1;
    }
    const record = {
      plan: planLabel,
      days: days,              // null = 永久卡
      note: note,
      createdAt: now,
      activatedAt: null,       // 激活后计时：首次使用时才开始
      expiresAt: null,
      deviceId: null,          // 一码一机：激活时绑定
      revoked: false
    };
    await env.AUTH_KV.put(CODE_PREFIX + code, JSON.stringify(record));
    codes.push(code);
  }

  return json({ ok: true, plan: planLabel, days: days, count: codes.length, codes: codes });
}

async function handleRevoke(url, env) {
  const kvErr = requireKv(env);
  if (kvErr) return kvErr;
  const authErr = requireAdmin(url, env);
  if (authErr) return authErr;

  const code = normalizeCode(url.searchParams.get("code"));
  if (!code) return json({ error: "缺少 code 参数" }, 400);
  const record = await readRecord(env, code);
  if (!record) return json({ error: "卡密不存在: " + code }, 404);

  record.revoked = true;
  record.revokedAt = Date.now();
  await env.AUTH_KV.put(CODE_PREFIX + code, JSON.stringify(record));
  return json({ ok: true, code: code, revoked: true });
}

async function handleUnbind(url, env) {
  const kvErr = requireKv(env);
  if (kvErr) return kvErr;
  const authErr = requireAdmin(url, env);
  if (authErr) return authErr;

  const code = normalizeCode(url.searchParams.get("code"));
  if (!code) return json({ error: "缺少 code 参数" }, 400);
  const record = await readRecord(env, code);
  if (!record) return json({ error: "卡密不存在: " + code }, 404);

  // 重置为未激活：对方在新设备上首次使用时重新激活、重新计时
  record.deviceId = null;
  record.activatedAt = null;
  record.expiresAt = null;
  record.unboundAt = Date.now();
  await env.AUTH_KV.put(CODE_PREFIX + code, JSON.stringify(record));
  return json({ ok: true, code: code, status: "unused", hint: "已解绑并重置为未激活，新设备首次使用将重新计时" });
}

async function handleList(url, env) {
  const kvErr = requireKv(env);
  if (kvErr) return kvErr;
  const authErr = requireAdmin(url, env);
  if (authErr) return authErr;

  const now = Date.now();
  const codes = [];
  const summary = { unused: 0, active: 0, expired: 0, revoked: 0 };
  let cursor = undefined;
  do {
    const page = await env.AUTH_KV.list({ prefix: CODE_PREFIX, cursor });
    for (const item of page.keys) {
      const record = await readRecord(env, item.name.slice(CODE_PREFIX.length));
      if (!record) continue;
      let status;
      if (record.revoked) status = "revoked";
      else if (!record.activatedAt) status = "unused";
      else if (record.expiresAt !== null && now >= record.expiresAt) status = "expired";
      else status = "active";
      summary[status] += 1;
      codes.push({
        code: item.name.slice(CODE_PREFIX.length),
        plan: record.plan || "",
        note: record.note || "",
        status: status,
        createdAt: new Date(record.createdAt).toISOString(),
        activatedAt: record.activatedAt ? new Date(record.activatedAt).toISOString() : null,
        expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
        remainingDays: record.expiresAt
          ? Math.max(0, Math.ceil((record.expiresAt - now) / 86400000))
          : (record.days === null && record.activatedAt ? "永久" : null),
        deviceBound: !!record.deviceId
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return json({ ok: true, total: codes.length, summary: summary, codes: codes });
}
