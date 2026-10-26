import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(__dirname, "../miniprogram/miniprogram/pages/category/index.js");
const wxmlPath = resolve(__dirname, "../miniprogram/miniprogram/pages/category/index.wxml");
const wxssPath = resolve(__dirname, "../miniprogram/miniprogram/pages/category/index.wxss");

function loadCategoryPage(
  cases = [],
  appGlobalData = {},
  wxMock = {},
  dependencyOverrides = {}
) {
  let pageConfig;
  let nativeLoadingSequence = 0;
  const app = {
    globalData: appGlobalData,
  };
  const sandbox = {
    clearTimeout,
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
            {
              key: "scenes",
              title: "使用场景",
              options: ["婚宴", "百日/满月", "生日宴", "寿宴", "乔迁宴"],
              type: "multi",
            },
          ],
          getSceneLabel: (value) => (value === "婚宴" ? "婚宴/喜宴" : value),
          filterCases(items, { selectedFilters = {} } = {}) {
            return items
              .filter((item) => item.isVisible)
              .filter((item) =>
                Object.entries(selectedFilters).every(([key, values]) => {
                  if (!values.length) return true;
                  const caseValue = item[key];
                  return Array.isArray(caseValue)
                    ? values.some((value) => caseValue.includes(value))
                    : values.includes(caseValue);
                })
              );
          },
          selectedFilterCount: (selectedFilters = {}) =>
            Object.values(selectedFilters).reduce(
              (count, values) => count + values.length,
              0
            ),
        };
      }
      if (moduleName === "../../utils/cloudData") {
        return {
          attachCaseImageUrls:
            dependencyOverrides.attachCaseImageUrls ||
            (async (items) => items.map((item) => {
              const imageFileId =
                item.imageFileId ||
                item.coverBanner ||
                item.coverThumbnail ||
                item.coverImage ||
                "";
              return {
                ...item,
                imageFileId,
                coverImageUrl: imageFileId,
                imageRetryCount: 0,
                imageLoadState: "ready",
              };
            })),
          fetchVisibleCases:
            dependencyOverrides.fetchVisibleCases ||
            (async () => cases),
          refreshImageUrl: async (fileID) => fileID,
        };
      }
      if (moduleName === "../../utils/caseCatalogService") {
        return {
          fetchCatalogImageUrls:
            dependencyOverrides.fetchCatalogImageUrls ||
            (async () => {
              const error = new Error("unknown action");
              error.code = "UNKNOWN_ACTION";
              throw error;
            }),
          fetchCatalogSnapshot:
            dependencyOverrides.fetchCatalogSnapshot ||
            (async () => {
              const error = new Error("unknown action");
              error.code = "UNKNOWN_ACTION";
              throw error;
            }),
          isLegacyCatalogFallbackAllowed:
            dependencyOverrides.isLegacyCatalogFallbackAllowed ||
            ((error) => Boolean(error && ["UNKNOWN_ACTION", "FUNCTION_NOT_FOUND"].includes(error.code))),
        };
      }
      if (moduleName === "../../utils/catalogCache") {
        return {
          CATALOG_CACHE_KEY: "wineCatalogSnapshotV2",
          readCache: dependencyOverrides.readCache || (() => null),
          writeCache: dependencyOverrides.writeCache || (() => {}),
        };
      }
      if (moduleName === "../../utils/caseRefresh") {
        return {
          getCaseDataVersion: () => 1,
          shouldRefreshCaseData: () => false,
        };
      }
      if (moduleName === "../../utils/errorTelemetry") {
        return {
          reportClientFault:
            dependencyOverrides.reportClientFault || (() => false),
        };
      }
      if (moduleName === "../../utils/nativePageLoading") {
        return dependencyOverrides.nativePageLoading || {
          beginPageLoading() {
            nativeLoadingSequence += 1;
            return { id: nativeLoadingSequence };
          },
          finishPageLoading() {},
          cancelPageLoading() {},
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    setTimeout,
    wx: {
      getStorageSync() {
        return "";
      },
      navigateTo() {},
      removeStorageSync() {},
      showLoading() {},
      hideLoading() {},
      stopPullDownRefresh() {},
      ...wxMock,
    },
  };

  vm.runInNewContext(readFileSync(pagePath, "utf8"), sandbox, {
    filename: pagePath,
  });
  const setDataCalls = [];
  pageConfig.setData = function setData(nextData, callback) {
    setDataCalls.push(nextData);
    this.data = {
      ...this.data,
      ...nextData,
    };
    if (typeof callback === "function") callback();
  };
  return {
    app,
    page: pageConfig,
    setDataCalls,
  };
}

