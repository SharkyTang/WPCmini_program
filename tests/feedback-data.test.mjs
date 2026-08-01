import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/feedback/utils/feedbackData.js"
);
const feedbackWxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/feedback/index.wxml"
);
const feedbackWxssPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/feedback/index.wxss"
);
const feedbackPageJsPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/feedback/index.js"
);
const feedbackJsonPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/feedback/index.json"
);
const feedbackServicePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/feedback/utils/feedbackService.js"
);
const source = readFileSync(modulePath, "utf8");
const sandbox = {
  module: { exports: {} },
  exports: {},
};
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(source, sandbox, { filename: modulePath });

const serviceSandbox = {
  module: { exports: {} },
  exports: {},
  require(request) {
    if (request === "./feedbackData") return sandbox.module.exports;
    if (request === "../../../utils/userDataService") return { callUserData() {} };
    throw new Error(`Unexpected require: ${request}`);
  },
};
serviceSandbox.exports = serviceSandbox.module.exports;
vm.runInNewContext(readFileSync(feedbackServicePath, "utf8"), serviceSandbox, {
  filename: feedbackServicePath,
});

const {
  CONTACT_TYPES,
  CONTENT_MAX_LENGTH,
  FEEDBACK_TYPES,
  buildFeedbackRecord,
  normalizeFeedbackDraft,
  validateFeedbackDraft,
} = sandbox.module.exports;
const { normalizeSystemInfo: normalizeFeedbackSystemInfo } = serviceSandbox.module.exports;

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

function loadFeedbackPage(options = {}) {
  let pageConfig;
  const calls = {
    validationDrafts: [],
    submissions: [],
    toastMessages: [],
    navigations: [],
  };
  const pageSource = readFileSync(feedbackPageJsPath, "utf8");
  const pageSandbox = {
    console,
    setTimeout() {
      return 1;
    },
    require(request) {
      if (request === "./utils/feedbackData") {
        return {
          CONTENT_MAX_LENGTH,
          FEEDBACK_TYPES,
          validateFeedbackDraft(draft) {
            calls.validationDrafts.push(plain(draft));
            return validateFeedbackDraft(draft);
          },
        };
      }
      if (request === "./utils/feedbackService") {
        return {
          async submitFeedback(data, context) {
            calls.submissions.push({
              data: plain(data),
              context: plain(context),
            });
            if (options.submitError) throw options.submitError;
          },
        };
      }
      throw new Error(`Unexpected require: ${request}`);
    },
    Page(config) {
      pageConfig = config;
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

  vm.runInNewContext(pageSource, pageSandbox, { filename: feedbackPageJsPath });

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
    if (typeof value === "function") {
      page[key] = value.bind(page);
    }
  });

  return { page, calls };
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
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
    contactType: " WECHAT ",
  });

  assert.deepEqual(plain(draft), {
    type: "suggestion",
    typeLabel: "体验建议",
    content: "页面可以更顺一点",
    contact: "wx-test",
    contactType: "wechat",
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
  assert.equal(wxml.includes("仅用于就本次反馈联系你"), true);
  assert.match(wxml, /bindtap="openPrivacyNotice"/);
  assert.equal((wxml.match(/反馈内容/g) || []).length, 1);
  assert.equal((wxml.match(/联系信息/g) || []).length, 1);
  assert.equal(wxml.includes('<view class="field-label">反馈类型</view>'), false);
  assert.equal(wxml.includes('<view class="field-label">反馈内容</view>'), false);
  assert.equal(
    wxml.includes('<view class="field-label">联系方式（选填）</view>'),
    false
  );
  assert.match(
    wxml,
    /form-section-title form-section-title-row[\s\S]*?field-count/
  );
});

test("feedback privacy hint opens the privacy notice", () => {
  const { page, calls } = loadFeedbackPage();
  page.openPrivacyNotice();
  assert.deepEqual(calls.navigations, ["/pages/privacy/index"]);
});

test("feedback contact field uses a native selector with a dynamic input", () => {
  const wxml = readFileSync(feedbackWxmlPath, "utf8");
  const wxss = readFileSync(feedbackWxssPath, "utf8");

  assert.match(wxml, /<picker[\s\S]*mode="selector"/);
  assert.match(wxml, /range="\{\{contactTypes\}\}"/);
  assert.match(wxml, /value="\{\{selectedContactTypeIndex\}\}"/);
  assert.match(wxml, /bindchange="changeContactType"/);
  assert.match(wxml, /value="\{\{contact\}\}"/);
  assert.match(wxml, /placeholder="\{\{contactPlaceholder\}\}"/);
  assert.equal(wxml.includes('placeholder="微信号 / 手机号 / 邮箱"'), false);

  const triggerStyle = wxss.match(/\.contact-type-trigger\s*\{([\s\S]*?)\}/)[1];
  const inputStyle = wxss.match(/\.contact-input\s*\{([\s\S]*?)\}/)[1];
  assert.match(triggerStyle, /height:\s*82rpx/);
  assert.match(triggerStyle, /align-items:\s*center/);
  assert.match(triggerStyle, /border-radius:\s*8rpx 0 0 8rpx/);
  assert.match(inputStyle, /height:\s*82rpx/);
  assert.match(inputStyle, /border-radius:\s*0 8rpx 8rpx 0/);
});

