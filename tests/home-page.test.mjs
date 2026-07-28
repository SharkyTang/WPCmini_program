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
          attachCaseImageUrls: async (items) =>
            items.map((item) => ({
              ...item,
              coverImageUrl: `${item.coverImage || item.id}?temp=1`,
            })),
          fetchVisibleCases: async () => cases,
          fetchVisibleBanners: async () => [],
        };
      }
      if (moduleName === "../../utils/caseCatalogService") {
        return {
          fetchHomeFeed: async () => {
            throw new Error("catalog unavailable");
          },
        };
      }
      if (moduleName === "../../utils/catalogCache") {
        return {
          HOME_CACHE_KEY: "wineHomeFeedV2",
          readCache: () => null,
          writeCache() {},
        };
      }
      if (moduleName === "../../utils/caseRefresh") {
        return {
          getCaseDataVersion: () => 1,
          shouldRefreshCaseData: () => false,
        };
      }
      if (moduleName === "../../utils/caseData") {
        return {
          HOME_SECTION_VALUES: {
            BANNER: "banner",
            POPULAR: "popular",
            LATEST: "latest",
          },
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
    homeSections: [],
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

await test("home page shows only selected home section cases", async () => {
  const cases = Array.from({ length: 8 }, (_, index) =>
    buildCase(index + 1, {
      homeSections: [
        ...(index < 5 ? ["popular"] : []),
        ...(index < 7 ? ["latest"] : []),
      ],
    })
  );
  const { page } = loadHomePage({}, cases);

  await page.loadData();

  assert.equal(page.data.popularCases.length, 4);
  assert.equal(page.data.latestCases.length, 6);
  assert.equal(page.data.popularCases.every((item) => item.homeSections.includes("popular")), true);
  assert.equal(page.data.latestCases.every((item) => item.homeSections.includes("latest")), true);
  assert.equal(page.data.popularCases.every((item) => item.homeBadge === "近期热门"), true);
  assert.equal(page.data.latestCases.every((item) => item.homeBadge === "最近上新"), true);
});

await test("home page renders display badges without persisting new fields", () => {
  const wxml = readFileSync(wxmlPath, "utf8");

  assert.equal(wxml.includes("product-badge"), true);
  assert.equal(wxml.includes("{{item.homeBadge}}"), true);
  assert.equal(wxml.includes("story-mark"), true);
});

await test("visible cases without home section selections stay off homepage sections", async () => {
  const { page } = loadHomePage({}, [
    buildCase(1, { isVisible: true, homeSections: [] }),
    buildCase(2, { isVisible: true, homeSections: ["latest"] }),
  ]);

  await page.loadData();

  assert.deepEqual(page.data.popularCases.map((item) => item.id), []);
  assert.deepEqual(page.data.latestCases.map((item) => item.id), ["case_2"]);
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
