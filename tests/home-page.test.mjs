import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(__dirname, "../miniprogram/miniprogram/pages/index/index.js");
const wxmlPath = resolve(__dirname, "../miniprogram/miniprogram/pages/index/index.wxml");
const wxssPath = resolve(__dirname, "../miniprogram/miniprogram/pages/index/index.wxss");
const CACHE_TTL_MS = 20 * 60 * 1000;

function applySetDataPatch(currentData, patch) {
  const nextData = {
    ...currentData,
  };
  Object.entries(patch).forEach(([path, value]) => {
    const segments = path.match(/[^.[\]]+/g) || [];
    if (segments.length <= 1) {
      nextData[path] = value;
      return;
    }
    let target = nextData;
    segments.forEach((segment, index) => {
      const key = /^\d+$/.test(segment) ? Number(segment) : segment;
      if (index === segments.length - 1) {
        target[key] = value;
        return;
      }
      const nextSegment = segments[index + 1];
      const existing = target[key];
      target[key] = Array.isArray(existing)
        ? [...existing]
        : existing && typeof existing === "object"
          ? { ...existing }
          : /^\d+$/.test(nextSegment)
            ? []
            : {};
      target = target[key];
    });
  });
  return nextData;
}

function loadHomePage(wxMock = {}, cases = [], options = {}) {
  let pageConfig;
  let activePageLoadingToken = null;
  const NativeDate = Date;
  let nowMs = Object.prototype.hasOwnProperty.call(options, "nowMs")
    ? Number(options.nowMs)
    : NativeDate.now();
  class ControlledDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }

    static now() {
      return nowMs;
    }
  }
  const clock = {
    advance(deltaMs) {
      nowMs += Number(deltaMs);
      return nowMs;
    },
    set(nextNowMs) {
      nowMs = Number(nextNowMs);
      return nowMs;
    },
  };
  const app = {
    globalData: {},
  };
  const calls = {
    attachCaseImageUrls: [],
    clearCache: [],
    fetchHomeFeed: [],
    fetchVisibleBanners: [],
    fetchVisibleCases: [],
    clientFaults: [],
    performanceEvents: [],
    pageLoading: [],
    requiredModules: [],
    reportEvents: [],
    setData: [],
    stopPullDownRefresh: 0,
    touchCache: [],
    writeCache: [],
  };
  const cachedHome = Object.prototype.hasOwnProperty.call(options, "cache")
    ? options.cache
    : null;
  const catalogCache = {
    CACHE_TTL_MS,
    HOME_CACHE_KEY: "wineHomeFeedV3",
    readCache: () => cachedHome,
    clearCache(key) {
      calls.clearCache.push(key);
      if (options.clearCache) return options.clearCache(key);
      return true;
    },
    writeCache(key, revision, data) {
      calls.writeCache.push({ key, revision, data });
      if (options.writeCache) return options.writeCache(key, revision, data);
      return undefined;
    },
  };
  if (options.touchCache) {
    catalogCache.touchCache = (key, revision) => {
      calls.touchCache.push({ key, revision });
      return options.touchCache(key, revision);
    };
  }

  const sandbox = {
    Page(config) {
      pageConfig = config;
    },
    getApp() {
      return app;
    },
    require(moduleName) {
      calls.requiredModules.push(moduleName);
      if (moduleName === "../../utils/cloudData") {
        return {
          attachCaseImageUrls: async (items, requestOptions) => {
            calls.attachCaseImageUrls.push({ items, options: requestOptions });
            if (options.attachCaseImageUrls) {
              return options.attachCaseImageUrls(items, requestOptions);
            }
            return items.map((item) => ({
              ...item,
              coverImageUrl: `${item.coverImage || item.coverImageUrl || item.id}?temp=1`,
            }));
          },
          fetchVisibleCases: async (requestOptions) => {
            calls.fetchVisibleCases.push(requestOptions);
            if (options.fetchVisibleCases) {
              return options.fetchVisibleCases(requestOptions);
            }
            return cases;
          },
          fetchVisibleBanners: async (items, requestOptions) => {
            calls.fetchVisibleBanners.push({ items, options: requestOptions });
            if (options.fetchVisibleBanners) {
              return options.fetchVisibleBanners(items, requestOptions);
            }
            return [];
          },
        };
      }
      if (moduleName === "../../utils/caseCatalogService") {
        return {
          fetchHomeFeed: async (requestOptions) => {
            calls.fetchHomeFeed.push(requestOptions);
            if (options.fetchHomeFeed) {
              return options.fetchHomeFeed(requestOptions);
            }
            throw Object.assign(new Error("unknown action"), {
              code: "UNKNOWN_ACTION",
            });
          },
          isLegacyCatalogFallbackAllowed(error) {
            if (options.isLegacyCatalogFallbackAllowed) {
              return options.isLegacyCatalogFallbackAllowed(error);
            }
            return error && ["-501000", "FUNCTION_NOT_FOUND", "UNKNOWN_ACTION"]
              .includes(String(error.code || "").toUpperCase());
          },
        };
      }
      if (moduleName === "../../utils/catalogCache") {
        return catalogCache;
      }
      if (moduleName === "../../utils/caseRefresh") {
        return {
          getCaseDataVersion: () => options.caseDataVersion || 1,
          shouldRefreshCaseData: (...args) =>
            options.shouldRefreshCaseData
              ? options.shouldRefreshCaseData(...args)
              : false,
        };
      }
      if (moduleName === "../../utils/nativePageLoading") {
        return {
          beginPageLoading(request) {
            const token = `home-loading-${calls.pageLoading.length + 1}`;
            activePageLoadingToken = token;
            calls.pageLoading.push({ type: "begin", request, token });
            return token;
          },
          finishPageLoading(token) {
            if (activePageLoadingToken !== token) return false;
            activePageLoadingToken = null;
            calls.pageLoading.push({ type: "finish", token });
            return true;
          },
          cancelPageLoading(token) {
            if (activePageLoadingToken !== token) return false;
            activePageLoadingToken = null;
            calls.pageLoading.push({ type: "cancel", token });
            return true;
          },
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
      if (moduleName === "../../utils/errorTelemetry") {
        return {
          reportClientFault(payload) {
            calls.clientFaults.push(payload);
            if (options.reportClientFault) {
              return options.reportClientFault(payload);
            }
            return true;
          },
          reportPerformanceEvent(name, payload) {
            calls.performanceEvents.push({ name, payload });
            if (options.reportPerformanceEvent) {
              return options.reportPerformanceEvent(name, payload);
            }
            return true;
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    clearTimeout: options.clearTimeout || clearTimeout,
    Date: ControlledDate,
    setTimeout: options.setTimeout || setTimeout,
    wx: {
      navigateTo() {},
      nextTick(callback) {
        callback();
      },
      reportEvent(name, payload) {
        calls.reportEvents.push({ name, payload });
      },
      setStorageSync() {},
      stopPullDownRefresh() {
        calls.stopPullDownRefresh += 1;
      },
      switchTab() {},
      ...wxMock,
    },
  };

  vm.runInNewContext(readFileSync(pagePath, "utf8"), sandbox, {
    filename: pagePath,
  });
  pageConfig.setData = function setData(nextData, callback) {
    calls.setData.push(nextData);
    this.data = applySetDataPatch(this.data, nextData);
    if (typeof callback === "function") callback();
  };
  return {
    app,
    calls,
    clock,
    page: pageConfig,
  };
}

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
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

function buildHomeFeed() {
  return {
    banners: Array.from({ length: 5 }, (_, index) => ({
      id: `banner_${index + 1}`,
      caseId: `case_${index + 1}`,
      title: `banner_${index + 1}`,
      imageUrl: `https://example.com/banner-${index + 1}.jpg`,
      internalOnly: `banner-secret-${index + 1}`,
    })),
    popularCases: [
      buildCase(1, {
        coverImageUrl: "https://example.com/popular-1.jpg",
        styles: ["国风"],
        priceLevel: "中端",
        internalOnly: "popular-secret",
      }),
    ],
    latestCases: [
      buildCase(2, {
        coverImageUrl: "https://example.com/latest-2.jpg",
        styles: ["简约"],
        priceLevel: "高端",
        internalOnly: "latest-secret",
      }),
    ],
  };
}

await test("home sections expose more links for popular and latest products", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const wxss = readFileSync(wxssPath, "utf8");

  assert.equal((wxml.match(/class="section-more"/g) || []).length, 2);
  assert.equal(wxml.includes("&gt;"), false);
  assert.equal(wxml.includes("查看更多 >"), true);
  assert.equal(wxml.includes('data-sort="popular"'), true);
  assert.equal(wxml.includes('data-sort="latest"'), true);
  assert.equal(wxml.includes('bindtap="navigateToCategory"'), true);
  assert.equal((wxml.match(/class="product-image"\s+mode="aspectFill"/g) || []).length, 2);
  assert.equal(wxml.includes("已展示首页全部案例"), true);
  assert.equal(wxml.includes("请前往分类页查看更多 >"), true);
  assert.equal(wxml.includes('hover-class="home-end-note-active"'), true);
  assert.match(
    wxml,
    /wx:if="\{\{!timelinePreview && \(popularCases\.length \|\| latestCases\.length\)\}\}"/
  );
  assert.match(wxml, /class="home-end-note"[\s\S]*?bindtap="navigateToCategory"/);
  assert.match(wxml, /class="home-end-note"[\s\S]*?data-sort=""/);
  assert.match(wxss, /\.home-end-note\s*\{/);
  assert.match(wxss, /\.home-end-title\s*\{/);
  assert.match(wxss, /\.home-end-link\s*\{/);
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
  assert.match(foregroundTag, /wx:if="{{item\.renderImageUrl}}"/);
  assert.match(foregroundTag, /src="{{item\.renderImageUrl}}"/);
  assert.match(foregroundTag, /bindload="onBannerImageLoad"/);
  assert.match(foregroundTag, /binderror="onBannerImageError"/);
  assert.match(foregroundTag, /data-index="{{bannerIndex}}"/);
  assert.match(foregroundTag, /data-banner-id="{{item\.id}}"/);
  assert.match(foregroundTag, /data-url="{{item\.renderImageUrl}}"/);
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
  assert.match(titleTag, /item\.title/);
  assert.match(titleTag, /item\.imageLoadState != 'failed'/);
  assert.match(titleTag, /bannerIndex == activeBannerIndex/);
  assert.match(bannerCardTag, /bindtap="onBannerTap"/);
  assert.match(bannerCardTag, /data-id="{{item\.caseId}}"/);
});

await test("home entry loading waits for the active banner after content commits", async () => {
  const feed = buildHomeFeed();
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => ({
      revision: 12,
      notModified: false,
      ...feed,
    }),
  });

  page.onLoad();

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.pageLoading[0])),
    {
      type: "begin",
      request: {
        owner: "home-entry",
        title: "加载中",
        delayMs: 120,
        minVisibleMs: 300,
        maxVisibleMs: 3000,
        mask: false,
      },
      token: "home-loading-1",
    }
  );

  await page._loadPromise;
  assert.equal(calls.pageLoading.some((event) => event.type === "finish"), false);

  assert.equal(page.onBannerImageError({
    currentTarget: {
      dataset: {
        index: 1,
        bannerId: "stale-banner",
        url: "https://example.com/stale-banner.jpg",
        mediaEpoch: page.data.banners[1].mediaEpoch,
      },
    },
  }), false);
  assert.equal(calls.pageLoading.some((event) => event.type === "finish"), false);

  page.onBannerImageLoad({
    currentTarget: { dataset: { index: 0 } },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.pageLoading.filter((event) => event.type === "finish"))),
    [{ type: "finish", token: "home-loading-1" }]
  );
  assert.equal(
    calls.performanceEvents.filter((event) => event.name === "client_boot_result").length,
    1
  );

  page.onUnload();
  assert.equal(calls.pageLoading.some((event) => event.type === "cancel"), false);
});

await test("home entry loading remembers a settled adjacent banner before activation", async () => {
  const feed = buildHomeFeed();
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => ({
      revision: 15,
      notModified: false,
      ...feed,
    }),
  });

  page.onLoad();
  await page._loadPromise;
  page.onBannerImageLoad({
    currentTarget: { dataset: { index: 1 } },
  });
  assert.equal(calls.pageLoading.some((event) => event.type === "finish"), false);

  page.onBannerChange({ detail: { current: 1 } });
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.pageLoading.filter((event) => event.type === "finish"))),
    [{ type: "finish", token: "home-loading-1" }]
  );
  page.onUnload();
});