function createNativeLoadingRecorder(events) {
  let sequence = 0;
  let activeToken = null;
  return {
    beginPageLoading(options) {
      sequence += 1;
      const token = { id: sequence };
      activeToken = token;
      events.push(["begin", JSON.parse(JSON.stringify(options)), token.id]);
      return token;
    },
    finishPageLoading(token) {
      if (activeToken !== token) return false;
      events.push(["finish", token && token.id]);
      activeToken = null;
      return true;
    },
    cancelPageLoading(token) {
      if (activeToken !== token) return false;
      events.push(["cancel", token && token.id]);
      activeToken = null;
      return true;
    },
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

await test("category cards fill their frame with the aspect-preserving cover", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const caseImage = wxml.match(/<image\b[^>]*class="case-image"[^>]*>/)?.[0] || "";
  assert.match(caseImage, /mode="aspectFill"/);
  assert.match(caseImage, /\slazy-load(?:\s|>)/);
  assert.match(caseImage, /fade-in="{{true}}"/);
  assert.match(caseImage, /bindload="onCardImageLoad"/);
  assert.match(caseImage, /binderror="retryCardImage"/);
  assert.match(caseImage, /data-url="{{item\.coverImageUrl}}"/);
});

await test("category no-cache error state exposes an in-place retry action", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  assert.equal(wxml.includes('bindtap="retryLoadData"'), true);
  assert.equal(wxml.includes("重新加载"), true);
});

await test("category explains that scrolling loads more cases and marks the end", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  assert.match(wxml, /bindscrolltolower="loadMore"/);
  assert.match(wxml, /class="load-more-status"/);
  assert.match(wxml, /visibleCards\.length < filteredCount/);
  assert.match(wxml, /继续上滑，加载更多案例/);
  assert.match(wxml, /已展示全部案例/);
});

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

await test("category entry loading uses the shared controller and closes after an image-free first batch", async () => {
  const events = [];
  const { page } = loadCategoryPage(
    [buildCase("case_1")],
    {},
    {},
    { nativePageLoading: createNativeLoadingRecorder(events) }
  );

  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.deepEqual(plain(events), [
    ["begin", {
      owner: "category-entry",
      title: "加载中",
      delayMs: 120,
      minVisibleMs: 300,
      maxVisibleMs: 3000,
      mask: false,
    }, 1],
    ["finish", 1],
  ]);
});

await test("category entry loading waits for the first visible card image load", async () => {
  const events = [];
  const cases = [
    buildCase("case_1", { imageFileId: "cloud://env/first.jpg" }),
    buildCase("case_2", { imageFileId: "cloud://env/second.jpg" }),
  ];
  const { page } = loadCategoryPage(cases, {}, {}, {
    nativePageLoading: createNativeLoadingRecorder(events),
    fetchCatalogImageUrls: async (ids) => ids.reduce((images, id) => {
      images[id] = {
        imageFileId: cases.find((item) => item.id === id).imageFileId,
        thumbnailUrl: `https://temp/${id}.jpg`,
      };
      return images;
    }, {}),
  });

  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.deepEqual(events.map((event) => event[0]), ["begin"]);
  assert.equal(page._categoryEntryAwaitingImageId, "case_1");
  const imageRequestVersion = page._categoryEntryAwaitingImageRequestVersion;
  assert.equal(
    page.onCardImageLoad({
      currentTarget: {
        dataset: {
          id: "case_2",
          entryLoadRequestVersion: imageRequestVersion,
        },
      },
    }),
    false
  );
  assert.deepEqual(events.map((event) => event[0]), ["begin"]);
  assert.equal(
    page.onCardImageLoad({
      currentTarget: {
        dataset: {
          id: "case_1",
          entryLoadRequestVersion: imageRequestVersion + 1,
        },
      },
    }),
    false
  );
  assert.equal(
    page.onCardImageLoad({
      currentTarget: {
        dataset: {
          id: "case_1",
          entryLoadRequestVersion: imageRequestVersion,
        },
      },
    }),
    true
  );
  assert.deepEqual(events.map((event) => event[0]), ["begin", "finish"]);
});

await test("category entry loading also closes when the first visible card image errors", async () => {
  const events = [];
  const firstCase = buildCase("case_1", {
    imageFileId: "cloud://env/first.jpg",
  });
  const { page } = loadCategoryPage([firstCase], {}, {}, {
    nativePageLoading: createNativeLoadingRecorder(events),
    fetchCatalogImageUrls: async () => ({
      case_1: {
        imageFileId: firstCase.imageFileId,
        thumbnailUrl: "https://temp/case_1.jpg",
      },
    }),
  });

  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(events.map((event) => event[0]), ["begin"]);

  await page.retryCardImage({
    currentTarget: {
      dataset: {
        id: "case_1",
        entryLoadRequestVersion: page._categoryEntryAwaitingImageRequestVersion,
      },
    },
    detail: { errMsg: "image load failed" },
  });

  assert.deepEqual(events.map((event) => event[0]), ["begin", "finish"]);
});

