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
  "../miniprogram/miniprogram/pages/inquiry/utils/inquiryData.js"
);
const inquiryWxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/inquiry/index.wxml"
);
const inquiryPagePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/inquiry/index.js"
);
const inquiryServicePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/inquiry/utils/inquiryService.js"
);
const inquiryJsonPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/inquiry/index.json"
);
const inquiryData = loadCommonJsModule(inquiryDataPath, {
  "../../../utils/caseData": caseData,
});
const inquiryService = loadCommonJsModule(inquiryServicePath, {
  "./inquiryData": inquiryData,
  "../../../utils/userDataService": { callUserData() {} },
});

const {
  CONTACT_TYPES,
  buildInquiryDraftFromCase,
  buildInquiryRecord,
  normalizeInquiryDraft,
  validateInquiryDraft,
} = inquiryData;
const { normalizeSystemInfo: normalizeInquirySystemInfo } = inquiryService;

function loadInquiryPageConfig(options = {}) {
  let pageConfig;
  const calls = options.calls || {
    submissions: [],
    toastMessages: [],
    navigations: [],
  };
  const source = readFileSync(inquiryPagePath, "utf8");
  const sandbox = {
    console,
    setTimeout() {
      return 1;
    },
    Page(config) {
      pageConfig = config;
    },
    require(moduleName) {
      if (moduleName === "../../utils/cloudData") {
        return {
          fetchCaseById() {
            throw new Error("fetchCaseById should not run while loading the page");
          },
        };
      }
      if (moduleName === "./utils/inquiryData") return inquiryData;
      if (moduleName === "./utils/inquiryService") {
        return {
          async submitInquiry(data, context) {
            calls.submissions.push({ data: plain(data), context: plain(context) });
            if (options.submitError) throw options.submitError;
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {
      showToast(toastOptions = {}) {
        calls.toastMessages.push(toastOptions.title || "");
      },
      navigateTo(navigationOptions = {}) {
        calls.navigations.push(navigationOptions.url || "");
      },
      navigateBack() {},
      switchTab() {},
    },
  };

  vm.runInNewContext(source, sandbox, { filename: inquiryPagePath });
  return pageConfig;
}

function loadInquiryPage(options = {}) {
  const calls = {
    submissions: [],
    toastMessages: [],
    navigations: [],
  };
  const pageConfig = loadInquiryPageConfig({ ...options, calls });
  const page = {
    data: plain(pageConfig.data),
    setData(patch) {
      Object.entries(patch).forEach(([key, value]) => {
        if (!key.includes(".")) {
          this.data[key] = value;
          return;
        }
        const parts = key.split(".");
        let target = this.data;
        parts.slice(0, -1).forEach((part) => {
          target = target[part];
        });
        target[parts[parts.length - 1]] = value;
      });
    },
  };
  Object.entries(pageConfig).forEach(([key, value]) => {
    if (typeof value === "function") page[key] = value.bind(page);
  });
  return { page, calls };
}

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
    contactType: " WECHAT ",
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
    contactType: "wechat",
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
      contactType: "wechat",
    }).valid,
    true
  );
});

test("inquiry page uses WeUI top tips and sectioned form layout", () => {
  const wxml = readFileSync(inquiryWxmlPath, "utf8");
  const pageJson = JSON.parse(readFileSync(inquiryJsonPath, "utf8"));

  assert.equal(pageJson.usingComponents["mp-toptips"], "weui-miniprogram/toptips/toptips");
  assert.equal(wxml.includes("<mp-toptips"), true);
  assert.equal(wxml.includes("包装方向"), true);
  assert.equal(wxml.includes("需求说明"), true);
  assert.equal(wxml.includes("联系信息"), true);
  assert.equal(wxml.includes("仅用于就本次需求联系你"), true);
  assert.match(wxml, /bindtap="openPrivacyNotice"/);
});

test("inquiry privacy hint opens the privacy notice", () => {
  const { page, calls } = loadInquiryPage();
  page.openPrivacyNotice();
  assert.deepEqual(calls.navigations, ["/pages/privacy/index"]);
});

test("inquiry contact picker keeps the required order and defaults to WeChat", () => {
  const pageConfig = loadInquiryPageConfig();
  const wxml = readFileSync(inquiryWxmlPath, "utf8");

  assert.deepEqual(plain(pageConfig.data.contactTypes), ["微信号", "手机号", "邮箱"]);
  assert.equal(pageConfig.data.contactTypeIndex, 0);
  assert.equal(pageConfig.data.selectedContactType, "微信号");
  assert.equal(pageConfig.data.contactPlaceholder, "请输入微信号");
  assert.equal(pageConfig.data.draft.contactType, "wechat");
  assert.equal(wxml.includes('mode="selector"'), true);
  assert.equal(wxml.includes('range="{{contactTypes}}"'), true);
  assert.equal(wxml.includes('bindchange="changeContactType"'), true);
  assert.equal(wxml.includes("{{selectedContactType}}"), true);
  assert.equal(wxml.includes('placeholder="{{contactPlaceholder}}"'), true);
});