await test("a stale banner event at the same index cannot settle a replacement image", async () => {
  const feed = buildHomeFeed();
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => ({
      revision: 16,
      notModified: false,
      ...feed,
    }),
  });

  page.onLoad();
  await page._loadPromise;
  const oldBanner = page.data.banners[0];
  const replacement = {
    ...oldBanner,
    id: "banner_replacement",
    imageUrl: "https://example.com/banner-replacement.jpg",
    renderImageUrl: "https://example.com/banner-replacement.jpg",
  };
  page.setData({
    banners: [replacement, ...page.data.banners.slice(1)],
  });

  assert.equal(page.onBannerImageLoad({
    currentTarget: {
      dataset: {
        index: 0,
        bannerId: oldBanner.id,
        url: oldBanner.renderImageUrl,
      },
    },
  }), false);
  assert.equal(calls.pageLoading.some((event) => event.type === "finish"), false);

  page.onBannerImageLoad({
    currentTarget: {
      dataset: {
        index: 0,
        bannerId: replacement.id,
        url: replacement.renderImageUrl,
      },
    },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.pageLoading.filter((event) => event.type === "finish"))),
    [{ type: "finish", token: "home-loading-1" }]
  );
  page.onUnload();
});

await test("home entry loading closes without waiting for card images when no banner exists", async () => {
  const feed = {
    ...buildHomeFeed(),
    banners: [],
  };
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => ({
      revision: 13,
      notModified: false,
      ...feed,
    }),
  });

  page.onLoad();
  await page._loadPromise;

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.pageLoading.filter((event) => event.type === "finish"))),
    [{ type: "finish", token: "home-loading-1" }]
  );
  assert.equal(page.data.popularCases.length > 0, true);
  assert.equal(page.data.latestCases.length > 0, true);
  assert.equal(
    calls.performanceEvents.filter((event) => event.name === "client_boot_result").length,
    1
  );
  page.onUnload();
});