await test("category hot cache waits only when its first image exceeds the delay", async () => {
  const events = [];
  const cachedItem = buildCase("case_cached", {
    imageFileId: "cloud://env/cached.jpg",
    coverImageUrl: "https://temp/cached.jpg",
  });
  const { page } = loadCategoryPage([], {}, {}, {
    nativePageLoading: createNativeLoadingRecorder(events),
    readCache: () => ({
      revision: 7,
      cachedAt: Date.now(),
      fresh: true,
      data: { items: [cachedItem] },
    }),
    fetchCatalogSnapshot: async () => ({
      revision: 7,
      notModified: true,
    }),
  });

  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.deepEqual(events.map((event) => event[0]), ["begin"]);
  assert.equal(page.data.visibleCards[0].coverImageUrl, "https://temp/cached.jpg");
  const imageRequestVersion = page._categoryEntryAwaitingImageRequestVersion;
  assert.equal(page.onCardImageLoad({
    currentTarget: {
      dataset: {
        id: "case_cached",
        entryLoadRequestVersion: imageRequestVersion,
      },
    },
  }), true);
  assert.deepEqual(events.map((event) => event[0]), ["begin", "finish"]);
});

await test("category hot return settles an already loaded first image without waiting again", async () => {
  const events = [];
  const cachedItem = buildCase("case_cached", {
    imageFileId: "cloud://env/cached.jpg",
    coverImageUrl: "https://temp/cached.jpg",
  });
  const { page } = loadCategoryPage([], {}, {}, {
    nativePageLoading: createNativeLoadingRecorder(events),
    readCache: () => ({
      revision: 7,
      cachedAt: Date.now(),
      fresh: true,
      data: { items: [cachedItem] },
    }),
    fetchCatalogSnapshot: async () => ({ revision: 7, notModified: true }),
  });

  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  page.onCardImageLoad({
    currentTarget: {
      dataset: {
        id: "case_cached",
        url: "https://temp/cached.jpg",
        entryLoadRequestVersion: page._categoryEntryAwaitingImageRequestVersion,
      },
    },
  });
  page.onHide();
  page._loadPromise = Promise.resolve({ ok: true });
  page.onShow();

  assert.deepEqual(
    events.map((event) => event[0]),
    ["begin", "finish", "begin", "finish"]
  );
});

await test("category pull-down refresh does not stack an entry loading indicator", async () => {
  const events = [];
  const { page } = loadCategoryPage(
    [buildCase("case_1")],
    {},
    {},
    { nativePageLoading: createNativeLoadingRecorder(events) }
  );

  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  events.length = 0;
  await page.onPullDownRefresh();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.deepEqual(events, []);
});

await test("category cancels a pending entry indicator when the tab is hidden", async () => {
  const events = [];
  const item = buildCase("case_1", {
    imageFileId: "cloud://env/first.jpg",
  });
  const { page } = loadCategoryPage([item], {}, {}, {
    nativePageLoading: createNativeLoadingRecorder(events),
    fetchCatalogImageUrls: async () => ({
      case_1: {
        imageFileId: item.imageFileId,
        thumbnailUrl: "https://temp/case_1.jpg",
      },
    }),
  });

  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  page.onHide();

  assert.deepEqual(events.map((event) => event[0]), ["begin", "cancel"]);
});

await test("category sort options use recent and popular labels", () => {
  const source = readFileSync(pagePath, "utf8");
  const markup = readFileSync(wxmlPath, "utf8");

  assert.equal(source.includes("最近上新"), true);
  assert.equal(source.includes("热门产品"), true);
  assert.equal(source.includes("最新优先"), false);
  assert.equal(markup.includes('bindtap="removeSelectedPill"'), true);
  assert.equal(markup.includes('data-key="{{item.key}}"'), true);
  assert.equal(markup.includes('data-value="{{item.value}}"'), true);
  assert.equal(markup.includes("<text>{{item.label}}</text>"), true);
});

