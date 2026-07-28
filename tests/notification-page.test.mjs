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
    readFileSync(resolve(__dirname, "../miniprogram/miniprogram/utils/notificationData.js"), "utf8"),
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
    navigations: [],
    settings: 0,
    toasts: [],
  };
  const notificationData = loadNotificationData();
  const subscriptionResult = options.subscriptionResult || {
    subscriptions: notificationData.normalizeSubscriptionState({}),
    templateIds: {
      version_update: "version_template",
      product_new: "product_template",
    },
  };
  const sandbox = {
    Page(config) {
      page = config;
    },
    require(moduleName) {
      if (moduleName === "../../utils/notificationData") return notificationData;
      if (moduleName === "../../utils/notificationService") {
        return {
          fetchPublicNotifications: async () => options.notifications || [],
          fetchSubscriptionStatus: async () => subscriptionResult,
          saveSubscriptionGrant: async (type, templateId, status) => {
            calls.grants.push({ type, templateId, status });
            return {
              subscriptions: notificationData.normalizeSubscriptionState({
                [type]: { templateId, status: status === "accept" ? "granted" : status === "ban" ? "banned" : "rejected" },
              }),
              templateIds: subscriptionResult.templateIds,
            };
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    wx: {
      requestSubscribeMessage(request) {
        calls.subscribeRequests.push(request);
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
    scenes: ["送礼"],
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
      if (moduleName === "../../utils/caseAdminData") {
        return {
          CASE_ADMIN_FORM_OPTIONS: {},
          buildCaseAdminImagePath: () => "path",
          buildCaseAdminOptionViews: () => ({}),
          buildCaseAdminPayload: (form) => form,
          createEmptyCaseForm: () => ({ ...emptyForm }),
          CASE_ADMIN_GALLERY_MAX: 5,
          validateCaseAdminForm: () => ({ valid: true }),
        };
      }
      if (moduleName === "../../utils/caseAdminService") {
        return {
          createCaseAdmin: async (payload) => {
            calls.creates.push(payload);
            return { id: "case_doc_1" };
          },
          fetchCaseAdminDetail: async () => null,
          updateCaseAdmin: async () => ({}),
          uploadCaseCoverImage: async () => "cloud://env/image.jpg",
        };
      }
      if (moduleName === "../../utils/notificationAdminService") {
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
});

await test("subscription authorization is triggered by a tap and stored server-side", async () => {
  const { page, calls } = loadNotificationPage({ subscribeStatus: "accept" });
  await page.loadNotifications();
  await page.subscribeNext({
    currentTarget: { dataset: { type: "product_new" } },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(calls.subscribeRequests[0].tmplIds)), ["product_template"]);
  assert.deepEqual(calls.grants, [{
    type: "product_new",
    templateId: "product_template",
    status: "accept",
  }]);
  assert.equal(page.data.subscriptions.product_new.status, "granted");
});

await test("banned subscriptions open WeChat settings instead of requesting again", async () => {
  const data = loadNotificationData();
  const { page, calls } = loadNotificationPage({
    subscriptionResult: {
      subscriptions: data.normalizeSubscriptionState({
        product_new: { templateId: "product_template", status: "banned" },
      }),
      templateIds: {
        version_update: "version_template",
        product_new: "product_template",
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