await test("an active banner error renews image URLs before entry loading settles", async () => {
  const feed = buildHomeFeed();
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => ({
      revision: 14,
      notModified: false,
      ...feed,
    }),
  });

  page.onLoad();
  await page._loadPromise;
  const failedBanner = page.data.banners[0];
  const recovery = page.onBannerImageError({
    currentTarget: {
      dataset: {
        index: 0,
        bannerId: failedBanner.id,
        url: failedBanner.renderImageUrl,
        mediaEpoch: failedBanner.mediaEpoch,
      },
    },
  });

  assert.equal(calls.pageLoading.some((event) => event.type === "finish"), false);
  await recovery;
  assert.equal(calls.fetchHomeFeed.length, 2);
  const renewedBanner = page.data.banners[0];
  page.onBannerImageLoad({
    currentTarget: {
      dataset: {
        index: 0,
        bannerId: renewedBanner.id,
        url: renewedBanner.renderImageUrl,
        mediaEpoch: renewedBanner.mediaEpoch,
      },
    },
  });
  assert.equal(calls.pageLoading.some((event) => event.type === "finish"), true);
  assert.equal(
    calls.performanceEvents.filter((event) => event.name === "client_boot_result").length,
    1
  );
  page.onUnload();
});

await test("hiding home cancels only its unfinished entry loading", () => {
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: () => new Promise(() => {}),
  });

  page.onLoad();
  page.onHide();
  page.onUnload();

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.pageLoading.filter((event) => event.type === "cancel"))),
    [{ type: "cancel", token: "home-loading-1" }]
  );
  assert.equal(calls.pageLoading.some((event) => event.type === "finish"), false);
});

await test("home carousel tracks the active banner for its title state", () => {
  const { page } = loadHomePage();
  page.applyHomeFeed({
    banners: Array.from({ length: 5 }, (_, index) => ({
      caseId: `case_${index}`,
      imageUrl: `https://example.com/${index}.jpg`,
    })),
  });

  assert.equal(page.data.activeBannerIndex, 0);
  assert.deepEqual(
    page.data.banners.map((item) => Boolean(item.renderImageUrl)),
    [true, true, false, false, true]
  );
  page.onBannerChange({
    detail: {
      current: 2,
    },
  });
  assert.equal(page.data.activeBannerIndex, 2);
  assert.deepEqual(
    page.data.banners.map((item) => Boolean(item.renderImageUrl)),
    [false, true, true, true, false]
  );

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

await test("home page can be shared to friends and timeline", () => {
  const { page } = loadHomePage();

  assert.deepEqual(
    JSON.parse(JSON.stringify(page.onShareAppMessage())),
    {
      title: "金亿诚包装科技｜酒包装灵感库",
      path: "/pages/index/index",
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(page.onShareTimeline())),
    {
      title: "金亿诚包装科技｜酒包装灵感库",
    }
  );
});

await test("home page uses a softer fallback in timeline single page mode", async () => {
  const { calls, page } = loadHomePage({
    getLaunchOptionsSync() {
      return { scene: 1154 };
    },
  });

  page.onLoad();
  page.onReady();
  await page.onShow();
  await page.onPullDownRefresh();
  await flushTasks();

  assert.equal(page.data.timelinePreview, true);
  assert.equal(
    page.data.errorMessage,
    "朋友圈预览暂时不能读取完整案例，请点击右下角“前往小程序”查看。"
  );
  assert.equal(calls.fetchHomeFeed.length, 0);
  assert.equal(calls.fetchVisibleCases.length, 0);
  assert.equal(calls.fetchVisibleBanners.length, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.pageLoading.filter((event) => event.type === "finish"))),
    [{ type: "finish", token: "home-loading-1" }]
  );
  assert.equal(
    calls.requiredModules.includes("../../utils/caseCatalogService"),
    false
  );
  assert.equal(calls.requiredModules.includes("../../utils/cloudData"), false);
});

await test("cached home without an image URL timestamp hydrates locally and requests a full feed", async () => {
  const nowMs = 10_000_000;
  const cachedFeed = buildHomeFeed();
  const refreshedFeed = buildHomeFeed();
  refreshedFeed.banners = refreshedFeed.banners.map((banner) => ({
    ...banner,
    imageUrl: `${banner.imageUrl}?renewed=1`,
  }));
  let resolveCatalog;
  const catalogResult = new Promise((resolve) => {
    resolveCatalog = resolve;
  });
  const { calls, page } = loadHomePage({}, [], {
    cache: {
      revision: 17,
      cachedAt: nowMs - 1000,
      fresh: true,
      data: cachedFeed,
    },
    fetchHomeFeed: () => catalogResult,
    nowMs,
  });

  page.onLoad();

  assert.equal(calls.setData.length, 1);
  assert.equal("popularCases" in calls.setData[0], false);
  assert.equal("latestCases" in calls.setData[0], false);
  assert.equal(page.data.banners.length, 1);
  assert.equal(page.data.banners[0].renderImageUrl, cachedFeed.banners[0].imageUrl);
  assert.equal(page.data.popularCases.length, 0);
  assert.equal(page.data.latestCases.length, 0);
  assert.equal(page.data.homeContentReady, false);
  assert.equal(calls.fetchHomeFeed.length, 0);
  assert.equal(
    calls.requiredModules.includes("../../utils/caseCatalogService"),
    false
  );
  assert.equal(
    calls.performanceEvents.filter((event) => event.name === "client_boot_result").length,
    0
  );
  assert.equal(
    calls.setData.some((entry) => entry.timelinePreview === false),
    false
  );
  assert.equal(calls.pageLoading.some((event) => event.type === "finish"), false);

  page.onBannerImageLoad({
    currentTarget: { dataset: { index: 0 } },
  });
  assert.equal(
    calls.performanceEvents.filter((event) => event.name === "client_boot_result").length,
    0
  );
  assert.equal(calls.pageLoading.some((event) => event.type === "finish"), false);

  await page.onShow();
  assert.equal(calls.fetchHomeFeed.length, 0);
  assert.equal(
    calls.requiredModules.includes("../../utils/caseCatalogService"),
    false
  );

  page.onReady();
  assert.equal(page.data.homeContentReady, true);
  assert.equal(page.data.banners.length, 5);
  assert.equal(page.data.popularCases.length, 1);
  assert.equal(page.data.latestCases.length, 1);
  assert.equal("internalOnly" in page.data.popularCases[0], false);
  assert.equal("homeSections" in page.data.popularCases[0], false);

  await Promise.resolve();
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.fetchHomeFeed)),
    [{}]
  );
  const setDataCountBeforeFullFeed = calls.setData.length;
  resolveCatalog({
    revision: 18,
    notModified: false,
    ...refreshedFeed,
  });
  const result = await page._loadPromise;

  assert.equal(result.notModified, false);
  assert.equal(calls.setData.length > setDataCountBeforeFullFeed, true);
  assert.equal(page.data.catalogRevision, 18);
  assert.equal(
    page.data.banners[0].renderImageUrl,
    refreshedFeed.banners[0].imageUrl
  );
  assert.equal(page._homeCache.data.imageUrlsFetchedAt, nowMs);
  page.onBannerImageLoad({
    currentTarget: {
      dataset: {
        index: 0,
        bannerId: page.data.banners[0].id,
        url: page.data.banners[0].renderImageUrl,
        mediaEpoch: page.data.banners[0].mediaEpoch,
      },
    },
  });
  assert.equal(calls.pageLoading.some((event) => event.type === "finish"), true);
  assert.equal(calls.writeCache.length, 0);
  await flushTasks();
  assert.equal(calls.writeCache.length, 1);
  assert.equal(calls.writeCache[0].revision, 18);
  assert.equal(calls.writeCache[0].data.imageUrlsFetchedAt, nowMs);
  assert.equal(
    calls.performanceEvents.filter((event) => event.name === "client_boot_result").length,
    1
  );
  page.onUnload();
});

