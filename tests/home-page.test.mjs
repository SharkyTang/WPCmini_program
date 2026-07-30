import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(__dirname, "../miniprogram/miniprogram/pages/index/index.js");
const wxmlPath = resolve(__dirname, "../miniprogram/miniprogram/pages/index/index.wxml");
const wxssPath = resolve(__dirname, "../miniprogram/miniprogram/pages/index/index.wxss");

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
  assert.equal((wxml.match(/class="product-image"\s+mode="aspectFill"/g) || []).length, 2);
});

await test("home carousel keeps one crop ratio across active and preview cards", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const wxss = readFileSync(wxssPath, "utf8");
  const swiperBlock = wxml.match(/<swiper\b[\s\S]*?<\/swiper>/)?.[0] || "";
  const swiperTag = swiperBlock.match(/<swiper\b[^>]*>/)?.[0] || "";
  const bannerCardTag =
    swiperBlock.match(/<view\b[^>]*class="banner-card[^"]*"[^>]*>/)?.[0] || "";
  const foregroundTag =
    swiperBlock.match(/<image\b[^>]*class="banner-image"[^>]*>/)?.[0] || "";
  const titleTag =
    swiperBlock.match(/<view\b[^>]*class="banner-title"[\s\S]*?>/)?.[0] || "";

  assert.equal(swiperBlock.includes("banner-image-backdrop"), false);
  assert.equal(wxss.includes("banner-image-backdrop"), false);
  assert.match(foregroundTag, /mode="aspectFill"/);
  assert.equal(foregroundTag.includes("activeBannerIndex ?"), false);
  assert.match(foregroundTag, /src="{{item\.imageUrl}}"/);
  assert.match(foregroundTag, /\slazy-load(?:\s|>)/);
  assert.match(wxss, /\.banner-swiper\s*\{[^}]*height:\s*382rpx/s);
  assert.match(wxss, /\.banner-card\s*\{[^}]*height:\s*360rpx/s);
  assert.match(wxss, /\.banner-card-preview\s*\{[^}]*opacity:\s*0\.72/s);
  assert.match(wxss, /\.banner-card-active\s*\{[^}]*opacity:\s*1/s);
  assert.match(swiperTag, /\sautoplay(?:\s|>)/);
  assert.match(swiperTag, /\scircular(?:\s|>)/);
  assert.match(swiperTag, /interval="3600"/);
  assert.match(swiperTag, /duration="450"/);
  assert.match(swiperTag, /previous-margin="188rpx"/);
  assert.match(swiperTag, /next-margin="188rpx"/);
  assert.match(swiperTag, /bindchange="onBannerChange"/);
  assert.match(swiperBlock, /wx:for-index="bannerIndex"/);
  assert.match(bannerCardTag, /bannerIndex == activeBannerIndex/);
  assert.match(titleTag, /item\.title && bannerIndex == activeBannerIndex/);
  assert.match(bannerCardTag, /bindtap="onBannerTap"/);
  assert.match(bannerCardTag, /data-id="{{item\.caseId}}"/);
});

await test("home carousel tracks the active banner for its title state", () => {
  const { page } = loadHomePage();

  assert.equal(page.data.activeBannerIndex, 0);
  page.onBannerChange({
    detail: {
      current: 2,
    },
  });
  assert.equal(page.data.activeBannerIndex, 2);

  page.onBannerChange({
    detail: {
      current: -1,
    },
  });
  assert.equal(page.data.activeBannerIndex, 2);
});

await test("home banner tap still opens its case detail", () => {
  let navigatedUrl = "";
  const { page } = loadHomePage({
    navigateTo(options) {
      navigatedUrl = options.url;
    },
  });

  page.onBannerTap({
    currentTarget: {
      dataset: {
        id: "case 1",
      },
    },
  });

  assert.equal(navigatedUrl, "/pages/detail/index?id=case%201");
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
