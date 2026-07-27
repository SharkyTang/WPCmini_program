import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/feedbackData.js"
);
const feedbackWxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/feedback/index.wxml"
);
const feedbackJsonPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/feedback/index.json"
);
const source = readFileSync(modulePath, "utf8");
const sandbox = {
  module: { exports: {} },
  exports: {},
};
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(source, sandbox, { filename: modulePath });

const {
  FEEDBACK_TYPES,
  buildFeedbackRecord,
  normalizeFeedbackDraft,
  validateFeedbackDraft,
} = sandbox.module.exports;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("feedback types expose stable labels", () => {
  assert.deepEqual(plain(FEEDBACK_TYPES.map((item) => item.key)), [
    "bug",
    "suggestion",
    "feature",
    "case_data",
  ]);
  assert.equal(FEEDBACK_TYPES[0].label, "遇到问题");
});

test("normalizes feedback draft text fields", () => {
  const draft = normalizeFeedbackDraft({
    type: "suggestion",
    content: "  页面可以更顺一点  ",
    contact: "  wx-test  ",
  });

  assert.deepEqual(plain(draft), {
    type: "suggestion",
    typeLabel: "体验建议",
    content: "页面可以更顺一点",
    contact: "wx-test",
  });
});

test("validates required type and content length", () => {
  assert.equal(validateFeedbackDraft({ type: "", content: "页面卡顿了" }).valid, false);
  assert.equal(validateFeedbackDraft({ type: "bug", content: "卡" }).message, "请至少填写 5 个字");
  assert.equal(validateFeedbackDraft({ type: "bug", content: "页面加载时偶尔卡顿" }).valid, true);
});

test("feedback page uses WeUI top tips and sectioned form layout", () => {
  const wxml = readFileSync(feedbackWxmlPath, "utf8");
  const pageJson = JSON.parse(readFileSync(feedbackJsonPath, "utf8"));

  assert.equal(pageJson.usingComponents["mp-toptips"], "weui-miniprogram/toptips/toptips");
  assert.equal(wxml.includes("<mp-toptips"), true);
  assert.equal(wxml.includes("反馈分类"), true);
  assert.equal(wxml.includes("反馈内容"), true);
  assert.equal(wxml.includes("联系信息"), true);
});

test("validates maximum content and contact length", () => {
  assert.equal(validateFeedbackDraft({ type: "bug", content: "a".repeat(801) }).message, "内容最多 800 个字");
  assert.equal(
    validateFeedbackDraft({
      type: "bug",
      content: "页面加载时偶尔卡顿",
      contact: "1".repeat(121),
    }).message,
    "联系方式最多 120 个字"
  );
});

test("builds feedback record with defaults and context", () => {
  const record = buildFeedbackRecord(
    {
      type: "case_data",
      content: "case_001 的分类好像不太准确",
      contact: "user@example.com",
    },
    {
      sourcePage: "pages/profile/index",
      route: "pages/feedback/index",
      openid: "openid_1",
      appVersion: "v2.6",
      systemInfo: { platform: "ios" },
    }
  );

  assert.deepEqual(plain(record), {
    type: "case_data",
    typeLabel: "图片或分类不对",
    content: "case_001 的分类好像不太准确",
    contact: "user@example.com",
    sourcePage: "pages/profile/index",
    route: "pages/feedback/index",
    openid: "openid_1",
    appVersion: "v2.6",
    systemInfo: { platform: "ios" },
    status: "new",
  });
});