await test("fresh cached image URLs may revalidate by revision without renewing their timestamp", async () => {
  const nowMs = 20_000_000;
  const imageUrlsFetchedAt = nowMs - 60 * 1000;
  const feed = {
    ...buildHomeFeed(),
    imageUrlsFetchedAt,
  };
  let resolveCatalog;
  const catalogResult = new Promise((resolve) => {
    resolveCatalog = resolve;
  });
  const { calls, page } = loadHomePage({}, [], {
    cache: {
      revision: 19,
      cachedAt: nowMs - 1000,
      fresh: true,
      data: feed,
    },
    fetchHomeFeed: () => catalogResult,
    nowMs,
    touchCache: () => true,
  });

  page.onLoad();
  page.onReady();
  await Promise.resolve();

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.fetchHomeFeed)),
    [{ knownRevision: 19 }]
  );
  const setDataCountBeforeNotModified = calls.setData.length;
  resolveCatalog({ revision: 19, notModified: true });
  const result = await page._loadPromise;

  assert.equal(result.notModified, true);
  assert.equal(calls.setData.length, setDataCountBeforeNotModified);
  assert.equal(page._homeCache.cachedAt, nowMs);
  assert.equal(
    page._homeCache.data.imageUrlsFetchedAt,
    imageUrlsFetchedAt
  );
  await flushTasks();
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.touchCache)),
    [{ key: "wineHomeFeedV3", revision: 19 }]
  );
  assert.equal(calls.writeCache.length, 0);
  page.onUnload();
});

await test("returning to home before cached image URLs expire does not request again", async () => {
  const nowMs = 30_000_000;
  const feed = buildHomeFeed();
  const { calls, clock, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => ({
      revision: 20,
      notModified: false,
      ...feed,
    }),
    nowMs,
  });

  page.onLoad();
  page.onReady();
  await page._loadPromise;
  page.onBannerImageLoad({
    currentTarget: {
      dataset: {
        index: 0,
        bannerId: page.data.banners[0].id,
        url: page.data.banners[0].renderImageUrl,
      },
    },
  });
  page.onHide();
  clock.advance(CACHE_TTL_MS - 1);

  const result = await page.onShow();

  assert.equal(result.skipped, true);
  assert.equal(calls.fetchHomeFeed.length, 1);
  assert.equal(page._homeCache.data.imageUrlsFetchedAt, nowMs);
  page.onUnload();
});

await test("returning to home after image URL expiry performs exactly one full refresh", async () => {
  const nowMs = 40_000_000;
  const initialFeed = buildHomeFeed();
  const refreshedFeed = buildHomeFeed();
  refreshedFeed.banners = refreshedFeed.banners.map((banner) => ({
    ...banner,
    imageUrl: `${banner.imageUrl}?resumed=1`,
  }));
  let requestCount = 0;
  const { calls, clock, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => {
      requestCount += 1;
      return requestCount === 1
        ? {
          revision: 20,
          notModified: false,
          ...initialFeed,
        }
        : {
          revision: 21,
          notModified: false,
          ...refreshedFeed,
        };
    },
    nowMs,
  });

  page.onLoad();
  page.onReady();
  await page._loadPromise;
  await flushTasks();
  page.onBannerImageLoad({
    currentTarget: {
      dataset: {
        index: 0,
        bannerId: page.data.banners[0].id,
        url: page.data.banners[0].renderImageUrl,
      },
    },
  });
  page.onHide();
  clock.advance(CACHE_TTL_MS);

  const refreshResult = await page.onShow();

  assert.equal(refreshResult.ok, true);
  assert.equal(refreshResult.notModified, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.fetchHomeFeed)),
    [{}, {}]
  );
  assert.equal(page.data.catalogRevision, 21);
  assert.equal(
    page.data.banners[0].renderImageUrl,
    refreshedFeed.banners[0].imageUrl
  );
  assert.equal(
    page._homeCache.data.imageUrlsFetchedAt,
    nowMs + CACHE_TTL_MS
  );

  page.onHide();
  const immediateReturnResult = await page.onShow();
  assert.equal(immediateReturnResult.skipped, true);
  assert.equal(calls.fetchHomeFeed.length, 2);
  page.onUnload();
});

await test("timeline scene with cache hydrates locally and never contacts cloud", async () => {
  const nowMs = 50_000_000;
  const feed = buildHomeFeed();
  const { calls, clock, page } = loadHomePage({
    getEnterOptionsSync() {
      return { scene: 1154 };
    },
  }, [], {
    cache: {
      revision: 21,
      cachedAt: nowMs,
      fresh: true,
      data: {
        ...feed,
        imageUrlsFetchedAt: nowMs,
      },
    },
    fetchHomeFeed: async () => {
      throw new Error("timeline mode must not request catalog");
    },
    nowMs,
  });

  page.onLoad();
  assert.equal(page.data.timelinePreview, true);
  assert.equal(page.data.banners.length, 1);
  page.onBannerImageError({
    currentTarget: { dataset: { index: 0 } },
  });
  page.onReady();
  clock.advance(CACHE_TTL_MS);
  await page.onShow();
  await page.onPullDownRefresh();
  await flushTasks();

  assert.equal(page.data.homeContentReady, true);
  assert.equal(page.data.banners.length, 5);
  assert.equal(calls.fetchHomeFeed.length, 0);
  assert.equal(calls.fetchVisibleCases.length, 0);
  assert.equal(calls.fetchVisibleBanners.length, 0);
  assert.equal(
    calls.requiredModules.includes("../../utils/caseCatalogService"),
    false
  );
  assert.equal(calls.requiredModules.includes("../../utils/cloudData"), false);
  assert.equal(calls.stopPullDownRefresh, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.pageLoading.filter((event) => event.type === "finish"))),
    [{ type: "finish", token: "home-loading-1" }]
  );
  page.onUnload();
});