await test("category displays scene labels but keeps internal filter values", async () => {
  const { page } = loadCategoryPage([
    buildCase("case_1", { scenes: ["婚宴"] }),
    buildCase("case_2", { scenes: ["生日宴"] }),
  ]);
  await page.onLoad({});

  page.selectNav({ currentTarget: { dataset: { key: "scenes" } } });
  const sceneNav = page.data.navItems.find((item) => item.key === "scenes");
  assert.equal(sceneNav.optionItems[0].value, "婚宴");
  assert.equal(sceneNav.optionItems[0].label, "婚宴/喜宴");

  page.toggleFilterOption({
    currentTarget: { dataset: { key: "scenes", value: "婚宴" } },
  });
  assert.deepEqual(plain(page.data.filters[1].selectedValues), ["婚宴"]);
  assert.equal(page.data.selectedPills.at(-1).value, "婚宴");
  assert.equal(page.data.selectedPills.at(-1).label, "婚宴/喜宴");
  assert.equal(page.data.activePanel.displayTitle, "婚宴/喜宴");
  assert.deepEqual(plain(page._filteredCases.map((item) => item.id)), ["case_1"]);
});

await test("category scene sidebar wraps long labels and uses the display label in empty states", async () => {
  const markup = readFileSync(wxmlPath, "utf8");
  const styles = readFileSync(wxssPath, "utf8");
  const { page } = loadCategoryPage([
    buildCase("case_1", { scenes: ["生日宴"] }),
  ]);
  await page.onLoad({});
  page.selectNav({ currentTarget: { dataset: { key: "scenes" } } });
  page.toggleFilterOption({
    currentTarget: { dataset: { key: "scenes", value: "婚宴" } },
  });

  assert.equal(markup.includes("{{optionItem.label}}"), true);
  assert.match(styles, /\.side-nav\s*\{[\s\S]*?overflow-y:\s*auto;/);
  assert.match(styles, /\.sub-nav-label\s*\{[\s\S]*?-webkit-line-clamp:\s*2;/);
  assert.equal(page.data.filteredCount, 0);
  assert.equal(page.data.emptyMessage, "暂无“婚宴/喜宴”案例，换个条件试试");
});

await test("category page can be shared to friends and timeline", () => {
  const { page } = loadCategoryPage();

  assert.deepEqual(plain(page.onShareAppMessage()), {
    title: "酒包装案例库｜金亿诚包装科技",
    path: "/pages/category/index",
  });
  assert.deepEqual(plain(page.onShareTimeline()), {
    title: "酒包装案例库｜金亿诚包装科技",
  });
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
  assert.equal(page.data.selectedPills[0].label, "最近上新");
  assert.deepEqual(plain(page._filteredCases.map((item) => item.id)), [
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
  assert.equal(page.data.selectedPills[0].label, "热门产品");
  assert.deepEqual(plain(page._filteredCases.map((item) => item.id)), [
    "case_3",
  ]);
});

await test("category sort choices appear as removable selected pills", async () => {
  const { page } = loadCategoryPage([
    buildCase("case_1", { statuses: ["最新产品"] }),
    buildCase("case_2", { statuses: ["热门产品"] }),
    buildCase("case_3"),
  ]);

  await page.onLoad({});
  page.selectSort({ currentTarget: { dataset: { value: "latest" } } });

  assert.equal(page.data.selectedSort, "latest");
  assert.deepEqual(plain(page.data.selectedPills), [
    {
      id: "sort:latest",
      key: "sort",
      value: "latest",
      label: "最近上新",
      title: "排序",
    },
  ]);
  assert.deepEqual(plain(page._filteredCases.map((item) => item.id)), [
    "case_1",
  ]);

  page.selectSort({ currentTarget: { dataset: { value: "popular" } } });

  assert.equal(page.data.selectedPills.length, 1);
  assert.equal(page.data.selectedPills[0].label, "热门产品");
  assert.deepEqual(plain(page._filteredCases.map((item) => item.id)), [
    "case_2",
  ]);

  page.selectSort({ currentTarget: { dataset: { value: "default" } } });

  assert.equal(page.data.selectedSort, "default");
  assert.deepEqual(plain(page.data.selectedPills), []);
});

await test("removing a sort pill restores default sorting without clearing filters", async () => {
  const { page } = loadCategoryPage([
    buildCase("case_1", {
      packageTypes: ["礼盒"],
      statuses: ["热门产品"],
    }),
    buildCase("case_2", {
      packageTypes: ["瓶标"],
      statuses: ["热门产品"],
    }),
    buildCase("case_3", { packageTypes: ["礼盒"] }),
  ]);

  await page.onLoad({});
  page.toggleFilterOption({
    currentTarget: { dataset: { key: "packageTypes", value: "礼盒" } },
  });
  page.selectSort({ currentTarget: { dataset: { value: "popular" } } });

  assert.deepEqual(
    plain(page.data.selectedPills.map((pill) => pill.label)),
    ["热门产品", "礼盒"]
  );
  assert.deepEqual(plain(page._filteredCases.map((item) => item.id)), [
    "case_1",
  ]);

  page.removeSelectedPill({
    currentTarget: { dataset: { key: "sort", value: "popular" } },
  });

  assert.equal(page.data.selectedSort, "default");
  assert.deepEqual(
    plain(page.data.filters[0].selectedValues),
    ["礼盒"]
  );
  assert.equal(page.data.filters[0].optionItems[0].selected, true);
  assert.deepEqual(plain(page.data.selectedPills), [
    {
      id: "packageTypes:礼盒",
      key: "packageTypes",
      value: "礼盒",
      label: "礼盒",
      title: "包装",
    },
  ]);
  assert.deepEqual(plain(page._filteredCases.map((item) => item.id)), [
    "case_1",
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
  assert.deepEqual(plain(page._filteredCases.map((item) => item.id)), ["case_2"]);
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
  assert.deepEqual(plain(page._filteredCases.map((item) => item.id)), ["case_2"]);
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
  assert.deepEqual(plain(page._filteredCases.map((item) => item.id)), [
    "case_3",
  ]);
  assert.equal(removedKey, "pendingCategorySort");
});

await test("category keeps the full snapshot off data and renders at most 12 cards", async () => {
  const cases = Array.from({ length: 50 }, (_, index) =>
    buildCase(`case_${index + 1}`)
  );
  const { page } = loadCategoryPage(cases);

  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.equal(page._allCases.length, 50);
  assert.equal(page._filteredCases.length, 50);
  assert.equal(page.data.visibleCards.length, 12);
  assert.equal(Object.prototype.hasOwnProperty.call(page.data, "allCases"), false);
  assert.equal(page.data.filteredCount, 50);
});

await test("category requests image URLs only for each visible batch of 12", async () => {
  const cases = Array.from({ length: 30 }, (_, index) =>
    buildCase(`doc_${index + 1}`, {
      imageFileId: `cloud://env/banner-${index + 1}.jpg`,
    })
  );
  const imageBatches = [];
  const { page } = loadCategoryPage(cases, {}, {}, {
    fetchCatalogImageUrls: async (ids) => {
      imageBatches.push(ids.slice());
      return ids.reduce((images, id) => {
        const item = cases.find((caseItem) => caseItem.id === id);
        images[id] = {
          imageFileId: item.imageFileId,
          thumbnailUrl: `https://temp/${id}.jpg`,
        };
        return images;
      }, {});
    },
  });

  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.deepEqual(plain(imageBatches.map((ids) => ids.length)), [12]);
  assert.deepEqual(plain(imageBatches[0]), cases.slice(0, 12).map((item) => item.id));
  assert.equal(page.data.visibleCards[0].coverImageUrl, "https://temp/doc_1.jpg");

  page.loadMore();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.deepEqual(plain(imageBatches.map((ids) => ids.length)), [12, 12]);
  assert.deepEqual(plain(imageBatches[1]), cases.slice(12, 24).map((item) => item.id));
});

await test("category falls back to existing image hydration against an old cloud function", async () => {
  const imageFileId = "cloud://env/legacy-banner.jpg";
  let endpointCalls = 0;
  let fallbackCalls = 0;
  const { page } = loadCategoryPage([
    buildCase("doc_legacy", { imageFileId }),
  ], {}, {}, {
    fetchCatalogImageUrls: async () => {
      endpointCalls += 1;
      const error = new Error("unknown action");
      error.code = "UNKNOWN_ACTION";
      throw error;
    },
    attachCaseImageUrls: async (items) => {
      fallbackCalls += 1;
      return items.map((item) => ({
        ...item,
        imageFileId,
        coverImageUrl: "https://temp/legacy-banner.jpg",
        imageRetryCount: 0,
        imageLoadState: "ready",
      }));
    },
  });

  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  assert.equal(endpointCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(
    page.data.visibleCards[0].coverImageUrl,
    "https://temp/legacy-banner.jpg"
  );

  page.applyFilters();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(endpointCalls, 1);
  assert.equal(fallbackCalls, 1);
});

await test("a successful image map with missing entries does not fan out to legacy reads", async () => {
  let fallbackCalls = 0;
  const item = buildCase("doc_missing_image", {
    imageFileId: "cloud://env/missing-image.jpg",
  });
  const { page } = loadCategoryPage([item], {}, {}, {
    fetchCatalogImageUrls: async () => ({}),
    attachCaseImageUrls: async (items) => {
      fallbackCalls += 1;
      return items;
    },
  });

  await page.onLoad({});
  await Promise.resolve();
  assert.equal(fallbackCalls, 0);
  assert.equal(page.data.visibleCards[0].imageLoadState, "failed");
});

await test("category search applies only once after the 250ms debounce window", async () => {
  const { page } = loadCategoryPage([buildCase("case_1")]);
  await page.onLoad({});
  let applyCount = 0;
  page.applyFilters = () => {
    applyCount += 1;
  };

  page.onSearchInput({ detail: { value: "青" } });
  page.onSearchInput({ detail: { value: "青花" } });
  page.onSearchInput({ detail: { value: "青花瓷" } });
  assert.equal(applyCount, 0);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 280));
  assert.equal(applyCount, 1);
});

await test("category load-more sends only appended card paths", async () => {
  const cases = Array.from({ length: 50 }, (_, index) =>
    buildCase(`case_${index + 1}`)
  );
  const { page, setDataCalls } = loadCategoryPage(cases);
  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  setDataCalls.length = 0;

  page.loadMore();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  const appendPatch = setDataCalls.find((patch) =>
    Object.prototype.hasOwnProperty.call(patch, "visibleCards[12]")
  );
  assert.ok(appendPatch);
  assert.equal(Object.prototype.hasOwnProperty.call(appendPatch, "visibleCards"), false);
  assert.equal(
    Object.keys(appendPatch).filter((key) => key.startsWith("visibleCards[")).length,
    12
  );
});

await test("category uses the native loading indicator only when another batch exists", async () => {
  const cases = Array.from({ length: 13 }, (_, index) =>
    buildCase(`case_${index + 1}`)
  );
  const nativeLoadingEvents = [];
  const { page, setDataCalls } = loadCategoryPage(cases, {}, {}, {
    nativePageLoading: createNativeLoadingRecorder(nativeLoadingEvents),
  });
  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  nativeLoadingEvents.length = 0;

  const loadPromise = page.loadMore();
  assert.deepEqual(plain(nativeLoadingEvents), [
    ["begin", {
      owner: "category-load-more",
      title: "加载更多",
      delayMs: 0,
      minVisibleMs: 0,
      maxVisibleMs: 3000,
      mask: false,
    }, 2],
  ]);
  assert.equal(await loadPromise, true);
  assert.ok(
    setDataCalls.some((patch) =>
      Object.prototype.hasOwnProperty.call(patch, "visibleCards[12]")
    )
  );
  assert.deepEqual(plain(nativeLoadingEvents), [
    ["begin", {
      owner: "category-load-more",
      title: "加载更多",
      delayMs: 0,
      minVisibleMs: 0,
      maxVisibleMs: 3000,
      mask: false,
    }, 2],
    ["finish", 2],
  ]);

  page.data.visibleCards = cases;
  assert.equal(await page.loadMore(), false);
  assert.equal(nativeLoadingEvents.length, 2);
});

await test("category clears a native load-more indicator when leaving the page", async () => {
  const cases = Array.from({ length: 13 }, (_, index) =>
    buildCase(`case_${index + 1}`, {
      imageFileId: `cloud://env/banner-${index + 1}.jpg`,
    })
  );
  let resolveNextBatch;
  let requestCount = 0;
  const nativeLoadingEvents = [];
  const { page } = loadCategoryPage(cases, {}, {}, {
    nativePageLoading: createNativeLoadingRecorder(nativeLoadingEvents),
    fetchCatalogImageUrls: async (ids) => {
      requestCount += 1;
      if (requestCount === 2) {
        await new Promise((resolvePromise) => {
          resolveNextBatch = resolvePromise;
        });
      }
      return ids.reduce((images, id) => {
        images[id] = {
          imageFileId: cases.find((item) => item.id === id).imageFileId,
          thumbnailUrl: `https://temp/${id}.jpg`,
        };
        return images;
      }, {});
    },
  });
  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  page.onCardImageLoad({
    currentTarget: {
      dataset: {
        id: "case_1",
        entryLoadRequestVersion: page._categoryEntryAwaitingImageRequestVersion,
      },
    },
  });
  nativeLoadingEvents.length = 0;

  const loadPromise = page.loadMore();
  assert.equal(nativeLoadingEvents[0][0], "begin");
  assert.equal(nativeLoadingEvents[0][1].owner, "category-load-more");
  page.onHide();
  assert.deepEqual(nativeLoadingEvents.map((event) => event[0]), ["begin", "cancel"]);
  resolveNextBatch();
  await loadPromise;
  assert.deepEqual(nativeLoadingEvents.map((event) => event[0]), ["begin", "cancel"]);
});

await test("an older append request cannot close the current native indicator", async () => {
  const cases = Array.from({ length: 25 }, (_, index) =>
    buildCase(`case_${index + 1}`, {
      imageFileId: `cloud://env/banner-${index + 1}.jpg`,
    })
  );
  const nativeLoadingEvents = [];
  const pendingRequests = [];
  let requestCount = 0;
  const imageMapFor = (ids) =>
    ids.reduce((images, id) => {
      images[id] = {
        imageFileId: cases.find((item) => item.id === id).imageFileId,
        thumbnailUrl: `https://temp/${id}.jpg`,
      };
      return images;
    }, {});
  const { page } = loadCategoryPage(cases, {}, {}, {
    nativePageLoading: createNativeLoadingRecorder(nativeLoadingEvents),
    fetchCatalogImageUrls: async (ids) => {
      requestCount += 1;
      if (requestCount === 1) return imageMapFor(ids);
      return new Promise((resolvePromise) => {
        pendingRequests.push(() => resolvePromise(imageMapFor(ids)));
      });
    },
  });
  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  page.onCardImageLoad({
    currentTarget: {
      dataset: {
        id: "case_1",
        entryLoadRequestVersion: page._categoryEntryAwaitingImageRequestVersion,
      },
    },
  });
  nativeLoadingEvents.length = 0;

  const oldLoadPromise = page.loadMore();
  assert.equal(await page.loadMore(), false);
  assert.deepEqual(nativeLoadingEvents.map((event) => event[0]), ["begin"]);

  page.applyFilters();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(nativeLoadingEvents.map((event) => event[0]), ["begin", "cancel"]);

  const currentLoadPromise = page.loadMore();
  assert.deepEqual(nativeLoadingEvents.map((event) => event[0]), ["begin", "cancel", "begin"]);
  pendingRequests[0]();
  await oldLoadPromise;
  assert.deepEqual(nativeLoadingEvents.map((event) => event[0]), ["begin", "cancel", "begin"]);

  pendingRequests[1]();
  await currentLoadPromise;
  assert.deepEqual(nativeLoadingEvents.map((event) => event[0]), ["begin", "cancel", "begin", "finish"]);
});

await test("category ignores a pending appended image result after unload", async () => {
  const cases = Array.from({ length: 13 }, (_, index) =>
    buildCase(`case_${index + 1}`, {
      imageFileId: `cloud://env/banner-${index + 1}.jpg`,
    })
  );
  let resolveNextBatch;
  let requestCount = 0;
  const nativeLoadingEvents = [];
  const { page, setDataCalls } = loadCategoryPage(cases, {}, {}, {
    nativePageLoading: createNativeLoadingRecorder(nativeLoadingEvents),
    fetchCatalogImageUrls: async (ids) => {
      requestCount += 1;
      if (requestCount === 2) {
        await new Promise((resolvePromise) => {
          resolveNextBatch = resolvePromise;
        });
      }
      return ids.reduce((images, id) => {
        images[id] = {
          imageFileId: cases.find((item) => item.id === id).imageFileId,
          thumbnailUrl: `https://temp/${id}.jpg`,
        };
        return images;
      }, {});
    },
  });
  await page.onLoad({});
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  page.onCardImageLoad({
    currentTarget: {
      dataset: {
        id: "case_1",
        entryLoadRequestVersion: page._categoryEntryAwaitingImageRequestVersion,
      },
    },
  });
  nativeLoadingEvents.length = 0;

  const loadPromise = page.loadMore();
  page.onUnload();
  const callsAfterUnload = setDataCalls.length;
  assert.deepEqual(nativeLoadingEvents.map((event) => event[0]), ["begin", "cancel"]);
  resolveNextBatch();
  await loadPromise;
  assert.equal(setDataCalls.length, callsAfterUnload);
  assert.deepEqual(nativeLoadingEvents.map((event) => event[0]), ["begin", "cancel"]);
});

await test("category deduplicates an in-flight non-forced catalog request", async () => {
  let resolveSnapshot;
  let requestCount = 0;
  const { page } = loadCategoryPage([], {}, {}, {
    fetchCatalogSnapshot: () => {
      requestCount += 1;
      return new Promise((resolvePromise) => {
        resolveSnapshot = resolvePromise;
      });
    },
  });

  const firstPromise = page.onLoad({});
  await Promise.resolve();
  const secondPromise = page.loadData();

  assert.equal(firstPromise, secondPromise);
  assert.equal(requestCount, 1);
  resolveSnapshot({ revision: 2, notModified: false, items: [buildCase("case_2")] });
  const result = await firstPromise;
  assert.equal(result.ok, true);
  assert.equal(page._loadPromise, null);
});

await test("a stale catalog response cannot overwrite a newer forced request", async () => {
  const pendingRequests = [];
  const { page } = loadCategoryPage([], {}, {}, {
    fetchCatalogSnapshot: () => new Promise((resolvePromise) => {
      pendingRequests.push(resolvePromise);
    }),
  });

  const oldPromise = page.onLoad({});
  await Promise.resolve();
  const currentPromise = page.loadData({ forceRefresh: true });
  await Promise.resolve();
  assert.equal(pendingRequests.length, 2);

  pendingRequests[1]({
    revision: 3,
    notModified: false,
    items: [buildCase("case_new")],
  });
  assert.equal((await currentPromise).ok, true);
  pendingRequests[0]({
    revision: 2,
    notModified: false,
    items: [buildCase("case_old")],
  });
  assert.equal((await oldPromise).cancelled, true);
  assert.deepEqual(plain(page._allCases.map((item) => item.id)), ["case_new"]);
});

await test("a pending catalog response performs no setData after unload", async () => {
  let resolveSnapshot;
  const { page, setDataCalls } = loadCategoryPage([], {}, {}, {
    fetchCatalogSnapshot: () => new Promise((resolvePromise) => {
      resolveSnapshot = resolvePromise;
    }),
  });

  const loadPromise = page.onLoad({});
  await Promise.resolve();
  page.onUnload();
  const callsAfterUnload = setDataCalls.length;
  resolveSnapshot({
    revision: 2,
    notModified: false,
    items: [buildCase("case_late")],
  });

  assert.equal((await loadPromise).cancelled, true);
  assert.equal(setDataCalls.length, callsAfterUnload);
});

await test("pending-sort storage failures are contained and reported", async () => {
  const reports = [];
  const { page } = loadCategoryPage([buildCase("case_1")], {}, {
    getStorageSync() {
      throw new Error("storage read unavailable");
    },
    removeStorageSync() {
      throw new Error("storage remove unavailable");
    },
  }, {
    reportClientFault(payload) {
      reports.push(payload);
      return true;
    },
  });

  const result = await page.onLoad({});
  assert.equal(result.ok, true);
  assert.deepEqual(
    reports.slice(0, 2).map((report) => report.stage),
    ["pending_sort_read", "pending_sort_remove"]
  );
});

await test("category load promises resolve with an error result instead of rejecting", async () => {
  let fallbackCalls = 0;
  const { page } = loadCategoryPage([], {}, {}, {
    fetchCatalogSnapshot: async () => {
      throw new Error("catalog offline");
    },
    fetchVisibleCases: async () => {
      fallbackCalls += 1;
      throw new Error("database offline");
    },
  });

  const result = await page.onLoad({});
  assert.equal(result.ok, false);
  assert.equal(fallbackCalls, 0);
  assert.equal(page.data.loading, false);
  assert.match(page.data.errorMessage, /暂时读取不到案例数据/);
});

await test("category retries a no-cache failure with a forced catalog request", async () => {
  let attempts = 0;
  const recovered = buildCase("case_recovered");
  const { page } = loadCategoryPage([], {}, {}, {
    fetchCatalogSnapshot: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("offline"), { code: "NETWORK_ERROR" });
      }
      return { revision: 9, notModified: false, items: [recovered] };
    },
    isLegacyCatalogFallbackAllowed: () => false,
  });

  const firstResult = await page.onLoad({});
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.status, "error");
  assert.match(page.data.errorMessage, /暂时读取不到案例数据/);

  const retryResult = await page.retryLoadData();
  assert.equal(retryResult.ok, true);
  assert.equal(retryResult.status, "success");
  assert.equal(attempts, 2);
  assert.equal(page.data.errorMessage, "");
  assert.deepEqual(plain(page._allCases.map((item) => item.id)), ["case_recovered"]);
});

await test("category image network failures do not fan out to per-case hydration", async () => {
  let fallbackCalls = 0;
  const item = buildCase("doc_network", {
    imageFileId: "cloud://env/network.jpg",
  });
  const { page } = loadCategoryPage([item], {}, {}, {
    fetchCatalogImageUrls: async () => {
      const error = new Error("network timeout");
      error.code = "NETWORK_ERROR";
      throw error;
    },
    attachCaseImageUrls: async (items) => {
      fallbackCalls += 1;
      return items;
    },
  });

  await page.onLoad({});
  await Promise.resolve();
  assert.equal(fallbackCalls, 0);
  assert.equal(page.data.visibleCards[0].imageLoadState, "failed");
});

await test("revision zero is display-only while a stale positive revision revalidates", async () => {
  const knownRevisions = [];
  const runWithRevision = async (revision) => {
    const cachedItem = buildCase(`case_cache_${revision}`);
    const { page } = loadCategoryPage([], {}, {}, {
      readCache: () => ({
        revision,
        cachedAt: Date.now() - 60 * 60 * 1000,
        fresh: false,
        data: { items: [cachedItem] },
      }),
      fetchCatalogSnapshot: async (options) => {
        knownRevisions.push(options.knownRevision);
        return { revision, notModified: true };
      },
    });
    await page.onLoad({});
  };

  await runWithRevision(0);
  await runWithRevision(7);
  assert.deepEqual(knownRevisions, [undefined, 7]);
});
