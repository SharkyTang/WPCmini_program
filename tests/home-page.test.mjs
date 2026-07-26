import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(__dirname, "../miniprogram/miniprogram/pages/index/index.js");
const wxmlPath = resolve(__dirname, "../miniprogram/miniprogram/pages/index/index.wxml");

function loadHomePage(wxMock = {}, cases = []) {
  let pageConfig;
  const app = {
    globalData: {},
  };
  const sandbox = {
    Page(config) {
      pageConfig = config;
    },
    getApp() {
      return app;
    },
    require(moduleName) {
      if (moduleName === "../../utils/cloudData") {
        return {
          fetchVisibleCases: async () => cases,
          fetchVisibleBanners: async () => [],
        };
      }
      if (moduleName === "../../utils/caseRefresh") {
        return {
          getCaseDataVersion: () => 1,
          shouldRefreshCaseData: () => false,
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    wx: {
      navigateTo() {},
      setStorageSync() {},
      switchTab() {},
      ...wxMock,
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
    app,
    page: pageConfig,
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

function buildCase(index, overrides = {}) {
  return {
    id: `case_${index}`,
    title: `case_${index}`,
    isVisible: true,
    sortOrder: index,
    packageTypes: ["礼盒"],
    statuses: [],
    ...overrides,
  };
}

await test("home sections expose more links for popular and latest products", () => {
  const wxml = readFileSync(wxmlPath, "utf8");

  assert.equal((wxml.match(/查看更多/g) || []).length, 2);
  assert.equal(wxml.includes("&gt;"), false);
  assert.equal(wxml.includes("查看更多 >"), true);
  assert.equal(wxml.includes('data-sort="popular"'), true);
  assert.equal(wxml.includes('data-sort="latest"'), true);
  assert.equal(wxml.includes('bindtap="navigateToCategory"'), true);
});

await test("home page shows four popular cases and six latest cases", async () => {
  const cases = Array.from({ length: 8 }, (_, index) =>
    buildCase(index + 1, {
      statuses: index < 5 ? ["推荐"] : [],
    })
  );
  const { page } = loadHomePage({}, cases);

  await page.loadData();

  assert.equal(page.data.popularCases.length, 4);
  assert.equal(page.data.latestCases.length, 6);
});

await test("home more links switch to category tab with selected sort", () => {
  let switchedUrl = "";
  let storedSort = "";
  const { app, page } = loadHomePage({
    setStorageSync(key, value) {
      if (key === "pendingCategorySort") {
        storedSort = value;
      }
    },
    switchTab(options) {
      switchedUrl = options.url;
    },
  });

  page.navigateToCategory({
    currentTarget: {
      dataset: {
        sort: "popular",
      },
    },
  });

  assert.equal(switchedUrl, "/pages/category/index");
  assert.equal(app.globalData.pendingCategorySort, "popular");
  assert.equal(storedSort, "popular");
});