await test("home entry loading closes when the uncached request fails", async () => {
  const { calls, page } = loadHomePage({}, [], {
    isLegacyCatalogFallbackAllowed: () => false,
    fetchHomeFeed: async () => {
      throw new Error("catalog unavailable");
    },
  });

  page.onLoad();
  const result = await page._loadPromise;

  assert.equal(result.status, "error");
  assert.match(page.data.errorMessage, /暂时读取不到案例数据/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.pageLoading.filter((event) => event.type === "finish"))),
    [{ type: "finish", token: "home-loading-1" }]
  );
  page.onUnload();
});

await test("uncached home requests only after the shell commit and writes cache after render", async () => {
  const feed = buildHomeFeed();
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => ({
      revision: 30,
      notModified: false,
      ...feed,
    }),
  });

  page.onLoad();

  assert.equal(calls.setData.length, 1);
  assert.equal("banners" in calls.setData[0], false);
  assert.equal("popularCases" in calls.setData[0], false);
  assert.equal("latestCases" in calls.setData[0], false);
  assert.equal(calls.fetchHomeFeed.length, 0);
  assert.equal(page.data.loading, true);
  assert.equal(page.data.homeContentReady, false);
  assert.equal(
    calls.setData.some((entry) => entry.timelinePreview === false),
    false
  );
  page.onReady();

  const result = await page._loadPromise;
  assert.equal(result.ok, true);
  assert.equal(result.status, "success");
  assert.equal(calls.fetchHomeFeed.length, 1);
  assert.equal(page.data.homeContentReady, true);
  assert.equal(calls.writeCache.length, 0);
  assert.equal(
    calls.performanceEvents.filter((event) => event.name === "client_boot_result").length,
    0
  );

  page.onBannerImageLoad({
    currentTarget: { dataset: { index: 1 } },
  });
  assert.equal(
    calls.performanceEvents.filter((event) => event.name === "client_boot_result").length,
    0
  );
  page.onBannerImageLoad({
    currentTarget: { dataset: { index: 0 } },
  });
  page.onBannerImageLoad({
    currentTarget: { dataset: { index: 0 } },
  });
  assert.equal(
    calls.performanceEvents.filter((event) => event.name === "client_boot_result").length,
    1
  );
  const bootEvent = calls.performanceEvents.find(
    (event) => event.name === "client_boot_result"
  );
  const durationBuckets = new Set([
    "under_500ms",
    "500_999ms",
    "1000_1999ms",
    "2000_4999ms",
    "5000ms_plus",
    "pending",
    "not_applicable",
    "unknown",
  ]);
  for (const key of [
    "duration_bucket",
    "shell_bucket",
    "on_ready_bucket",
    "hero_bucket",
    "data_bucket",
  ]) {
    assert.equal(durationBuckets.has(bootEvent.payload[key]), true, key);
  }
  assert.notEqual(bootEvent.payload.shell_bucket, "pending");
  assert.notEqual(bootEvent.payload.on_ready_bucket, "pending");
  assert.notEqual(bootEvent.payload.hero_bucket, "pending");
  assert.notEqual(bootEvent.payload.data_bucket, "pending");

  await flushTasks();
  assert.equal(calls.writeCache.length, 1);
  assert.equal(calls.writeCache[0].revision, 30);
  page.onUnload();
});

await test("home preserves revision zero in cache and never sends it as knownRevision", async () => {
  const feed = {
    ...buildHomeFeed(),
    banners: [],
  };
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => ({
      revision: 0,
      notModified: false,
      ...feed,
    }),
  });

  page.onLoad();
  const firstResult = await page._loadPromise;
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.status, "success");
  assert.equal(page.data.catalogRevision, 0);
  assert.equal(page.data.homeContentReady, true);
  assert.equal("knownRevision" in calls.fetchHomeFeed[0], false);
  assert.equal(
    calls.performanceEvents.filter((event) => event.name === "client_boot_result").length,
    1
  );

  await page.loadData({ silent: true });
  await flushTasks();
  assert.equal("knownRevision" in calls.fetchHomeFeed[1], false);
  assert.equal(calls.writeCache.length, 1);
  assert.deepEqual(calls.writeCache.map((entry) => entry.revision), [0]);
  assert.deepEqual(calls.clearCache, []);
  page.onUnload();
});

await test("notModified without a cache resolves with a contract error", async () => {
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => ({
      revision: 9,
      notModified: true,
    }),
  });

  const result = await page.loadData();

  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "CATALOG_NOT_MODIFIED_WITHOUT_CACHE");
  assert.equal(calls.fetchVisibleCases.length, 0);
  assert.match(page.data.errorMessage, /暂时读取不到案例数据/);
});

await test("cached home without a banner reports boot only after full content commits", async () => {
  const feed = {
    ...buildHomeFeed(),
    banners: [],
  };
  const { calls, page } = loadHomePage({}, [], {
    cache: {
      revision: 22,
      cachedAt: Date.now(),
      fresh: true,
      data: feed,
    },
    fetchHomeFeed: async () => ({ revision: 22, notModified: true }),
  });

  page.onLoad();
  assert.equal(
    calls.performanceEvents.filter((event) => event.name === "client_boot_result").length,
    0
  );
  page.onReady();
  assert.equal(page.data.homeContentReady, true);
  assert.equal(
    calls.performanceEvents.filter((event) => event.name === "client_boot_result").length,
    1
  );
  await page._loadPromise;
  page.onUnload();
});

await test("unloaded home ignores late responses and loadData never rejects", async () => {
  const feed = buildHomeFeed();
  let resolveCatalog;
  const catalogResult = new Promise((resolve) => {
    resolveCatalog = resolve;
  });
  const pending = loadHomePage({}, [], {
    fetchHomeFeed: () => catalogResult,
  });

  pending.page.onLoad();
  const loadPromise = pending.page._loadPromise;
  await Promise.resolve();
  assert.equal(pending.calls.fetchHomeFeed.length, 1);
  const setDataCountAtUnload = pending.calls.setData.length;
  pending.page.onUnload();
  resolveCatalog({ revision: 31, notModified: false, ...feed });

  const cancelled = await loadPromise;
  await flushTasks();
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.status, "stale");
  assert.equal(pending.calls.setData.length, setDataCountAtUnload);
  assert.equal(pending.calls.writeCache.length, 0);

  const failed = loadHomePage({}, [], {
    fetchHomeFeed: async () => {
      throw new Error("catalog failed");
    },
    fetchVisibleCases: async () => {
      throw new Error("fallback failed");
    },
  });
  const failureResult = await failed.page.loadData();
  assert.equal(failureResult.ok, false);
  assert.equal(failureResult.status, "error");
  assert.equal(failed.calls.fetchVisibleCases.length, 0);
  assert.equal(failed.calls.clientFaults.length, 1);
  assert.equal(failed.calls.clientFaults[0].stage, "load_final");
  assert.match(failed.page.data.errorMessage, /暂时读取不到案例数据/);
});

