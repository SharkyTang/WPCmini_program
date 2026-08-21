import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const logic = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/inquiryAdmin/inquiryAdminLogic.js"
));

assert.equal(
  logic.formatTime(new Date("2026-08-21T00:00:00.000Z")),
  "2026-08-21 08:00"
);

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("reply content accepts 1-300 plain-text characters", () => {
  assert.deepEqual(logic.normalizeReplyContent("  已添加您的微信\r\n请查收  "), {
    valid: true,
    value: "已添加您的微信\n请查收",
    reason: "",
  });
  assert.equal(logic.normalizeReplyContent("").valid, false);
  assert.equal(logic.normalizeReplyContent("字".repeat(300)).valid, true);
  assert.equal(logic.normalizeReplyContent("字".repeat(301)).valid, false);
  assert.equal(logic.normalizeReplyContent("正常\u0000文本").valid, false);
});

await test("client mutation ids are stable and restricted", () => {
  assert.equal(logic.normalizeClientMutationId("reply:uuid-1").valid, true);
  assert.equal(logic.normalizeClientMutationId("").valid, false);
  assert.equal(logic.normalizeClientMutationId("../unsafe").valid, false);
  assert.equal(logic.normalizeClientMutationId("x".repeat(129)).valid, false);
});

await test("reply ids are deterministic without exposing OpenID", () => {
  const first = logic.buildReplyMessageId("inquiry_1", "secret_openid", "mutation_1");
  const second = logic.buildReplyMessageId("inquiry_1", "secret_openid", "mutation_1");
  assert.equal(first, second);
  assert.equal(first.includes("secret_openid"), false);
  assert.notEqual(
    first,
    logic.buildReplyMessageId("inquiry_1", "secret_openid", "mutation_2")
  );
});

await test("reply target fields supplied by clients are rejected", () => {
  assert.equal(logic.hasForbiddenReplyTarget({ customerOpenid: "forged" }), true);
  assert.equal(logic.hasForbiddenReplyTarget({ targetOpenId: "forged" }), true);
  assert.equal(logic.hasForbiddenReplyTarget({ content: "ok" }), false);
});

await test("contact types only use stable enum values", () => {
  assert.equal(logic.normalizeContactType(" WeChat "), "wechat");
  assert.equal(logic.normalizeContactType("phone"), "phone");
  assert.equal(logic.normalizeContactType("email"), "email");
  assert.equal(logic.normalizeContactType("手机"), "");
});

await test("claim summaries prefer the canonical OpenID and accept legacy rows", () => {
  assert.equal(logic.getClaimedBy({
    claimedByOpenid: "canonical_admin",
    claimedBy: "legacy_admin",
  }), "canonical_admin");
  assert.equal(logic.getClaimedBy({ claimedBy: "legacy_admin" }), "legacy_admin");
  const enriched = logic.enrichInquiryItem({ claimedByOpenid: "canonical_admin" });
  assert.equal(enriched.claim.claimedByOpenid, "canonical_admin");
  assert.equal(enriched.claimedBy, "canonical_admin");
});

await test("template field JSON and compact mappings produce the same safe data", () => {
  const jsonResult = logic.parseReplyTemplateFields(JSON.stringify({
    title: "thing1",
    time: "time2",
    content: "thing3",
  }));
  const compactResult = logic.parseReplyTemplateFields(
    "title=thing1,time=time2,content=thing3"
  );
  for (const result of [jsonResult, compactResult]) {
    assert.equal(result.valid, true);
    assert.equal(result.data.thing1.value, "需求处理进度更新");
    assert.match(result.data.time2.value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(result.data.thing3.value.includes("管理员已回复"), true);
  }
  assert.equal(logic.parseReplyTemplateFields("").valid, false);
  assert.equal(logic.parseReplyTemplateFields("not-a-mapping").valid, false);
  assert.equal(logic.parseReplyTemplateFields('{"unknown":"thing1"}').valid, false);
});

await test("template mappings reject empty, duplicate, multiline, and invalid fields", () => {
  for (const raw of [
    "title=thing1,,content=thing3",
    "title=thing1,",
    "title=thing1,title=thing2",
    "title=thing1,content=thing1",
    "title=thing-1",
    "title=thing1,\ncontent=thing3",
    "\ntitle=thing1,content=thing3",
    "unknown=thing1",
    "title=thing1=content",
    '{"title":"thing1","title":"thing2"}',
    '{"title":"thing1","content":"thing1"}',
  ]) {
    assert.equal(logic.parseReplyTemplateFields(raw).valid, false, raw);
  }
});

await test("push failures retain only bounded safe error codes", () => {
  assert.equal(logic.normalizeSafeErrorCode({ code: "43101" }), "43101");
  assert.equal(logic.normalizeSafeErrorCode({ errCode: 43101 }), "43101");
  assert.equal(
    logic.normalizeSafeErrorCode({ errCode: " provider/path secret " }),
    "PROVIDER_PATH_SECRET"
  );
  assert.equal(
    logic.normalizeSafeErrorCode({ message: "smtp://user:password@example.com" }),
    "PUSH_FAILED"
  );
});
