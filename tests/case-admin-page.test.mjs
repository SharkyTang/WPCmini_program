import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(__dirname, "../miniprogram/miniprogram/pages/case-admin/index.js");
const wxmlPath = resolve(__dirname, "../miniprogram/miniprogram/pages/case-admin/index.wxml");

function loadCaseAdminPage(options = {}) {
  let pageConfig;
  const calls = {
    deletes: [],
    fetches: [],
    toasts: [],
  };
  const sandbox = {
    Page(config) {
      pageConfig = config;
    },
    require(moduleName) {
      if (moduleName === "../../utils/caseAdminService") {
        return {
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
          setCaseVisibility: async () => ({}),
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
  const visibilityIndex = wxml.indexOf('bindtap="toggleCaseVisibility"');
  const deleteIndex = wxml.indexOf('bindtap="deleteCase"');

  assert.notEqual(deleteIndex, -1);
  assert.ok(deleteIndex > visibilityIndex);
  assert.equal(wxml.includes("删除"), true);
});

await test("canceling delete does not call delete service", async () => {
  let modalOptions;
  const { page, calls } = loadCaseAdminPage({
    onShowModal(options) {
      modalOptions = options;
    },
  });

  page.deleteCase({
    currentTarget: {
      dataset: {
        id: "case_doc_1",
      },
    },
  });
  await modalOptions.success({ confirm: false });

  assert.deepEqual(calls.deletes, []);
  assert.deepEqual(calls.fetches, []);
});

await test("confirming delete calls service and refreshes list", async () => {
  let modalOptions;
  const { page, calls } = loadCaseAdminPage({
    onShowModal(options) {
      modalOptions = options;
    },
  });

  page.deleteCase({
    currentTarget: {
      dataset: {
        id: "case_doc_1",
      },
    },
  });
  assert.equal(modalOptions.title, "删除这个案例？");
  assert.equal(modalOptions.confirmText, "删除");

  await modalOptions.success({ confirm: true });

  assert.deepEqual(calls.deletes, ["case_doc_1"]);
  assert.equal(calls.toasts[0].title, "已删除");
  assert.equal(calls.fetches.length, 1);
  assert.equal(calls.fetches[0].page, 1);
});

await test("delete failure shows a clear toast", async () => {
  let modalOptions;
  const { page, calls } = loadCaseAdminPage({
    deleteError: true,
    silentConsole: true,
    onShowModal(options) {
      modalOptions = options;
    },
  });

  page.deleteCase({
    currentTarget: {
      dataset: {
        id: "case_doc_1",
      },
    },
  });
  await modalOptions.success({ confirm: true });

  assert.deepEqual(calls.deletes, ["case_doc_1"]);
  assert.equal(calls.toasts[0].title, "删除失败，请稍后重试");
  assert.deepEqual(calls.fetches, []);
});
