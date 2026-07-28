import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(__dirname, "../miniprogram/miniprogram/pages/case-admin/index.js");
const wxmlPath = resolve(__dirname, "../miniprogram/miniprogram/pages/case-admin/index.wxml");
const jsonPath = resolve(__dirname, "../miniprogram/miniprogram/pages/case-admin/index.json");

function loadCaseAdminPage(options = {}) {
  let pageConfig;
  const calls = {
    deletes: [],
    fetches: [],
    homepageFetches: [],
    modals: [],
    toasts: [],
  };
  const sandbox = {
    Page(config) {
      pageConfig = config;
    },
    require(moduleName) {
      if (moduleName === "./utils/caseAdminService") {
        return {
          CASE_ADMIN_VIEW_OPTIONS: [
            { value: "all", label: "全部" },
            { value: "visible", label: "显示中" },
            { value: "hidden", label: "已隐藏" },
            { value: "banner", label: "首页轮播" },
            { value: "popular", label: "热门产品" },
            { value: "latest", label: "最新产品" },
            { value: "pinned", label: "置顶" },
          ],
          CASE_ADMIN_VISIBILITY_OPTIONS: [
            { value: "all", label: "全部" },
            { value: "visible", label: "显示中" },
            { value: "hidden", label: "已隐藏" },
          ],
          DEFAULT_PAGE_SIZE: 20,
          checkCaseAdminAccess: async () => true,
          deleteCaseAdmin: async (id) => {
            calls.deletes.push(id);
            if (options.deleteError) throw new Error("delete failed");
            return { id };
          },
          fetchCaseAdminList: async (query) => {
            calls.fetches.push(query);
            return {
              items: [],
              page: query.page,
              pageSize: query.pageSize,
              hasMore: false,
            };
          },
          fetchCaseAdminHomepageDisplay: async (query) => {
            calls.homepageFetches.push(query);
            return { items: [], slot: query.slot };
          },
          setCaseVisibility: async () => {
            if (options.visibilityError) throw options.visibilityError;
            return {};
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console: options.silentConsole
      ? {
          ...console,
          warn() {},
        }
      : console,
    wx: {
      showModal(modalOptions) {
        calls.modals.push(modalOptions);
        options.onShowModal && options.onShowModal(modalOptions);
      },
      showToast(toastOptions) {
        calls.toasts.push(toastOptions);
      },
      navigateTo() {},
      stopPullDownRefresh() {},
    },
  };

  vm.runInNewContext(readFileSync(pagePath, "utf8"), sandbox, {
    filename: pagePath,
  });
  pageConfig.setData = function setData(nextData) {
    this.data = {
      ...this.data,
      ...nextData,
    };
  };
  return {
    page: pageConfig,
    calls,
  };
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

await test("case admin list shows delete after visibility action", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const pageJson = JSON.parse(readFileSync(jsonPath, "utf8"));
  const visibilityIndex = wxml.indexOf('bindtap="toggleCaseVisibility"');
  const deleteIndex = wxml.indexOf('bindtap="deleteCase"');

  assert.equal(pageJson.usingComponents["mp-dialog"], "weui-miniprogram/dialog/dialog");
  assert.notEqual(deleteIndex, -1);
  assert.ok(deleteIndex > visibilityIndex);
  assert.equal(wxml.includes("删除"), true);
  assert.equal(wxml.includes('scroll-x="true"'), true);
  assert.equal(wxml.includes("首页轮播"), false);
  assert.equal(wxml.includes("<mp-dialog"), true);
  assert.equal(wxml.includes('bindbuttontap="handleConfirmDialogTap"'), true);
});

await test("homepage view replaces visibility filtering and does not paginate", async () => {
  const { page, calls } = loadCaseAdminPage();

  page.selectView({ currentTarget: { dataset: { value: "banner" } } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(page.data.activeView, "banner");
  assert.equal(page.data.isHomeDisplay, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.homepageFetches)), [{ slot: "banner", keyword: "" }]);
  assert.equal(page.data.hasMore, false);
  page.onReachBottom();
  assert.equal(calls.homepageFetches.length, 1);
});

await test("pinned view uses the normal editable list endpoint", async () => {
  const { page, calls } = loadCaseAdminPage();
  page.selectView({ currentTarget: { dataset: { value: "pinned" } } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(page.data.isHomeDisplay, false);
  assert.equal(calls.fetches[0].visibility, "pinned");
});

await test("canceling delete does not call delete service", async () => {
  const { page, calls } = loadCaseAdminPage();

  page.deleteCase({
    currentTarget: {
      dataset: {
        id: "case_doc_1",
      },
    },
  });
  assert.equal(page.data.confirmDialog.title, "删除这个案例？");
  await page.handleConfirmDialogTap({ detail: { index: 0 } });

  assert.deepEqual(calls.deletes, []);
  assert.deepEqual(calls.fetches, []);
});

await test("confirming delete calls service and refreshes list", async () => {
  const { page, calls } = loadCaseAdminPage();

  page.deleteCase({
    currentTarget: {
      dataset: {
        id: "case_doc_1",
      },
    },
  });
  assert.equal(page.data.confirmDialog.title, "删除这个案例？");
  assert.equal(page.data.confirmDialog.buttons[1].text, "删除");

  await page.handleConfirmDialogTap({ detail: { index: 1 } });

  assert.deepEqual(calls.deletes, ["case_doc_1"]);
  assert.equal(calls.toasts[0].title, "已删除");
  assert.equal(calls.fetches.length, 1);
  assert.equal(calls.fetches[0].page, 1);
});

await test("delete failure shows a clear toast", async () => {
  const { page, calls } = loadCaseAdminPage({
    deleteError: true,
    silentConsole: true,
  });

  page.deleteCase({
    currentTarget: {
      dataset: {
        id: "case_doc_1",
      },
    },
  });
  await page.handleConfirmDialogTap({ detail: { index: 1 } });

  assert.deepEqual(calls.deletes, ["case_doc_1"]);
  assert.equal(calls.toasts[0].title, "删除失败，请稍后重试");
  assert.deepEqual(calls.fetches, []);
});

await test("homepage capacity errors explain why visibility cannot be restored", async () => {
  const error = new Error("热门产品最多展示 4 个，请先取消其他案例的热门产品显示");
  error.code = "HOME_DISPLAY_LIMIT_REACHED";
  const { page, calls } = loadCaseAdminPage({
    visibilityError: error,
    silentConsole: true,
  });

  await page.performCaseVisibility("hidden_cat", true);

  assert.equal(calls.modals.length, 1);
  assert.equal(calls.modals[0].title, "首页展示名额已满");
  assert.equal(calls.modals[0].content, error.message);
  assert.equal(calls.modals[0].showCancel, false);
  assert.deepEqual(calls.toasts, []);
});
