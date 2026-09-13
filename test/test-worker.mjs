/*
 * test-worker.mjs — 本地模拟 KV，完整测试卡密后端
 * 运行：node test/test-worker.mjs
 *
 * 覆盖流程：批量生成 → 未激活查询 → 激活绑机 → 一码一机拒绝 → 解绑重置
 *          → 吊销 → 到期判定 → 永久卡 → 管理鉴权 → 列表统计
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---- 用 Map 模拟 Cloudflare KV ---- */
class MockKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async put(key, value) { this.map.set(key, value); }
  async list({ prefix } = {}) {
    const keys = [...this.map.keys()]
      .filter((k) => k.startsWith(prefix || ""))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

/* ---- 通过 data URL 动态 import ESM Worker 源码（避开 CJS 包类型限制） ---- */
const workerSrc = await fs.promises.readFile(
  path.join(__dirname, "..", "worker", "wloc-auth-worker.js"), "utf8");
const worker = (await import(
  "data:text/javascript;base64," + Buffer.from(workerSrc).toString("base64")
)).default;

const env = { AUTH_KV: new MockKV(), ADMIN_TOKEN: "test-admin-token" };

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed += 1; console.log("  PASS  " + name); }
  else { failed += 1; console.log("  FAIL  " + name); }
}
async function api(pathname) {
  const res = await worker.fetch(new Request("https://auth.test" + pathname), env);
  return { status: res.status, body: await res.json() };
}

const DAY = 86400000;

console.log("== 1. 批量生成卡密 ==");
const created = await api("/admin/create?token=test-admin-token&plan=monthly&count=3&note=测试批次");
assert(created.body.ok === true && created.body.codes.length === 3, "一次生成 3 张月卡");
assert(created.body.codes.every((c) => /^WLOC-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/.test(c)),
  "卡密格式 WLOC-XXXX-XXXX-XXXX 且无易混淆字符");
const [code1, code2] = created.body.codes;

console.log("== 2. 激活前状态 ==");
{
  const r = await api("/check?key=" + code1);
  assert(r.body.allowed === false && r.body.reason === "no_device", "未激活且无设备指纹 → no_device");
  const notFound = await api("/check?key=WLOC-AAAA-AAAA-AAAA&did=dev1");
  assert(notFound.body.allowed === false && notFound.body.reason === "not_found", "不存在的卡密 → not_found");
}

console.log("== 3. 激活并开始计时 ==");
let expiresAt1;
{
  const before = Date.now();
  const r = await api("/check?key=" + code1 + "&did=device-A");
  assert(r.body.allowed === true && r.body.activated === true, "首次使用激活成功");
  expiresAt1 = r.body.expiresAt;
  const expected = before + 30 * DAY;
  assert(Math.abs(expiresAt1 - expected) < 5000, "月卡到期时间 ≈ 30 天后");
  assert(r.body.remainingDays === 30 || r.body.remainingDays === 29, "剩余天数 29~30");
}

console.log("== 4. 一码一机 ==");
{
  const same = await api("/check?key=" + code1 + "&did=device-A");
  assert(same.body.allowed === true && same.body.activated !== true, "同设备再次校验 → 放行且不重复激活");
  const other = await api("/check?key=" + code1 + "&did=device-B");
  assert(other.body.allowed === false && other.body.reason === "device_mismatch", "换设备 → device_mismatch");
  const noDid = await api("/check?key=" + code1);
  assert(noDid.body.allowed === false && noDid.body.reason === "no_device", "已绑机但不带指纹 → no_device");
}

console.log("== 5. 解绑重置 ==");
{
  const unbind = await api("/admin/unbind?token=test-admin-token&code=" + code1);
  assert(unbind.body.ok === true && unbind.body.status === "unused", "解绑后回到未激活状态");
  const re = await api("/check?key=" + code1 + "&did=device-B");
  assert(re.body.allowed === true && re.body.activated === true, "新设备可重新激活并重新计时");
}

console.log("== 6. 吊销 ==");
{
  await api("/admin/revoke?token=test-admin-token&code=" + code2);
  const r = await api("/check?key=" + code2 + "&did=device-C");
  assert(r.body.allowed === false && r.body.reason === "revoked", "吊销后校验 → revoked");
}

console.log("== 7. 到期判定（注入一条已过期的记录） ==");
{
  await env.AUTH_KV.put("code:WLOC-EXPI-RED0-0000", JSON.stringify({
    plan: "月卡", days: 30, note: "", createdAt: Date.now() - 40 * DAY,
    activatedAt: Date.now() - 40 * DAY, expiresAt: Date.now() - 10 * DAY,
    deviceId: "device-X", revoked: false
  }));
  const r = await api("/check?key=WLOC-EXPI-RED0-0000&did=device-X");
  assert(r.body.allowed === false && r.body.reason === "expired", "到期卡 → expired");
}

console.log("== 8. 永久卡 ==");
{
  const c = await api("/admin/create?token=test-admin-token&plan=permanent&count=1");
  const code = c.body.codes[0];
  const r = await api("/check?key=" + code + "&did=device-P");
  assert(r.body.allowed === true && r.body.permanent === true && r.body.expiresAt === null,
    "永久卡激活后无到期时间");
  const again = await api("/check?key=" + code + "&did=device-P");
  assert(again.body.allowed === true && again.body.remainingDays === null, "永久卡再次校验仍放行");
}

console.log("== 9. 自定义天数 ==");
{
  const c = await api("/admin/create?token=test-admin-token&days=45&count=1");
  assert(c.body.days === 45 && c.body.plan === "自定义45天", "days=45 自定义卡生成");
}

console.log("== 10. 管理鉴权 ==");
{
  const bad = await api("/admin/create?token=wrong-token&plan=monthly&count=1");
  assert(bad.status === 403, "错误 token → 403");
  const noToken = await api("/admin/list");
  assert(noToken.status === 403, "无 token → 403");
}

console.log("== 11. 列表统计 ==");
{
  const r = await api("/admin/list?token=test-admin-token");
  assert(r.body.ok === true && r.body.total === 3 + 1 + 1 + 1, "总数正确 (3月卡+1注入+1永久+1自定义)");
  assert(r.body.summary.revoked === 1, "已吊销 1 张");
  assert(r.body.summary.expired === 1, "已过期 1 张");
  assert(r.body.summary.active === 2, "使用中 2 张（重激活月卡 + 永久卡）: 实际=" + r.body.summary.active);
  assert(r.body.summary.unused === 2, "未激活 2 张（剩余月卡 + 自定义卡）: 实际=" + r.body.summary.unused);
}

console.log("\n结果: " + passed + " 通过, " + failed + " 失败");
process.exit(failed ? 1 : 0);
