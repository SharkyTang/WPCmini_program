import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadCommonJsModule(modulePath, extraRequire = {}) {
  const source = readFileSync(modulePath, "utf8");
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(moduleName) {
      if (extraRequire[moduleName]) return extraRequire[moduleName];
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(source, sandbox, { filename: modulePath });
  return sandbox.module.exports;
}

const caseDataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/caseData.js"
);
const caseData = loadCommonJsModule(caseDataPath);
const inquiryDataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/inquiryData.js"
);
const inquiryData = loadCommonJsModule(inquiryDataPath, {
  "./caseData": caseData,
});

const {
  buildInquiryDraftFromCase,
  buildInquiryRecord,
  normalizeInquiryDraft,
  validateInquiryDraft,
} = inquiryData;

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

test("normalizes inquiry draft text and array fields", () => {
  const draft = normalizeInquiryDraft({
    source: " detail ",
    caseDocId: " doc_1 ",
    caseId: " case_001 ",
    caseTitle: " 整套包装方案 ",
    wineType: " 白酒 ",
    packageTypes: { values: ["整套包装", "", "瓶标"] },
    styles: [" 国风 ", "轻奢"],
    priceLevel: [" 品质款 "],
    scenes: "送礼",
    content: "  想做一套礼盒包装  ",
    contact: "  wx-test  ",
  });

  assert.deepEqual(plain(draft), {
    source: "detail",
    caseDocId: "doc_1",
    caseId: "case_001",
    caseTitle: "整套包装方案",
    wineType: "白酒",
    packageTypes: ["整套包装", "瓶标"],
    styles: ["国风", "轻奢"],
    priceLevel: "品质款",
    scenes: ["送礼"],
    content: "想做一套礼盒包装",
    contact: "wx-test",
  });
});

test("validates required package types, content, and contact", () => {
  assert.equal(validateInquiryDraft({ content: "想做礼盒包装", contact: "wx" }).message, "请选择包装内容");
  assert.equal(
    validateInquiryDraft({ packageTypes: ["礼盒"], content: "太短", contact: "wx" }).message,
    "请至少填写 5 个字"
  );
  assert.equal(
    validateInquiryDraft({ packageTypes: ["礼盒"], content: "想做一套礼盒包装" }).message,
    "请填写联系方式"
  );
  assert.equal(
    validateInquiryDraft({
      packageTypes: ["礼盒"],
      content: "想做一套礼盒包装",
      contact: "wx-test",
    }).valid,
    true
  );
});

test("validates maximum inquiry content and contact length", () => {
  assert.equal(
    validateInquiryDraft({
      packageTypes: ["礼盒"],
      content: "a".repeat(801),
      contact: "wx-test",
    }).message,
    "补充说明最多 800 个字"
  );
  assert.equal(
    validateInquiryDraft({
      packageTypes: ["礼盒"],
      content: "想做一套礼盒包装",
      contact: "1".repeat(121),
    }).message,
    "联系方式最多 120 个字"
  );
});

test("builds default inquiry draft from case item", () => {
  const draft = buildInquiryDraftFromCase({
    id: "doc_1",
    caseId: "case_001",
    title: "整套包装方案",
    wineType: "白酒",
    packageTypes: ["整套包装", "瓶标"],
    styles: ["国风"],
    priceLevel: "品质款",
    scenes: ["送礼"],
  });

  assert.deepEqual(plain(draft), {
    source: "detail",
    caseDocId: "doc_1",
    caseId: "case_001",
    caseTitle: "整套包装方案",
    wineType: "白酒",
    packageTypes: ["整套包装", "瓶标"],
    styles: ["国风"],
    priceLevel: "品质款",
    scenes: ["送礼"],
    content: "",
    contact: "",
  });
});

test("builds inquiry record with defaults and context", () => {
  const record = buildInquiryRecord(
    {
      source: "detail",
      caseDocId: "doc_1",
      caseId: "case_001",
      caseTitle: "整套包装方案",
      wineType: "白酒",
      packageTypes: ["整套包装"],
      styles: ["国风"],
      priceLevel: "品质款",
      scenes: ["送礼"],
      content: "想做一套类似包装",
      contact: "wx-test",
    },
    {
      sourcePage: "pages/detail/index",
      route: "pages/inquiry/index",
      openid: "openid_1",
      systemInfo: { platform: "ios" },
    }
  );

  assert.deepEqual(plain(record), {
    source: "detail",
    caseDocId: "doc_1",
    caseId: "case_001",
    caseTitle: "整套包装方案",
    wineType: "白酒",
    packageTypes: ["整套包装"],
    styles: ["国风"],
    priceLevel: "品质款",
    scenes: ["送礼"],
    content: "想做一套类似包装",
    contact: "wx-test",
    sourcePage: "pages/detail/index",
    route: "pages/inquiry/index",
    openid: "openid_1",
    appVersion: "v2.8",
    systemInfo: { platform: "ios" },
    status: "new",
  });
});