await test("home load promise deduplicates reads and a forced request supersedes older work", async () => {
  const feed = buildHomeFeed();
  const resolvers = [];
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: () => new Promise((resolve) => {
      resolvers.push(resolve);
    }),
  });

  const first = page.loadData({ silent: true });
  const deduplicated = page.loadData({ silent: true });
  assert.equal(first, deduplicated);
  await Promise.resolve();
  assert.equal(calls.fetchHomeFeed.length, 1);

  const forced = page.loadData({ silent: true, forceRefresh: true });
  await Promise.resolve();
  assert.equal(calls.fetchHomeFeed.length, 2);

  resolvers[0]({ revision: 40, notModified: false, ...feed });
  const staleResult = await first;
  assert.equal(staleResult.cancelled, true);
  assert.equal(staleResult.status, "stale");

  resolvers[1]({ revision: 41, notModified: false, ...feed });
  const latestResult = await forced;
  assert.equal(latestResult.ok, true);
  assert.equal(latestResult.status, "success");
  assert.equal(page.data.catalogRevision, 41);
  await flushTasks();
  assert.deepEqual(calls.writeCache.map((entry) => entry.revision), [41]);
});

await test("client boot timeout reports exactly once after five seconds", async () => {
  const timers = new Map();
  let timerId = 0;
  const { calls, page } = loadHomePage({}, [], {
    clearTimeout(id) {
      timers.delete(id);
    },
    fetchHomeFeed: () => new Promise(() => {}),
    setTimeout(callback, delay) {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
  });

  page.onLoad();
  await Promise.resolve();
  const bootTimer = [...timers.values()].find((timer) => timer.delay === 5000);
  assert.ok(bootTimer);
  bootTimer.callback();
  page.reportClientBoot("success", "late_network");

  const bootEvents = calls.performanceEvents.filter(
    (event) => event.name === "client_boot_result"
  );
  assert.equal(bootEvents.length, 1);
  assert.equal(bootEvents[0].payload.stage, "timeout");
  assert.equal(bootEvents[0].payload.shell_bucket, "under_500ms");
  assert.equal(bootEvents[0].payload.on_ready_bucket, "pending");
  assert.equal(bootEvents[0].payload.hero_bucket, "pending");
  assert.equal(bootEvents[0].payload.data_bucket, "pending");
  page.onUnload();
});

await test("home reports an allowed catalog fallback before the legacy read succeeds", async () => {
  const cases = [
    buildCase(1, { homeSections: ["popular", "latest"] }),
  ];
  const { calls, page } = loadHomePage({}, cases);

  const result = await page.loadData();

  assert.equal(result.status, "success");
  assert.equal(calls.fetchVisibleCases.length, 1);
  assert.equal(calls.clientFaults.length, 1);
  assert.equal(calls.clientFaults[0].stage, "catalog_fallback");
  assert.equal(calls.clientFaults[0].action, "getHomeFeed");
  assert.equal(calls.clientFaults[0].fallbackUsed, true);
});

await test("forced legacy home refresh also renews banner and case image URLs", async () => {
  const cases = [
    buildCase(1, { homeSections: ["popular", "latest"] }),
  ];
  const { calls, page } = loadHomePage({}, cases);

  const result = await page.loadData({ silent: true, forceRefresh: true });

  assert.equal(result.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.fetchVisibleCases)),
    [{ includeImageUrls: false, forceRefresh: true }]
  );
  assert.equal(calls.fetchVisibleBanners[0].options.forceRefresh, true);
  assert.equal(calls.attachCaseImageUrls[0].options.preferBanner, true);
  assert.equal(calls.attachCaseImageUrls[0].options.forceRefresh, true);
});

