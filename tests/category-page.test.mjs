import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(__dirname, "../miniprogram/miniprogram/pages/category/index.js");

function loadCategoryPage(cases = [], appGlobalData = {}, wxMock = {}) {
  let pageConfig;
  const app = {
    globalData: appGlobalData,
  };
  const sandbox = {
    Page(config) {
      pageConfig = config;
    },
    getApp() {
      return app;
    },
    require(moduleName) {
      if (moduleName === "../../utils/caseData") {
        return {
          DEFAULT_FILTERS: [
            {
              key: "packageTypes",
              title: "包装",
              options: ["礼盒"],
              type: "multiple",
            },
          ],
          filterCases(items) {
            return items.filter((item) => item.isVisible);
          },
          selectedFilterCount: () => 0,
        };
      }
      if (moduleName === "../../utils/cloudData") {
        return {
          attachCaseImageUrls: async (items) => items.map((item) => ({
            ...item,
            imageFileId: item.coverThumbnail || item.coverImage || "",
            coverImageUrl: item.coverThumbnail || item.coverImage || "",
            imageRetryCount: 0,
            imageLoadState: "ready",
          })),
          fetchVisibleCases: async () => cases,
          refreshImageUrl: async (fileID) => fileID,
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
      getStorageSync() {
        return "";
      },
      navigateTo() {},
      removeStorageSync() {},
      stopPullDownRefresh() {},
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

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildCase(id, overrides = {}) {
  return {
    id,
    title: id,
    isVisible: true,
    sortOrder: Number(id.replace(/\D/g, "")) || 0,
    statuses: [],
    packageTypes: ["礼盒"],
    ...overrides,
  };
}

await test("category sort options use recent and popular labels", () => {
  const source = readFileSync(pagePath, "utf8");

  assert.equal(source.includes("最近上新"), true);
  assert.equal(source.includes("热门产品"), true);
  assert.equal(source.includes("最新优先"), false);
});

await test("category page initializes latest sort from URL options", async () => {
  const { page } = loadCategoryPage([
    buildCase("case_1", { sortOrder: 1, statuses: ["最新产品"], homeSections: [] }),
    buildCase("case_3", { sortOrder: 3, statuses: ["最新产品"], homeSections: [] }),
    buildCase("case_2", { sortOrder: 2, statuses: [] }),
  ]);

  await page.onLoad({ sort: "latest" });

  assert.equal(page.data.selectedSort, "latest");
  assert.equal(page.data.activeNavKey, "sort");
  assert.equal(page.data.expandedNavKey, "sort");
  assert.deepEqual(plain(page.data.filteredCases.map((item) => item.id)), [
    "case_3",
    "case_1",
  ]);
});

await test("category page initializes popular sort from URL options", async () => {
  const { page } = loadCategoryPage([
    buildCase("case_1", { statuses: [] }),
    buildCase("case_2", { statuses: ["最新产品"] }),
    buildCase("case_3", { statuses: ["热门产品"], homeSections: [] }),
  ]);

  await page.onLoad({ sort: "popular" });

  assert.equal(page.data.selectedSort, "popular");
  assert.equal(page.data.activeNavKey, "sort");
  assert.deepEqual(plain(page.data.filteredCases.map((item) => item.id)), [
    "case_3",
  ]);
});

await test("category page falls back to default sort for invalid URL options", async () => {
  const { page } = loadCategoryPage([buildCase("case_1")]);

  await page.onLoad({ sort: "unknown" });

  assert.equal(page.data.selectedSort, "default");
  assert.equal(page.data.activeNavKey, "packageTypes");
  assert.equal(page.data.expandedNavKey, "packageTypes");
});

await test("category page consumes pending tab sort from app global data", async () => {
  const { app, page } = loadCategoryPage(
    [
      buildCase("case_1", { statuses: [] }),
      buildCase("case_2", { statuses: ["热门产品"], homeSections: [] }),
    ],
    {
      pendingCategorySort: "popular",
    }
  );

  await page.onLoad({});
  page.onShow();

  assert.equal(page.data.selectedSort, "popular");
  assert.equal(page.data.activeNavKey, "sort");
  assert.equal(page.data.expandedNavKey, "sort");
  assert.deepEqual(plain(page.data.filteredCases.map((item) => item.id)), ["case_2"]);
  assert.equal(app.globalData.pendingCategorySort, "");
});

await test("category page applies pending tab sort during first load", async () => {
  const { app, page } = loadCategoryPage(
    [
      buildCase("case_1", { statuses: [] }),
      buildCase("case_2", { statuses: ["热门产品"], homeSections: [] }),
    ],
    {
      pendingCategorySort: "popular",
    }
  );

  await page.onLoad({});

  assert.equal(page.data.selectedSort, "popular");
  assert.equal(page.data.activeNavKey, "sort");
  assert.deepEqual(plain(page.data.filteredCases.map((item) => item.id)), ["case_2"]);
  assert.equal(app.globalData.pendingCategorySort, "");
});

await test("category page consumes pending tab sort from storage", async () => {
  let removedKey = "";
  const { page } = loadCategoryPage(
    [
      buildCase("case_1", { sortOrder: 1 }),
      buildCase("case_3", { sortOrder: 3, statuses: ["最新产品"], homeSections: [] }),
    ],
    {},
    {
      getStorageSync(key) {
        return key === "pendingCategorySort" ? "latest" : "";
      },
      removeStorageSync(key) {
        removedKey = key;
      },
    }
  );

  await page.onLoad({});

  assert.equal(page.data.selectedSort, "latest");
  assert.deepEqual(plain(page.data.filteredCases.map((item) => item.id)), [
    "case_3",
  ]);
  assert.equal(removedKey, "pendingCategorySort");
});