test("feedback contact selector defaults to WeChat and keeps the requested order", () => {
  const { page } = loadFeedbackPage();

  assert.deepEqual(plain(page.data.contactTypes), ["微信号", "手机号", "邮箱"]);
  assert.equal(page.data.selectedContactTypeIndex, 0);
  assert.equal(page.data.selectedContactType, "微信号");
  assert.equal(page.data.contactPlaceholder, "请输入微信号");
  assert.equal(page.data.contactType, "wechat");
});

test("changing feedback contact type only updates its label and placeholder", () => {
  const { page } = loadFeedbackPage();
  page.updateContact({ detail: { value: "wx-user-01" } });

  page.changeContactType({ detail: { value: "1" } });
  assert.equal(page.data.selectedContactType, "手机号");
  assert.equal(page.data.contactPlaceholder, "请输入手机号");
  assert.equal(page.data.contact, "wx-user-01");
  assert.equal(page.data.contactType, "phone");

  page.changeContactType({ detail: { value: "2" } });
  assert.equal(page.data.selectedContactType, "邮箱");
  assert.equal(page.data.contactPlaceholder, "请输入邮箱");
  assert.equal(page.data.contact, "wx-user-01");
  assert.equal(page.data.contactType, "email");
});

await asyncTest("feedback submission persists the selected stable contact type", async () => {
  const { page, calls } = loadFeedbackPage();
  page.setData({
    selectedType: "suggestion",
    content: "希望页面交互可以更流畅",
    contact: "user@example.com",
  });
  page.changeContactType({ detail: { value: "2" } });

  await page.submitForm();

  assert.deepEqual(Object.keys(calls.validationDrafts[0]).sort(), ["contact", "contactType", "content", "type"]);
  assert.equal(calls.validationDrafts[0].contact, "user@example.com");
  assert.equal(calls.submissions[0].data.contact, "user@example.com");
  assert.equal(calls.submissions[0].data.contactType, "email");
  assert.equal("selectedContactType" in calls.submissions[0].data, false);
});

await asyncTest("feedback validation and submit failures use one error surface", async () => {
  const invalid = loadFeedbackPage();
  invalid.page.setData({
    selectedType: "bug",
    content: "卡",
  });
  await invalid.page.submitForm();
  assert.equal(invalid.page.data.topTips.message, "请至少填写 5 个字");
  assert.deepEqual(invalid.calls.toastMessages, []);
  assert.equal(invalid.calls.submissions.length, 0);

  const failed = loadFeedbackPage({ submitError: new Error("network") });
  failed.page.setData({
    selectedType: "bug",
    content: "页面加载时偶尔卡顿",
  });
  await failed.page.submitForm();
  assert.equal(failed.page.data.topTips.message, "提交失败，请稍后重试");
  assert.deepEqual(failed.calls.toastMessages, []);
});

test("validates optional feedback contacts by the selected type", () => {
  const base = { type: "bug", content: "页面加载时偶尔卡顿" };
  assert.equal(validateFeedbackDraft(base).valid, true);
  assert.equal(validateFeedbackDraft({ ...base, contact: "legacy-contact" }).valid, true);
  assert.equal(
    validateFeedbackDraft({ ...base, contact: "13800138000", contactType: CONTACT_TYPES.PHONE }).valid,
    true
  );
  assert.equal(
    validateFeedbackDraft({ ...base, contact: "12345", contactType: CONTACT_TYPES.PHONE }).message,
    "请输入正确的手机号"
  );
  assert.equal(
    validateFeedbackDraft({ ...base, contact: "user@example.com", contactType: CONTACT_TYPES.EMAIL }).valid,
    true
  );
  assert.equal(
    validateFeedbackDraft({ ...base, contact: "user@invalid", contactType: CONTACT_TYPES.EMAIL }).message,
    "请输入正确的邮箱"
  );
  assert.equal(
    validateFeedbackDraft({ ...base, contact: "value", contactType: "sms" }).message,
    "联系方式类型无效"
  );
});

test("minimizes feedback system information before upload", () => {
  assert.deepEqual(
    plain(normalizeFeedbackSystemInfo({
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
      contactType: "email",
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
    contactType: "email",
    sourcePage: "pages/profile/index",
    route: "pages/feedback/index",
    openid: "openid_1",
    appVersion: "v2.6",
    systemInfo: { platform: "ios" },
    status: "new",
  });
});