await test("home no-cache error exposes retry and retry can recover", async () => {
  let requestCount = 0;
  const feed = buildHomeFeed();
  const { calls, page } = loadHomePage({}, [], {
    isLegacyCatalogFallbackAllowed: () => false,
    fetchHomeFeed: async () => {
      requestCount += 1;
      if (requestCount === 1) throw new Error("catalog unavailable");
      return {
        revision: 51,
        notModified: false,
        ...feed,
      };
    },
  });

  const failed = await page.loadData();
  assert.equal(failed.status, "error");
  assert.match(page.data.errorMessage, /暂时读取不到案例数据/);
  assert.equal(page.data.loading, false);
  assert.equal(calls.clientFaults.length, 1);

  const recovered = await page.retryHomeData();
  assert.equal(recovered.status, "success");
  assert.equal(page.data.errorMessage, "");
  assert.equal(page.data.homeContentReady, true);
  assert.equal(calls.fetchHomeFeed.length, 2);

  const wxml = readFileSync(wxmlPath, "utf8");
  const wxss = readFileSync(wxssPath, "utf8");
  assert.match(wxml, /bindtap="retryHomeData"/);
  assert.match(wxml, /wx:if="{{!timelinePreview}}"/);
  assert.match(wxml, />重新加载<\/view>/);
  assert.match(wxss, /\.state-retry\s*\{/);
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
  assert.deepEqual(
    page.data.popularCases.map((item) => item.id),
    ["case_1", "case_2", "case_3", "case_4"]
  );
  assert.deepEqual(
    page.data.latestCases.map((item) => item.id),
    ["case_7", "case_6", "case_5", "case_4", "case_3", "case_2"]
  );
  assert.equal(page.data.popularCases.some((item) => "homeSections" in item), false);
  assert.equal(page.data.latestCases.some((item) => "homeSections" in item), false);
  assert.equal(page.data.popularCases.every((item) => item.caseId === item.id), true);
  assert.equal(page.data.latestCases.every((item) => item.caseId === item.id), true);
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

await test("home end note opens category without forcing a new sort", () => {
  let switchedUrl = "";
  let storedSort = "not-written";
  const { app, page } = loadHomePage({
    setStorageSync(key, value) {
      if (key === "pendingCategorySort") storedSort = value;
    },
    switchTab(options) {
      switchedUrl = options.url;
    },
  });

  page.navigateToCategory({
    currentTarget: { dataset: { sort: "" } },
  });

  assert.equal(switchedUrl, "/pages/category/index");
  assert.equal(app.globalData.pendingCategorySort, undefined);
  assert.equal(storedSort, "not-written");
});

await test("home contains storage and pull-down completion API failures", async () => {
  let switchedUrl = "";
  const { page } = loadHomePage({
    setStorageSync() {
      throw new Error("storage unavailable");
    },
    stopPullDownRefresh() {
      throw new Error("pull-down unavailable");
    },
    switchTab(options) {
      switchedUrl = options.url;
    },
  });

  assert.doesNotThrow(() => {
    page.navigateToCategory({
      currentTarget: { dataset: { sort: "latest" } },
    });
  });
  assert.equal(switchedUrl, "/pages/category/index");
  assert.equal(page.stopPullDownRefreshSafely(), false);
});

function buildVersionedHomeFeed(version) {
  const feed = buildHomeFeed();
  return {
    ...feed,
    banners: feed.banners.map((banner) => ({
      ...banner,
      imageUrl: `${banner.imageUrl}?media=${version}`,
    })),
    popularCases: feed.popularCases.map((item) => ({
      ...item,
      coverImageUrl: `${item.coverImageUrl}?media=${version}`,
    })),
    latestCases: feed.latestCases.map((item) => ({
      ...item,
      coverImageUrl: `${item.coverImageUrl}?media=${version}`,
    })),
  };
}

function bannerImageDataset(banner, index = 0) {
  return {
    index,
    bannerId: banner.id,
    url: banner.renderImageUrl,
    mediaEpoch: banner.mediaEpoch,
  };
}

function productImageDataset(card, section, index = 0) {
  return {
    section,
    index,
    caseId: card.id,
    url: card.coverImageUrl,
    mediaEpoch: card.mediaEpoch,
  };
}

function pageLoadingCount(calls, type) {
  return calls.pageLoading.filter((event) => event.type === type).length;
}

await test("home image markup wires epoch-aware recovery for banners and both product groups", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const bannerImageTag = wxml.match(
    /<image\b(?=[^>]*class="banner-image")[^>]*>/
  )?.[0] || "";
  const productImageTags = Array.from(
    wxml.matchAll(/<image\b(?=[^>]*class="product-image")[^>]*>/g),
    (match) => match[0]
  );

  assert.match(bannerImageTag, /binderror="onBannerImageError"/);
  assert.match(bannerImageTag, /data-media-epoch="{{item\.mediaEpoch}}"/);
  assert.equal(productImageTags.length, 2);
  productImageTags.forEach((tag) => {
    assert.match(tag, /binderror="onProductImageError"/);
    assert.match(tag, /data-index="{{productIndex}}"/);
    assert.match(tag, /data-case-id="{{item\.id}}"/);
    assert.match(tag, /data-url="{{item\.coverImageUrl}}"/);
    assert.match(tag, /data-media-epoch="{{item\.mediaEpoch}}"/);
  });
  assert.match(productImageTags[0], /data-section="popularCases"/);
  assert.match(productImageTags[1], /data-section="latestCases"/);
  assert.equal((wxml.match(/catchtap="retryHomeImages"/g) || []).length, 3);
  assert.equal(
    (wxml.match(/>\s*图片加载失败，点击重试\s*<\/view>/g) || []).length,
    3
  );
});

await test("old banner events with the same id and URL cannot settle a newer media epoch", async () => {
  const feed = buildVersionedHomeFeed("stable-url");
  let requestCount = 0;
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => ({
      revision: 70 + ++requestCount,
      notModified: false,
      ...feed,
    }),
  });

  page.onLoad();
  page.onReady();
  await page._loadPromise;
  const oldBanner = { ...page.data.banners[0] };
  page.onBannerImageLoad({
    currentTarget: { dataset: bannerImageDataset(oldBanner) },
  });

  const manualRefresh = page.retryHomeImages();
  const trackedRefresh = page._homeImageRecoveryPromise;
  assert.equal(manualRefresh, trackedRefresh);
  await trackedRefresh;

  const renewedBanner = page.data.banners[0];
  assert.equal(renewedBanner.id, oldBanner.id);
  assert.equal(renewedBanner.renderImageUrl, oldBanner.renderImageUrl);
  assert.notEqual(renewedBanner.mediaEpoch, oldBanner.mediaEpoch);
  const finishesBeforeOldEvents = pageLoadingCount(calls, "finish");

  assert.equal(page.onBannerImageLoad({
    currentTarget: { dataset: bannerImageDataset(oldBanner) },
  }), false);
  assert.equal(page.onBannerImageError({
    currentTarget: { dataset: bannerImageDataset(oldBanner) },
    detail: { errMsg: "stale image error" },
  }), false);
  assert.equal(pageLoadingCount(calls, "finish"), finishesBeforeOldEvents);
  assert.equal(calls.fetchHomeFeed.length, 2);
  assert.equal(page.data.banners[0].renderImageUrl, renewedBanner.renderImageUrl);
  assert.equal(page.data.banners[0].imageLoadState, "pending");

  page.onBannerImageLoad({
    currentTarget: { dataset: bannerImageDataset(renewedBanner) },
  });
  assert.equal(pageLoadingCount(calls, "finish"), finishesBeforeOldEvents + 1);
  page.onUnload();
});

await test("simultaneous banner and product errors share one refresh and one recovery loading", async () => {
  const initialFeed = buildVersionedHomeFeed("initial");
  const refreshedFeed = buildVersionedHomeFeed("recovered");
  let requestCount = 0;
  let resolveRecovery;
  const recoveryResult = new Promise((resolve) => {
    resolveRecovery = resolve;
  });
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve({
          revision: 80,
          notModified: false,
          ...initialFeed,
        });
      }
      return recoveryResult;
    },
  });

  page.onLoad();
  page.onReady();
  await page._loadPromise;
  const banner = { ...page.data.banners[0] };
  const product = { ...page.data.popularCases[0] };
  page.onBannerImageLoad({
    currentTarget: { dataset: bannerImageDataset(banner) },
  });
  const beginsBeforeErrors = pageLoadingCount(calls, "begin");

  const bannerRecovery = page.onBannerImageError({
    currentTarget: { dataset: bannerImageDataset(banner) },
    detail: { errMsg: "banner failed" },
  });
  const recoveryPromise = page._homeImageRecoveryPromise;
  const productRecovery = page.onProductImageError({
    currentTarget: {
      dataset: productImageDataset(product, "popularCases"),
    },
    detail: { errMsg: "product failed" },
  });

  assert.equal(bannerRecovery, recoveryPromise);
  assert.equal(productRecovery, recoveryPromise);
  assert.equal(pageLoadingCount(calls, "begin"), beginsBeforeErrors + 1);
  await Promise.resolve();
  assert.equal(calls.fetchHomeFeed.length, 2);

  resolveRecovery({
    revision: 81,
    notModified: false,
    ...refreshedFeed,
  });
  await recoveryPromise;

  assert.equal(calls.fetchHomeFeed.length, 2);
  assert.equal(pageLoadingCount(calls, "begin"), beginsBeforeErrors + 1);
  assert.equal(
    page.data.banners[0].renderImageUrl,
    refreshedFeed.banners[0].imageUrl
  );
  assert.equal(
    page.data.popularCases[0].coverImageUrl,
    refreshedFeed.popularCases[0].coverImageUrl
  );
  page.onUnload();
});

await test("a second automatic image failure waits for manual retry instead of issuing a third request", async () => {
  const feeds = [
    buildVersionedHomeFeed("first"),
    buildVersionedHomeFeed("automatic"),
    buildVersionedHomeFeed("manual"),
  ];
  let requestCount = 0;
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => ({
      revision: 90 + requestCount,
      notModified: false,
      ...feeds[requestCount++],
    }),
  });

  page.onLoad();
  page.onReady();
  await page._loadPromise;
  const firstBanner = { ...page.data.banners[0] };
  page.onBannerImageError({
    currentTarget: { dataset: bannerImageDataset(firstBanner) },
    detail: { errMsg: "expired first URL" },
  });
  const automaticRecovery = page._homeImageRecoveryPromise;
  await automaticRecovery;

  assert.equal(calls.fetchHomeFeed.length, 2);
  const automaticBanner = { ...page.data.banners[0] };
  const secondFailure = page.onBannerImageError({
    currentTarget: { dataset: bannerImageDataset(automaticBanner) },
    detail: { errMsg: "renewed URL also failed" },
  });
  await secondFailure;
  await flushTasks();

  assert.equal(calls.fetchHomeFeed.length, 2);
  assert.equal(page.data.banners[0].renderImageUrl, "");
  assert.equal(page.data.banners[0].imageLoadState, "failed");
  assert.equal(page._homeMediaState, "failed");
  assert.equal(page._homeImageRecoveryPromise, null);

  const manualRecovery = page.retryHomeImages();
  assert.equal(manualRecovery, page._homeImageRecoveryPromise);
  await manualRecovery;

  assert.equal(calls.fetchHomeFeed.length, 3);
  const manualBanner = page.data.banners[0];
  assert.equal(manualBanner.renderImageUrl, feeds[2].banners[0].imageUrl);
  assert.equal(manualBanner.imageLoadState, "pending");
  page.onBannerImageLoad({
    currentTarget: { dataset: bannerImageDataset(manualBanner) },
  });
  assert.equal(page._homeMediaState, "ready");
  page.onUnload();
});

