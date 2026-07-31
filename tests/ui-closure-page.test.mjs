import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const miniRoot = resolve(__dirname, "../miniprogram/miniprogram");

function setPageData(nextData) {
  Object.entries(nextData).forEach(([key, value]) => {
    if (!key.includes(".")) {
      this.data[key] = value;
      return;
    }
    const parts = key.split(".");
    let target = this.data;
    parts.slice(0, -1).forEach((part) => {
      target[part] = target[part] || {};
      target = target[part];
    });
    target[parts[parts.length - 1]] = value;
  });
}

function loadCollectionPage(kind, serviceOverrides = {}, accessOverrides = {}) {
  const modulePath = resolve(miniRoot, `pages/${kind}/index.js`);
  let pageConfig;
  const serviceModule = kind === "favorites"
    ? "../../utils/favoriteService"
    : "../../utils/historyService";
  const service = kind === "favorites"
    ? {
      clearFavorites: async () => {},
      fetchFavoriteCases: async () => [],
      removeFavoriteRecords: async () => {},
      ...serviceOverrides,
    }
    : {
      clearHistory: async () => {},
      fetchHistoryCases: async () => [],
      removeHistoryRecords: async () => {},
      ...serviceOverrides,
    };

  const sandbox = {
    Page(config) {
      pageConfig = config;
    },
    require(moduleName) {
      if (moduleName === serviceModule) return service;
      if (moduleName === "../../utils/libraryAccessService") {
        return {
          checkLibraryAccess: async () => ({ status: "ready", openid: "openid_1" }),
          reportLibraryEvent() {},
          requestLibraryAccess: async () => ({ status: "ready" }),
          resumePendingLibraryAction: async () => ({ resumed: false }),
          ...accessOverrides,
        };
      }
      if (moduleName === "../../utils/userService") {
        return { resumePendingProfileAction: async () => false };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    wx: {
      hideLoading() {},
      navigateTo() {},
      showLoading() {},
      showToast() {},
      switchTab() {},
    },
  };

  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, { filename: modulePath });
  pageConfig.setData = setPageData;
  return pageConfig;
}

function loadInquiryDetailPage(serviceOverrides = {}) {
  const modulePath = resolve(miniRoot, "pages/inquiry-admin/detail.js");
  let pageConfig;
  const service = {
    fetchInquiryDetail: async () => null,
    saveInquiryNote: async (id, note) => note,
    updateInquiryStatus: async (id, status) => status,
    ...serviceOverrides,
  };
  const statusOptions = [
    { value: "new", label: "新需求" },
    { value: "processing", label: "跟进中" },
    { value: "done", label: "已完成" },
  ];

  const sandbox = {
    Page(config) {
      pageConfig = config;
    },
    require(moduleName) {
      if (moduleName === "./utils/inquiryAdminData") {
        return {
          INQUIRY_STATUS_OPTIONS: statusOptions,
          validateAdminNote: (note) => ({ valid: true, adminNote: note }),
        };
      }
      if (moduleName === "./utils/inquiryAdminService") return service;
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    wx: {
      navigateTo() {},
      setClipboardData() {},
      showToast() {},
    },
  };

  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, { filename: modulePath });
  pageConfig.setData = setPageData;
  return pageConfig;
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

await test("favorites and history use WeUI dialogs and messages", () => {
  ["favorites", "history"].forEach((pageName) => {
    const pageJson = JSON.parse(readFileSync(resolve(miniRoot, `pages/${pageName}/index.json`), "utf8"));
    const wxml = readFileSync(resolve(miniRoot, `pages/${pageName}/index.wxml`), "utf8");
    assert.equal(pageJson.usingComponents["mp-dialog"], "weui-miniprogram/dialog/dialog");
    assert.equal(pageJson.usingComponents["mp-msg"], "weui-miniprogram/msg/msg");
    assert.equal(wxml.includes("<mp-dialog"), true);
    assert.equal(wxml.includes("<mp-msg"), true);
  });
});

await test("cancelling favorite deletion does not call the service", async () => {
  let removeCalls = 0;
  const page = loadCollectionPage("favorites", {
    removeFavoriteRecords: async () => {
      removeCalls += 1;
    },
  });
  page.setData({
    selectedFavoriteIds: ["favorite_1"],
    favoriteCards: [{ favoriteId: "favorite_1" }],
  });

  page.cancelSelectedFavorites();
  await page.handleConfirmDialogTap({ detail: { index: 0 } });
  assert.equal(removeCalls, 0);

  page.cancelSelectedFavorites();
  page.loadFavorites = async () => {};
  await page.handleConfirmDialogTap({ detail: { index: 1 } });
  assert.equal(removeCalls, 1);
});

await test("cancelling history deletion does not call the service", async () => {
  let removeCalls = 0;
  const page = loadCollectionPage("history", {
    removeHistoryRecords: async () => {
      removeCalls += 1;
    },
  });
  page.setData({
    selectedHistoryIds: ["history_1"],
    historyCards: [{ historyId: "history_1" }],
  });

  page.deleteSelectedHistory();
  await page.handleConfirmDialogTap({ detail: { index: 0 } });
  assert.equal(removeCalls, 0);

  page.deleteSelectedHistory();
  page.loadHistory = async () => {};
  await page.handleConfirmDialogTap({ detail: { index: 1 } });
  assert.equal(removeCalls, 1);
});

await test("collection pages distinguish profile requirements and identity errors from empty data", async () => {
  for (const [kind, libraryKind] of [
    ["favorites", "favorites"],
    ["history", "history"],
  ]) {
    let fetchCalls = 0;
    const fetchOverride = kind === "favorites"
      ? { fetchFavoriteCases: async () => { fetchCalls += 1; return []; } }
      : { fetchHistoryCases: async () => { fetchCalls += 1; return []; } };

    const blockedPage = loadCollectionPage(kind, fetchOverride, {
      checkLibraryAccess: async (requestedKind) => {
        assert.equal(requestedKind, libraryKind);
        return { status: "profile_required", mode: "profile" };
      },
    });
    await blockedPage.ensureProfileAndLoad();
    assert.equal(blockedPage.data.accessState, "profile_required");
    assert.equal(fetchCalls, 0);

    const errorPage = loadCollectionPage(kind, fetchOverride, {
      checkLibraryAccess: async () => ({ status: "error", error: new Error("offline") }),
    });
    const cardsKey = kind === "favorites" ? "favoriteCards" : "historyCards";
    errorPage.setData({
      [cardsKey]: [{ id: "cached_case", title: "保留的列表数据" }],
    });
    await errorPage.ensureProfileAndLoad();
    assert.equal(errorPage.data.accessState, "error");
    assert.match(errorPage.data.errorMessage, /暂时无法验证资料/);
    assert.equal(errorPage.data[cardsKey].length, 1);
    assert.equal(fetchCalls, 0);
  }
});

await test("a resumed collection action suppresses the fallback load on onShow", async () => {
  for (const resumeResult of [
    true,
    { resumed: true, success: false },
  ]) {
    for (const kind of ["favorites", "history"]) {
      let fetchCalls = 0;
      const fetchOverride = kind === "favorites"
        ? { fetchFavoriteCases: async () => { fetchCalls += 1; return []; } }
        : { fetchHistoryCases: async () => { fetchCalls += 1; return []; } };
      const page = loadCollectionPage(kind, fetchOverride, {
        resumePendingLibraryAction: async () => resumeResult,
      });

      await page.onShow();

      assert.equal(fetchCalls, 0);
    }
  }
});

await test("inquiry status changes only after dialog confirmation", async () => {
  let updateCalls = 0;
  const page = loadInquiryDetailPage({
    updateInquiryStatus: async (id, status) => {
      updateCalls += 1;
      return status;
    },
  });
  page.setData({
    id: "inquiry_1",
    item: { status: "new", statusLabel: "新需求" },
    statusIndex: 0,
  });

  page.onStatusChange({ detail: { value: "1" } });
  await page.handleConfirmDialogTap({ detail: { index: 0 } });
  assert.equal(updateCalls, 0);
  assert.equal(page.data.statusIndex, 0);

  page.onStatusChange({ detail: { value: "1" } });
  await page.handleConfirmDialogTap({ detail: { index: 1 } });
  assert.equal(updateCalls, 1);
  assert.equal(page.data.statusIndex, 1);
  assert.equal(page.data.item.status, "processing");
});

await test("notification and inquiry admin pages import planned WeUI components", () => {
  const notificationsJson = JSON.parse(
    readFileSync(resolve(miniRoot, "pages/notifications/index.json"), "utf8")
  );
  const detailJson = JSON.parse(
    readFileSync(resolve(miniRoot, "pages/inquiry-admin/detail.json"), "utf8")
  );
  const detailWxml = readFileSync(resolve(miniRoot, "pages/inquiry-admin/detail.wxml"), "utf8");
  const notificationAdminJson = JSON.parse(
    readFileSync(resolve(miniRoot, "pages/notification-admin/index.json"), "utf8")
  );
  const notificationEditJson = JSON.parse(
    readFileSync(resolve(miniRoot, "pages/notification-admin/edit.json"), "utf8")
  );

  assert.equal(notificationsJson.usingComponents["mp-msg"], "weui-miniprogram/msg/msg");
  assert.equal(notificationAdminJson.usingComponents["mp-dialog"], "weui-miniprogram/dialog/dialog");
  assert.equal(notificationEditJson.usingComponents["mp-toptips"], "weui-miniprogram/toptips/toptips");
  assert.equal(detailJson.usingComponents["mp-dialog"], "weui-miniprogram/dialog/dialog");
  assert.equal(detailJson.usingComponents["mp-toptips"], "weui-miniprogram/toptips/toptips");
  assert.equal(detailWxml.includes("<mp-dialog"), true);
  assert.equal(detailWxml.includes("<mp-toptips"), true);
});