test("changing inquiry contact type updates its UI without clearing the value", () => {
  const pageConfig = loadInquiryPageConfig();
  const page = {
    data: {
      ...plain(pageConfig.data),
      draft: {
        ...plain(pageConfig.data.draft),
        contact: "existing-contact",
      },
    },
    setData(nextData) {
      Object.assign(this.data, nextData);
    },
  };
  page.updateDraft = pageConfig.updateDraft.bind(page);

  pageConfig.changeContactType.call(page, { detail: { value: "1" } });
  assert.equal(page.data.contactTypeIndex, 1);
  assert.equal(page.data.selectedContactType, "手机号");
  assert.equal(page.data.contactPlaceholder, "请输入手机号");
  assert.equal(page.data.draft.contact, "existing-contact");
  assert.equal(page.data.draft.contactType, "phone");

  pageConfig.changeContactType.call(page, { detail: { value: "2" } });
  assert.equal(page.data.contactTypeIndex, 2);
  assert.equal(page.data.selectedContactType, "邮箱");
  assert.equal(page.data.contactPlaceholder, "请输入邮箱");
  assert.equal(page.data.draft.contact, "existing-contact");
  assert.equal(page.data.draft.contactType, "email");
});

test("validates whitelisted inquiry contact types without breaking legacy drafts", () => {
  const base = {
    packageTypes: ["礼盒"],
    content: "想做一套礼盒包装",
  };
  assert.equal(validateInquiryDraft({ ...base, contact: "legacy-contact" }).valid, true);
  assert.equal(
    validateInquiryDraft({ ...base, contact: "wx-user", contactType: CONTACT_TYPES.WECHAT }).valid,
    true
  );
  assert.equal(
    validateInquiryDraft({ ...base, contact: "138 0013 8000", contactType: CONTACT_TYPES.PHONE }).valid,
    true
  );
  assert.equal(
    validateInquiryDraft({ ...base, contact: "12345", contactType: CONTACT_TYPES.PHONE }).message,
    "请输入正确的手机号"
  );
  assert.equal(
    validateInquiryDraft({ ...base, contact: "user@example.com", contactType: CONTACT_TYPES.EMAIL }).valid,
    true
  );
  assert.equal(
    validateInquiryDraft({ ...base, contact: "user@invalid", contactType: CONTACT_TYPES.EMAIL }).message,
    "请输入正确的邮箱"
  );
  assert.equal(
    validateInquiryDraft({ ...base, contact: "value", contactType: "sms" }).message,
    "联系方式类型无效"
  );
});

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await asyncTest("inquiry validation and submit failures use one error surface", async () => {
  const invalid = loadInquiryPage();
  invalid.page.updateDraft({
    ...invalid.page.data.draft,
    packageTypes: ["礼盒"],
    content: "太短",
    contact: "wx-user",
  });
  await invalid.page.submitForm();
  assert.equal(invalid.page.data.topTips.message, "请至少填写 5 个字");
  assert.deepEqual(invalid.calls.toastMessages, []);
  assert.equal(invalid.calls.submissions.length, 0);

  const failed = loadInquiryPage({ submitError: new Error("network") });
  failed.page.updateDraft({
    ...failed.page.data.draft,
    packageTypes: ["礼盒"],
    content: "想做一套礼盒包装",
    contact: "wx-user",
  });
  await failed.page.submitForm();
  assert.equal(failed.page.data.topTips.message, "提交失败，请稍后重试");
  assert.deepEqual(failed.calls.toastMessages, []);
});

test("minimizes inquiry system information before upload", () => {
  assert.deepEqual(
    plain(normalizeInquirySystemInfo({
      brand: "Apple",
      model: "iPhone",
      platform: "ios",
      system: "iOS 19",
      version: "8.0.60",
      SDKVersion: "3.10.0",
    })),
    {
      platform: "ios",
      system: "iOS 19",
      version: "8.0.60",
      SDKVersion: "3.10.0",
    }
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
    contactType: "",
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
      contactType: "wechat",
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
    contactType: "wechat",
    sourcePage: "pages/detail/index",
    route: "pages/inquiry/index",
    openid: "openid_1",
    appVersion: "v2.8",
    systemInfo: { platform: "ios" },
    status: "new",
  });
});