await test("hidden image errors defer work and merge into one recovery when home becomes visible", async () => {
  const initialFeed = buildVersionedHomeFeed("before-hide");
  const refreshedFeed = buildVersionedHomeFeed("after-show");
  let requestCount = 0;
  let resolveRecovery;
  const recoveryResult = new Promise((resolve) => {
    resolveRecovery = resolve;
  });
  const { calls, page } = loadHomePage({}, [], {
    fetchHomeFeed: () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve({
          revision: 100,
          notModified: false,
          ...initialFeed,
        });
      }
      return recoveryResult;
    },
  });

  page.onLoad();
  page.onReady();
  await page._loadPromise;
  const hiddenBanner = { ...page.data.banners[0] };
  const hiddenProduct = { ...page.data.popularCases[0] };
  page.onBannerImageLoad({
    currentTarget: { dataset: bannerImageDataset(hiddenBanner) },
  });
  page.onHide();
  const beginsBeforeHiddenErrors = pageLoadingCount(calls, "begin");

  assert.equal(page.onBannerImageError({
    currentTarget: { dataset: bannerImageDataset(hiddenBanner) },
    detail: { errMsg: "late hidden banner error" },
  }), true);
  assert.equal(page.onProductImageError({
    currentTarget: {
      dataset: productImageDataset(hiddenProduct, "popularCases"),
    },
    detail: { errMsg: "late hidden product error" },
  }), true);
  assert.equal(calls.fetchHomeFeed.length, 1);
  assert.equal(pageLoadingCount(calls, "begin"), beginsBeforeHiddenErrors);
  assert.equal(page._homeImageRecoveryPromise, null);

  const resumedRecovery = page.onShow();
  const recoveryPromise = page._homeImageRecoveryPromise;
  assert.equal(resumedRecovery, recoveryPromise);
  assert.equal(pageLoadingCount(calls, "begin"), beginsBeforeHiddenErrors + 1);
  await Promise.resolve();
  assert.equal(calls.fetchHomeFeed.length, 2);

  resolveRecovery({
    revision: 101,
    notModified: false,
    ...refreshedFeed,
  });
  await recoveryPromise;

  assert.equal(calls.fetchHomeFeed.length, 2);
  assert.equal(pageLoadingCount(calls, "begin"), beginsBeforeHiddenErrors + 1);
  assert.equal(
    page.data.banners[0].renderImageUrl,
    refreshedFeed.banners[0].imageUrl
  );
  assert.equal(
    page.data.popularCases[0].coverImageUrl,
    refreshedFeed.popularCases[0].coverImageUrl
  );
  page.onUnload();
});

await test("an offline long-resume refresh keeps cached content and closes recovery loading", async () => {
  const nowMs = 60_000_000;
  const feed = buildVersionedHomeFeed("cached-before-offline");
  let requestCount = 0;
  const { calls, clock, page } = loadHomePage({}, [], {
    fetchHomeFeed: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          revision: 110,
          notModified: false,
          ...feed,
        };
      }
      throw new Error("offline during resume");
    },
    isLegacyCatalogFallbackAllowed: () => false,
    nowMs,
  });

  page.onLoad();
  page.onReady();
  await page._loadPromise;
  const initialBanner = { ...page.data.banners[0] };
  page.onBannerImageLoad({
    currentTarget: { dataset: bannerImageDataset(initialBanner) },
  });
  const finishesBeforeResume = pageLoadingCount(calls, "finish");
  page.onHide();
  clock.advance(CACHE_TTL_MS);

  const result = await page.onShow();

  assert.equal(result.ok, false);
  assert.equal(result.cached, true);
  assert.equal(calls.fetchHomeFeed.length, 2);
  assert.equal(page.data.banners[0].title, initialBanner.title);
  assert.equal(page.data.popularCases.length, feed.popularCases.length);
  assert.equal(page.data.latestCases.length, feed.latestCases.length);
  assert.equal(page._homeEntryAwaitingFreshFeed, false);
  assert.equal(page._homeImageRecoveryPromise, null);
  assert.equal(pageLoadingCount(calls, "finish"), finishesBeforeResume + 1);
  page.onUnload();
});

await test("an incomplete legacy URL exchange never renews the media timestamp", async () => {
  const nowMs = 70_000_000;
  const initialFeed = buildVersionedHomeFeed("before-signing-failure");
  const legacyCases = [
    buildCase(1, {
      coverBanner: "cloud://case-banner",
      homeSections: ["popular", "latest"],
    }),
  ];
  let requestCount = 0;
  const { calls, page } = loadHomePage({}, legacyCases, {
    attachCaseImageUrls: async (items) => items.map((item) => ({
      ...item,
      imageFileId: item.coverBanner,
      coverImageUrl: "",
    })),
    fetchHomeFeed: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          revision: 120,
          notModified: false,
          ...initialFeed,
        };
      }
      throw Object.assign(new Error("catalog unavailable"), {
        code: "UNKNOWN_ACTION",
      });
    },
    fetchVisibleBanners: async () => [{
      id: "legacy-banner",
      caseId: "case_1",
      image: "cloud://legacy-banner",
      imageUrl: "",
    }],
    nowMs,
  });

  page.onLoad();
  page.onReady();
  await page._loadPromise;
  const failedBanner = { ...page.data.banners[0] };
  page.onBannerImageLoad({
    currentTarget: { dataset: bannerImageDataset(failedBanner) },
  });
  const originalFetchedAt = page._homeCache.data.imageUrlsFetchedAt;

  const recovery = page.onBannerImageError({
    currentTarget: { dataset: bannerImageDataset(failedBanner) },
    detail: { errMsg: "expired signed URL" },
  });
  const result = await recovery;

  assert.equal(result.ok, false);
  assert.equal(result.cached, true);
  assert.equal(calls.fetchHomeFeed.length, 2);
  assert.equal(page._homeCache.data.imageUrlsFetchedAt, originalFetchedAt);
  assert.equal(page.data.banners[0].renderImageUrl, "");
  assert.equal(page.data.banners[0].imageLoadState, "failed");
  assert.equal(page._homeImagesNeedRefresh, true);
  assert.equal(page._homeImageRecoveryPromise, null);
  page.onUnload();
});
