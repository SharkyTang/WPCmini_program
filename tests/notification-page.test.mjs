import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(__dirname, "../miniprogram/miniprogram/pages/notifications/index.js");
const wxmlPath = resolve(__dirname, "../miniprogram/miniprogram/pages/notifications/index.wxml");
const caseEditWxmlPath = resolve(__dirname, "../miniprogram/miniprogram/pages/case-admin/edit.wxml");
const caseEditPagePath = resolve(__dirname, "../miniprogram/miniprogram/pages/case-admin/edit.js");

function loadNotificationData() {
  const module = { exports: {} };
  vm.runInNewContext(
    readFileSync(resolve(__dirname, "../miniprogram/miniprogram/pages/notifications/utils/notificationData.js"), "utf8"),
    { module, exports: module.exports, Date },
    { filename: "notificationData.js" }
  );
  return module.exports;
}

function loadNotificationPage(options = {}) {
  let page;
  const calls = {
    subscribeRequests: [],
    grants: [],
    grantAttempts: 0,
    navigations: [],
    settings: 0,
    settingChecks: 0,
    toasts: [],
    modals: [],
    nativeLoadingEvents: [],
    templateVerifications: 0,
  };
  const notificationData = loadNotificationData();
  const subscriptionResult = options.subscriptionResult || {
    subscriptions: notificationData.normalizeSubscriptionState({}),
    templateIds: {
      version_update: "version_template_id_1234567890",
      product_new: "product_template_id_1234567890",
    },
    templateConfigs: {
      version_update: {
        valid: true,
        envKey: "VERSION_UPDATE_TEMPLATE_ID",
        templateId: "version_template_id_1234567890",
      },
      product_new: {
        valid: true,
        envKey: "PRODUCT_NEW_TEMPLATE_ID",
        templateId: "product_template_id_1234567890",
      },
    },
  };
  const sandbox = {
    Page(config) {
      page = config;
    },
    require(moduleName) {
      if (moduleName === "./utils/notificationData") return notificationData;
      if (moduleName === "./utils/notificationService") {
        return {
          fetchPublicNotifications: options.fetchPublicNotifications || (async () => {
            if (options.loadError) throw options.loadError;
            return options.notifications || [];
          }),
          fetchSubscriptionStatus: options.fetchSubscriptionStatus || (async () => subscriptionResult),
          verifySubscriptionTemplates: async () => {
            calls.templateVerifications += 1;
            if (options.templateVerificationError) {
              throw options.templateVerificationError;
            }
            return options.templateVerification || {
              appid: "wx351f937287eb5886",
              verificationAvailable: true,
              templates: {
                version_update: {
                  existsInCurrentApp: true,
                  title: "升级成功通知",
                },
                product_new: {
                  existsInCurrentApp: true,
                  title: "商品上新通知",
                },
              },
            };
          },
          saveSubscriptionGrant: async (type, templateId, status) => {
            calls.grantAttempts += 1;
            if (calls.grantAttempts <= Number(options.grantFailures || 0)) {
              const error = new Error(options.grantErrorMessage || "save failed");
              error.code = options.grantErrorCode || "SERVER_ERROR";
              throw error;
            }
            calls.grants.push({ type, templateId, status });
            return {
              subscriptions: notificationData.normalizeSubscriptionState({
                [type]: { templateId, status: status === "accept" ? "granted" : status === "ban" ? "banned" : "rejected" },
              }),
              templateIds: subscriptionResult.templateIds,
              templateConfigs: subscriptionResult.templateConfigs,
            };
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    wx: {
      hideLoading() {
        calls.nativeLoadingEvents.push({ type: "hide" });
      },
      getSetting(request) {
        calls.settingChecks += 1;
        request.success(options.settingsResponse || {
          subscriptionsSetting: {
            mainSwitch: true,
            itemSettings: {},
          },
        });
      },
      requestSubscribeMessage(request) {
        calls.subscribeRequests.push(request);
        if (options.subscribeError) {
          request.fail(options.subscribeError);
          return;
        }
        request.success({
          [request.tmplIds[0]]: options.subscribeStatus || "accept",
        });
      },
      navigateTo(request) {
        calls.navigations.push(request.url);
      },
      openSetting() {
        calls.settings += 1;
      },
      showToast(request) {
        calls.toasts.push(request);
      },
      showModal(request) {
        calls.modals.push(request);
        if (request.complete) request.complete({ confirm: true });
      },
      showLoading(request) {
        calls.nativeLoadingEvents.push({ type: "show", request });
      },
    },
  };
  vm.runInNewContext(readFileSync(pagePath, "utf8"), sandbox, { filename: pagePath });
  page.setData = function setData(nextData) {
    this.data = { ...this.data, ...nextData };
  };
  return { page, calls };
}

function loadCaseEditPage(options = {}) {
  let page;
  const calls = {
    creates: [],
    publishes: [],
    modals: [],
    navigations: 0,
  };
  const emptyForm = {
    title: "国风礼盒",
    caseId: "",
    coverImage: "cloud://env/case.jpg",
    coverThumbnail: "",
    galleryImages: ["cloud://env/case.jpg"],
    wineType: "白酒",
    packageTypes: ["礼盒"],
    styles: ["国风"],
    priceLevel: "",
    scenes: options.scenes || ["送礼"],
    statuses: [],
    homeSections: [],
    sortOrder: "",
    notes: "",
    isVisible: true,
    isPinned: false,
  };
  const sandbox = {
    Page(config) {
      page = config;
    },
    require(moduleName) {
      if (moduleName === "./utils/caseAdminData") {
        return {
          CASE_ADMIN_FORM_OPTIONS: {},
          buildCaseAdminImagePath: () => "path",
          buildCaseAdminOptionViews: () => ({}),
          buildCaseAdminPayload: (form) => form,
          createEmptyCaseForm: () => ({ ...emptyForm }),
          CASE_ADMIN_GALLERY_MAX: 9,
          getSceneLabel: (value) => (value === "婚宴" ? "婚宴/喜宴" : value),
          validateCaseAdminForm: () => ({ valid: true }),
        };
      }
      if (moduleName === "./utils/caseAdminService") {
        return {
          createCaseAdmin: async (payload) => {
            calls.creates.push(payload);
            return { id: "case_doc_1" };
          },
          fetchCaseAdminDetail: async () => null,
          generateCaseImageVariants: async () => [],
          updateCaseAdmin: async () => ({}),
          uploadCaseCoverImage: async () => "cloud://env/image.jpg",
        };
      }
      if (moduleName === "./utils/notificationAdminService") {
        return {
          publishProductAnnouncement: async (payload) => {
            calls.publishes.push(payload);
            if (options.publishError) throw new Error("publish failed");
            return { id: "notice_1" };
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    setTimeout(callback) {
      callback();
    },
    wx: {
      showToast() {},
      showModal(request) {
        calls.modals.push(request);
        if (request.success) request.success({ confirm: true });
      },
      navigateBack() {
        calls.navigations += 1;
      },
    },
  };
  vm.runInNewContext(readFileSync(caseEditPagePath, "utf8"), sandbox, {
    filename: caseEditPagePath,
  });
  page.setData = function setData(nextData) {
    this.data = { ...this.data, ...nextData };
  };
  return { page, calls };
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("notification page removes custom customer replies and exposes one-time subscriptions", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const pageSource = readFileSync(pagePath, "utf8");
  assert.equal(wxml.includes("客服回复"), false);
  assert.equal(pageSource.includes("订阅下一次"), true);
  assert.equal(wxml.includes('bindtap="subscribeNext"'), true);
  assert.equal(wxml.includes("item.hasCaseLink"), true);
});

await test("notification loading uses the native WeChat loading overlay without a page card", async () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const { page, calls } = loadNotificationPage();

  assert.equal(wxml.includes("正在读取消息通知"), false);
  assert.equal(wxml.includes("正在同步最新内容"), false);
  assert.equal(page.data.loading, true);

  await page.loadNotifications();

  assert.deepEqual(JSON.parse(JSON.stringify(calls.nativeLoadingEvents)), [
    { type: "show", request: { title: "加载中", mask: true } },
    { type: "hide" },
  ]);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.errorMessage, "");
});

await test("notification failure and retry each show and hide one native overlay", async () => {
  let attempts = 0;
  const { page, calls } = loadNotificationPage({
    fetchPublicNotifications: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network unavailable");
      return [{ id: "latest_notification", type: "version_update" }];
    },
  });

  await page.loadNotifications();
  assert.deepEqual(calls.nativeLoadingEvents.map((event) => event.type), ["show", "hide"]);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.errorMessage, "暂时读取不到消息通知，请稍后重试。");

  await page.loadNotifications();
  assert.deepEqual(
    calls.nativeLoadingEvents.map((event) => event.type),
    ["show", "hide", "show", "hide"]
  );
  assert.equal(page.data.loading, false);
  assert.equal(page.data.errorMessage, "");
  assert.equal(page.data.publicNotifications[0].id, "latest_notification");
});

await test("the latest notification read hides immediately and stale reads cannot overwrite it", async () => {
  const deferredLoads = [];
  const fetchPublicNotifications = () => new Promise((resolve) => {
    deferredLoads.push(resolve);
  });
  const { page, calls } = loadNotificationPage({ fetchPublicNotifications });

  const firstLoad = page.loadNotifications();
  const secondLoad = page.loadNotifications();
  assert.deepEqual(calls.nativeLoadingEvents.map((event) => event.type), ["show"]);

  deferredLoads[1]([{ id: "latest_notification", type: "product_new" }]);
  await secondLoad;
  assert.deepEqual(
    calls.nativeLoadingEvents.map((event) => event.type),
    ["show", "hide"]
  );
  assert.equal(page.data.loading, false);
  assert.equal(page.data.publicNotifications[0].id, "latest_notification");

  deferredLoads[0]([{ id: "stale_notification", type: "version_update" }]);
  await firstLoad;
  assert.deepEqual(
    calls.nativeLoadingEvents.map((event) => event.type),
    ["show", "hide"]
  );
  assert.equal(page.data.publicNotifications[0].id, "latest_notification");
});

await test("leaving during a notification read hides once and ignores the late result", async () => {
  let resolveRead;
  const { page, calls } = loadNotificationPage({
    fetchPublicNotifications: () => new Promise((resolve) => {
      resolveRead = resolve;
    }),
  });

  const pendingLoad = page.loadNotifications();
  assert.deepEqual(calls.nativeLoadingEvents.map((event) => event.type), ["show"]);

  page.onHide();
  assert.deepEqual(calls.nativeLoadingEvents.map((event) => event.type), ["show", "hide"]);

  resolveRead([{ id: "late_notification", type: "version_update" }]);
  await pendingLoad;
  assert.deepEqual(calls.nativeLoadingEvents.map((event) => event.type), ["show", "hide"]);
  assert.equal(page.data.publicNotifications.length, 0);
  assert.equal(page.data.errorMessage, "");
});

await test("subscription authorization is triggered by a tap and stored server-side", async () => {
  const { page, calls } = loadNotificationPage({ subscribeStatus: "accept" });
  await page.loadNotifications();
  await page.subscribeNext({
    currentTarget: { dataset: { type: "product_new" } },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(calls.subscribeRequests[0].tmplIds)), ["product_template_id_1234567890"]);
  assert.deepEqual(calls.grants, [{
    type: "product_new",
    templateId: "product_template_id_1234567890",
    status: "accept",
  }]);
  assert.equal(page.data.subscriptions.product_new.status, "granted");
});

await test("disabled subscription settings open WeChat settings after authorization fails", async () => {
  const { page, calls } = loadNotificationPage({
    subscribeError: {
      errCode: 20004,
      errMsg: "requestSubscribeMessage:fail main switch off",
    },
  });
  await page.loadNotifications();
  await page.subscribeNext({
    currentTarget: { dataset: { type: "product_new" } },
  });

  assert.equal(calls.settingChecks, 0);
  assert.equal(calls.settings, 1);
  assert.equal(calls.subscribeRequests.length, 1);
  assert.equal(calls.grantAttempts, 0);
});

await test("a template absent from the running AppID is diagnosed after WeChat rejects it", async () => {
  const { page, calls } = loadNotificationPage({
    subscribeError: {
      errCode: 20001,
      errMsg: "requestSubscribeMessage:fail No template data return",
    },
    templateVerification: {
      appid: "wx351f937287eb5886",
      verificationAvailable: true,
      templates: {
        product_new: {
          existsInCurrentApp: false,
        },
      },
    },
  });
  await page.loadNotifications();
  await page.subscribeNext({
    currentTarget: { dataset: { type: "product_new" } },
  });

  assert.equal(calls.subscribeRequests.length, 1);
  assert.equal(calls.templateVerifications, 1);
  assert.equal(calls.grantAttempts, 0);
  assert.equal(calls.modals.at(-1).title, "模板不属于当前小程序");
  assert.equal(calls.modals.at(-1).content.includes("wx351f937287eb5886"), true);
});

await test("WeChat 20001 reports a template type mismatch after cloud verification", async () => {
  const { page, calls } = loadNotificationPage({
    subscribeError: {
      errCode: 20001,
      errMsg: "requestSubscribeMessage:fail No template data return, verify the template id exist",
    },
  });
  await page.loadNotifications();
  await page.subscribeNext({
    currentTarget: { dataset: { type: "product_new" } },
  });

  assert.equal(calls.grantAttempts, 0);
  assert.equal(calls.subscribeRequests.length, 1);
  assert.equal(calls.templateVerifications, 1);
  assert.equal(calls.modals.at(-1).title, "模板类型暂不可用");
  assert.equal(calls.modals.at(-1).content.includes("商品上新通知"), true);
});

await test("tap gesture errors tell the user to tap the subscription button again", async () => {
  const { page, calls } = loadNotificationPage({
    subscribeError: {
      errMsg: "requestSubscribeMessage:fail can only be invoked by user TAP gesture",
    },
  });
  await page.loadNotifications();
  await page.subscribeNext({
    currentTarget: { dataset: { type: "version_update" } },
  });

  assert.equal(calls.subscribeRequests.length, 1);
  assert.equal(calls.templateVerifications, 0);
  assert.equal(calls.grantAttempts, 0);
  assert.equal(calls.toasts.at(-1).title, "请直接点击订阅按钮重试");
});

await test("a code-only main switch error directs the user to WeChat settings", async () => {
  const { page, calls } = loadNotificationPage({
    subscribeError: {
      errCode: 20004,
      errMsg: "requestSubscribeMessage:fail",
    },
  });
  await page.loadNotifications();
  await page.subscribeNext({
    currentTarget: { dataset: { type: "product_new" } },
  });

  assert.equal(calls.grantAttempts, 0);
  assert.equal(calls.subscribeRequests.length, 1);
  assert.equal(calls.settings, 1);
  assert.equal(calls.toasts.at(-1).title, "请在微信设置中开启订阅消息");
});

await test("cloud grant saving retries once after WeChat authorization succeeds", async () => {
  const { page, calls } = loadNotificationPage({
    subscribeStatus: "accept",
    grantFailures: 1,
  });
  await page.loadNotifications();
  await page.subscribeNext({
    currentTarget: { dataset: { type: "version_update" } },
  });

  assert.equal(calls.subscribeRequests.length, 1);
  assert.equal(calls.grantAttempts, 2);
  assert.equal(calls.grants.length, 1);
  assert.equal(page.data.subscriptions.version_update.status, "granted");
});

await test("cloud grant failures show a separate configuration error after retry", async () => {
  const { page, calls } = loadNotificationPage({
    subscribeStatus: "accept",
    grantFailures: 2,
    grantErrorCode: "INVALID_TEMPLATE",
  });
  await page.loadNotifications();
  await page.subscribeNext({
    currentTarget: { dataset: { type: "version_update" } },
  });

  assert.equal(calls.subscribeRequests.length, 1);
  assert.equal(calls.grantAttempts, 2);
  assert.equal(calls.toasts.at(-1).title, "微信已授权，但云端模板配置不匹配");
});

await test("banned subscriptions open WeChat settings instead of requesting again", async () => {
  const data = loadNotificationData();
  const { page, calls } = loadNotificationPage({
    subscriptionResult: {
      subscriptions: data.normalizeSubscriptionState({
        product_new: { templateId: "product_template_id_1234567890", status: "banned" },
      }),
      templateIds: {
        version_update: "version_template_id_1234567890",
        product_new: "product_template_id_1234567890",
      },
      templateConfigs: {
        version_update: { valid: true, envKey: "VERSION_UPDATE_TEMPLATE_ID" },
        product_new: { valid: true, envKey: "PRODUCT_NEW_TEMPLATE_ID" },
      },
    },
  });
  await page.loadNotifications();
  await page.subscribeNext({
    currentTarget: { dataset: { type: "product_new" } },
  });
  assert.equal(calls.settings, 1);
  assert.equal(calls.subscribeRequests.length, 0);
});

await test("invalid local template configuration is blocked before WeChat authorization", async () => {
  const data = loadNotificationData();
  const { page, calls } = loadNotificationPage({
    subscriptionResult: {
      subscriptions: data.normalizeSubscriptionState({}),
      templateIds: {
        version_update: "10103",
        product_new: "1330",
      },
      templateConfigs: {
        version_update: {
          valid: false,
          envKey: "VERSION_UPDATE_TEMPLATE_ID",
          message: "VERSION_UPDATE_TEMPLATE_ID 配置错误",
        },
        product_new: {
          valid: false,
          envKey: "PRODUCT_NEW_TEMPLATE_ID",
          message: "PRODUCT_NEW_TEMPLATE_ID 配置错误",
        },
      },
    },
  });
  await page.loadNotifications();
  await page.subscribeNext({
    currentTarget: { dataset: { type: "product_new" } },
  });

  assert.equal(calls.subscribeRequests.length, 0);
  assert.equal(calls.grantAttempts, 0);
  assert.equal(calls.toasts.at(-1).title.includes("PRODUCT_NEW_TEMPLATE_ID"), true);
});

await test("product announcements navigate to their linked case", () => {
  const { page, calls } = loadNotificationPage();
  page.openNotification({
    currentTarget: {
      dataset: { target: "/pages/detail/index?id=case_doc_1" },
    },
  });
  assert.deepEqual(calls.navigations, ["/pages/detail/index?id=case_doc_1"]);
});

await test("new cases expose an opt-in product notification preview", () => {
  const wxml = readFileSync(caseEditWxmlPath, "utf8");
  assert.equal(wxml.includes("同时发布产品上新通知"), true);
  assert.equal(wxml.includes("productNotificationDraft.title"), true);
  assert.equal(wxml.includes("productNotificationDraft.content"), true);
  assert.equal(wxml.includes("wx:if=\"{{!isEdit}}\""), true);
});

await test("product notification preview uses the wedding display label", () => {
  const { page } = loadCaseEditPage({ scenes: ["婚宴"] });

  page.onPublishNotificationChange({ detail: { value: true } });
  assert.equal(page.data.form.scenes[0], "婚宴");
  assert.equal(
    page.data.productNotificationDraft.content,
    "新案例已上线：礼盒 / 国风 / 婚宴/喜宴"
  );
});

await test("new cases publish a linked announcement only when explicitly enabled", async () => {
  const { page, calls } = loadCaseEditPage();
  page.setData({
    publishProductNotification: true,
    productNotificationDraft: {
      title: "新品案例上新｜国风礼盒",
      content: "新案例已上线：礼盒 / 国风 / 送礼",
      sendSubscription: true,
    },
  });
  await page.saveCase();

  assert.equal(calls.creates.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.publishes)), [{
    caseDocId: "case_doc_1",
    title: "新品案例上新｜国风礼盒",
    content: "新案例已上线：礼盒 / 国风 / 送礼",
    sendSubscription: true,
  }]);
});

await test("notification failure keeps the saved case and gives a recovery path", async () => {
  const { page, calls } = loadCaseEditPage({ publishError: true });
  page.setData({
    publishProductNotification: true,
    productNotificationDraft: {
      title: "新品案例上新｜国风礼盒",
      content: "新案例已上线",
      sendSubscription: true,
    },
  });
  await page.saveCase();

  assert.equal(calls.creates.length, 1);
  assert.equal(calls.modals[0].title, "案例已保存");
  assert.equal(calls.modals[0].content.includes("通知发布失败"), true);
  assert.equal(calls.navigations, 1);
});
