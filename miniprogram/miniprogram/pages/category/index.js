const caseData = require("../../utils/caseData");
const {
  DEFAULT_FILTERS,
  filterCases,
  selectedFilterCount,
} = caseData;
const getSceneLabel = caseData.getSceneLabel || ((value) => value || "");
const { attachCaseImageUrls, fetchVisibleCases, refreshImageUrl } = require("../../utils/cloudData");
const {
  fetchCatalogImageUrls,
  fetchCatalogSnapshot,
  isLegacyCatalogFallbackAllowed,
} = require("../../utils/caseCatalogService");
const catalogCache = require("../../utils/catalogCache");
const {
  CATALOG_CACHE_KEY,
  readCache,
  writeCache,
} = catalogCache;
const {
  getCaseDataVersion,
  shouldRefreshCaseData,
} = require("../../utils/caseRefresh");
const { reportClientFault } = require("../../utils/errorTelemetry");
const {
  beginPageLoading,
  finishPageLoading,
  cancelPageLoading,
} = require("../../utils/nativePageLoading");

const FILTER_TITLE_OVERRIDES = {
  packageTypes: "包装",
  priceLevel: "价位",
  scenes: "场景",
};

const FILTER_KEYS = ["wineType", "packageTypes", "styles", "priceLevel", "scenes"];
const SORT_OPTIONS = [
  { key: "default", title: "默认排序" },
  { key: "latest", title: "最近上新" },
  { key: "popular", title: "热门产品" },
];
const PENDING_CATEGORY_SORT_KEY = "pendingCategorySort";
const CARD_PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 250;
const CATEGORY_SHARE_TITLE = "酒包装案例库｜金亿诚包装科技";
const CATEGORY_ENTRY_LOADING_OPTIONS = {
  owner: "category-entry",
  title: "加载中",
  delayMs: 120,
  minVisibleMs: 300,
  maxVisibleMs: 3000,
  mask: false,
};
const CATEGORY_LOAD_MORE_LOADING_OPTIONS = {
  owner: "category-load-more",
  title: "加载更多",
  delayMs: 0,
  minVisibleMs: 0,
  maxVisibleMs: 3000,
  mask: false,
};
const PANEL_SUBTITLES = {
  sort: "选择案例排序方式",
  wineType: "按酒类查看产品与案例",
  packageTypes: "包含: 瓶标/酒瓶/酒盒/手提袋/外箱",
  styles: "按设计风格查看产品与案例",
  priceLevel: "按价位感查看产品与案例",
  scenes: "按使用场景查看产品与案例",
};

function reportCategoryFault(stage, error, options = {}) {
  reportClientFault({
    type: options.type || "category_error",
    stage,
    error,
    code: options.code,
    route: "pages/category/index",
    action: options.action || "category_load",
    requestKind: options.requestKind,
    cacheState: options.cacheState,
    fallbackUsed: options.fallbackUsed,
    disposed: options.disposed,
  });
}

function isPageAlive(page) {
  return Boolean(page) && page._alive === true;
}

function isCurrentDataRequest(page, requestVersion) {
  return (
    isPageAlive(page) &&
    (requestVersion === undefined || page._dataRequestVersion === requestVersion)
  );
}

function isCurrentImageRequest(page, requestVersion) {
  return (
    isPageAlive(page) &&
    (requestVersion === undefined || page._imageRequestVersion === requestVersion)
  );
}

function normalizeLoadResult(result = {}) {
  if (result.status) return result;
  if (result.cancelled) return { ...result, status: "stale" };
  if (result.cached || result.notModified) return { ...result, status: "cache" };
  if (result.ok) return { ...result, status: "success" };
  return { ...result, status: "error" };
}

function safeSetData(page, data, options = {}) {
  if (!isPageAlive(page)) return false;
  if (
    options.dataRequestVersion !== undefined &&
    !isCurrentDataRequest(page, options.dataRequestVersion)
  ) {
    return false;
  }
  if (
    options.imageRequestVersion !== undefined &&
    !isCurrentImageRequest(page, options.imageRequestVersion)
  ) {
    return false;
  }
  try {
    page.setData(data, () => {
      if (!isPageAlive(page)) return;
      if (
        options.dataRequestVersion !== undefined &&
        !isCurrentDataRequest(page, options.dataRequestVersion)
      ) return;
      if (
        options.imageRequestVersion !== undefined &&
        !isCurrentImageRequest(page, options.imageRequestVersion)
      ) return;
      if (typeof options.onCommitted === "function") {
        options.onCommitted();
      }
    });
    return true;
  } catch (error) {
    console.error("分类页状态更新失败", error);
    reportCategoryFault(options.stage || "set_data", error, {
      action: "set_data",
      disposed: !isPageAlive(page),
    });
    return false;
  }
}

function beginCategoryEntryIndicator(page) {
  if (!isPageAlive(page)) return null;
  if (page._categoryEntryLoadingToken) {
    cancelPageLoading(page._categoryEntryLoadingToken);
  }
  const token = beginPageLoading(CATEGORY_ENTRY_LOADING_OPTIONS);
  page._categoryEntryLoadingToken = token;
  page._categoryEntryLoadingFinished = false;
  page._categoryEntryAwaitingImageId = "";
  page._categoryEntryAwaitingImageUrl = "";
  page._categoryEntryAwaitingImageRequestVersion = 0;
  return token;
}

function finishCategoryEntryIndicator(page, token = page._categoryEntryLoadingToken) {
  if (!token || page._categoryEntryLoadingToken !== token) return false;
  if (page._categoryEntryLoadingFinished) return false;
  page._categoryEntryLoadingFinished = true;
  page._categoryEntryAwaitingImageId = "";
  page._categoryEntryAwaitingImageUrl = "";
  page._categoryEntryAwaitingImageRequestVersion = 0;
  finishPageLoading(token);
  return true;
}

function cancelCategoryEntryIndicator(page) {
  const token = page._categoryEntryLoadingToken;
  page._categoryEntryLoadingToken = null;
  page._categoryEntryLoadingFinished = false;
  page._categoryEntryAwaitingImageId = "";
  page._categoryEntryAwaitingImageUrl = "";
  page._categoryEntryAwaitingImageRequestVersion = 0;
  if (!token) return false;
  cancelPageLoading(token);
  return true;
}

function getCategoryImageIdentity(id, url) {
  return id && url ? `${id}\n${url}` : "";
}

function rememberCategoryImageSettled(page, id, url) {
  const identity = getCategoryImageIdentity(id, url);
  if (!identity) return false;
  if (!(page._categorySettledImageIdentities instanceof Set)) {
    page._categorySettledImageIdentities = new Set();
  }
  page._categorySettledImageIdentities.add(identity);
  while (page._categorySettledImageIdentities.size > 32) {
    const oldest = page._categorySettledImageIdentities.values().next().value;
    page._categorySettledImageIdentities.delete(oldest);
  }
  return true;
}

function hasCategoryImageSettled(page, id, url) {
  const identity = getCategoryImageIdentity(id, url);
  return Boolean(
    identity
    && page._categorySettledImageIdentities instanceof Set
    && page._categorySettledImageIdentities.has(identity)
  );
}

function getVisibleCategoryEntryCard(page) {
  const cards = page && page.data && Array.isArray(page.data.visibleCards)
    ? page.data.visibleCards
    : [];
  return cards[0] || null;
}

function primeCategoryEntryFromVisibleCard(page) {
  const firstCard = getVisibleCategoryEntryCard(page);
  if (!firstCard || !firstCard.id || !firstCard.coverImageUrl) return false;
  if (hasCategoryImageSettled(page, firstCard.id, firstCard.coverImageUrl)) {
    finishCategoryEntryIndicator(page);
    return true;
  }
  page._categoryEntryAwaitingImageId = firstCard.id;
  page._categoryEntryAwaitingImageUrl = firstCard.coverImageUrl;
  page._categoryEntryAwaitingImageRequestVersion = Number(
    firstCard.entryLoadRequestVersion
  ) || 0;
  return true;
}

function prepareCategoryEntryCards(page, cards = [], imageRequestVersion = 0) {
  const token = page._categoryEntryLoadingToken;
  if (!token || page._categoryEntryLoadingFinished) return cards;
  const firstCard = Array.isArray(cards) ? cards[0] : null;
  if (firstCard && firstCard.id && firstCard.coverImageUrl) {
    page._categoryEntryAwaitingImageId = firstCard.id;
    page._categoryEntryAwaitingImageUrl = firstCard.coverImageUrl;
    page._categoryEntryAwaitingImageRequestVersion = imageRequestVersion;
    return cards.map((item, index) => index === 0
      ? { ...item, entryLoadRequestVersion: imageRequestVersion }
      : item);
  }
  page._categoryEntryAwaitingImageId = "";
  page._categoryEntryAwaitingImageUrl = "";
  page._categoryEntryAwaitingImageRequestVersion = 0;
  return cards;
}

function settleCategoryEntryAfterCards(page, cards = []) {
  const token = page._categoryEntryLoadingToken;
  if (!token || page._categoryEntryLoadingFinished) return false;
  const firstCard = Array.isArray(cards) ? cards[0] : null;
  if (firstCard && firstCard.id && firstCard.coverImageUrl) {
    if (hasCategoryImageSettled(page, firstCard.id, firstCard.coverImageUrl)) {
      return finishCategoryEntryIndicator(page, token);
    }
    return true;
  }
  return finishCategoryEntryIndicator(page, token);
}

function cachedCatalogNeedsEntryLoading(cache) {
  return Boolean(cache && cache.data && Array.isArray(cache.data.items));
}

function stopPullDownRefresh() {
  try {
    if (typeof wx !== "undefined" && typeof wx.stopPullDownRefresh === "function") {
      wx.stopPullDownRefresh();
    }
  } catch (error) {
    reportCategoryFault("stop_pull_down", error, { action: "pull_down" });
  }
}

function createFilters() {
  return DEFAULT_FILTERS.filter((filter) => FILTER_KEYS.includes(filter.key)).map((filter) => ({
    ...filter,
    title: FILTER_TITLE_OVERRIDES[filter.key] || filter.title,
    selectedValues: [],
    optionItems: filter.options.map((value) => ({
      value,
      label: filter.key === "scenes" ? getSceneLabel(value) : value,
      selected: false,
    })),
  }));
}

function createNavItems(filters) {
  return [
    { key: "sort", title: "排序", selectedText: "", optionItems: [] },
    ...filters.map((filter) => ({
      key: filter.key,
      title: filter.title,
      selectedText: "",
      optionItems: filter.optionItems,
    })),
  ];
}

function syncOptionItems(filter) {
  return {
    ...filter,
    optionItems: filter.options.map((value) => ({
      value,
      label: filter.key === "scenes" ? getSceneLabel(value) : value,
      selected: filter.selectedValues.includes(value),
    })),
  };
}

function buildSelectedFilters(filters) {
  return filters.reduce((selected, filter) => {
    if (filter.selectedValues.length) {
      selected[filter.key] = filter.selectedValues;
    }
    return selected;
  }, {});
}

function buildSelectedPills(filters, selectedSort) {
  const selectedSortOption = SORT_OPTIONS.find(
    (option) => option.key === selectedSort && option.key !== "default"
  );
  const initialPills = selectedSortOption
    ? [
        {
          id: `sort:${selectedSortOption.key}`,
          key: "sort",
          value: selectedSortOption.key,
          label: selectedSortOption.title,
          title: "排序",
        },
      ]
    : [];

  return filters.reduce((pills, filter) => {
    filter.selectedValues.forEach((value) => {
      pills.push({
        id: `${filter.key}:${value}`,
        key: filter.key,
        value,
        label: filter.key === "scenes" ? getSceneLabel(value) : value,
        title: filter.title,
      });
    });
    return pills;
  }, initialPills);
}

function summarizeTags(caseItem) {
  return [
    ...(caseItem.packageTypes || []),
    ...(caseItem.styles || []),
    caseItem.priceLevel,
  ]
    .filter(Boolean)
    .slice(0, 3)
    .join(" / ");
}

function buildCaseCards(cases) {
  return cases.map((caseItem) => ({
    ...caseItem,
    tagSummary: summarizeTags(caseItem),
  }));
}

function getCardImageFileId(caseItem = {}) {
  return (
    caseItem.imageFileId ||
    caseItem.coverBanner ||
    caseItem.coverThumbnail ||
    caseItem.coverImage ||
    ""
  );
}

function needsImageUrl(caseItem = {}) {
  return !caseItem.coverImageUrl && Boolean(getCardImageFileId(caseItem));
}

function applyCatalogImageMap(cases = [], images = {}) {
  return cases.map((caseItem) => {
    const image = caseItem.id && images[caseItem.id];
    if (!image) return caseItem;
    const currentImageFileId = getCardImageFileId(caseItem);
    if (
      image.imageFileId &&
      currentImageFileId &&
      image.imageFileId !== currentImageFileId
    ) {
      return caseItem;
    }
    const imageFileId = image.imageFileId || currentImageFileId;
    const coverImageUrl = image.thumbnailUrl || "";
    return {
      ...caseItem,
      imageFileId,
      coverImageUrl,
      imageLoadState: coverImageUrl ? "ready" : "failed",
      imageRetryCount: 0,
    };
  });
}

function isValidSortKey(sortKey) {
  return SORT_OPTIONS.some((option) => option.key === sortKey);
}

function normalizeCatalogRevision(value) {
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

function normalizeInitialSort(sortKey) {
  return isValidSortKey(sortKey) ? sortKey : "default";
}

function showLoadMoreIndicator(page) {
  if (!isPageAlive(page)) return null;
  cancelCategoryEntryIndicator(page);
  if (page._loadMoreIndicatorToken) {
    cancelPageLoading(page._loadMoreIndicatorToken);
  }
  const token = beginPageLoading(CATEGORY_LOAD_MORE_LOADING_OPTIONS);
  page._loadMoreIndicatorToken = token;
  return token;
}

function hideLoadMoreIndicator(page, token) {
  if (!page._loadMoreIndicatorToken) return;
  if (token && page._loadMoreIndicatorToken !== token) return;
  const activeToken = page._loadMoreIndicatorToken;
  page._loadMoreIndicatorToken = null;
  finishPageLoading(activeToken);
}

function cancelLoadMoreIndicator(page) {
  const token = page._loadMoreIndicatorToken;
  page._loadMoreIndicatorToken = null;
  if (!token) return false;
  cancelPageLoading(token);
  return true;
}

function takePendingCategorySort() {
  let sortKey = "";
  try {
    if (typeof getApp === "function") {
      const app = getApp();
      if (app && app.globalData && app.globalData[PENDING_CATEGORY_SORT_KEY]) {
        sortKey = app.globalData[PENDING_CATEGORY_SORT_KEY];
        app.globalData[PENDING_CATEGORY_SORT_KEY] = "";
      }
    }
  } catch (error) {
    reportCategoryFault("pending_sort_app", error, { action: "read_sort" });
  }
  try {
    if (
      !sortKey &&
      typeof wx !== "undefined" &&
      typeof wx.getStorageSync === "function"
    ) {
      sortKey = wx.getStorageSync(PENDING_CATEGORY_SORT_KEY) || "";
    }
  } catch (error) {
    reportCategoryFault("pending_sort_read", error, { action: "read_sort" });
  }
  try {
    if (typeof wx !== "undefined" && typeof wx.removeStorageSync === "function") {
      wx.removeStorageSync(PENDING_CATEGORY_SORT_KEY);
    }
  } catch (error) {
    reportCategoryFault("pending_sort_remove", error, { action: "clear_sort" });
  }
  return sortKey;
}

function isPopularCase(caseItem) {
  const statuses = caseItem.statuses || [];
  return statuses.includes("热门产品");
}

function isLatestCase(caseItem) {
  const statuses = caseItem.statuses || [];
  return statuses.includes("最新产品");
}

function resolveFocusedValue(filter, focusedFilterValue) {
  if (
    focusedFilterValue &&
    focusedFilterValue.key === filter.key &&
    filter.selectedValues.includes(focusedFilterValue.value)
  ) {
    return focusedFilterValue.value;
  }
  return filter.selectedValues[0] || "";
}

function buildActivePanel(filters, activeNavKey, selectedSort, focusedFilterValue) {
  if (activeNavKey === "sort") {
    return {
      key: "sort",
      title: "排序",
      displayTitle: "排序",
      displaySubtitle: PANEL_SUBTITLES.sort,
      type: "single",
      optionItems: SORT_OPTIONS.map((option) => ({
        value: option.key,
        title: option.title,
        selected: option.key === selectedSort,
      })),
    };
  }
  const activeFilter = filters.find((filter) => filter.key === activeNavKey) || filters[0];
  const focusedTitle = resolveFocusedValue(activeFilter, focusedFilterValue);
  const displayFocusedTitle = activeFilter.key === "scenes"
    ? getSceneLabel(focusedTitle)
    : focusedTitle;
  const showPackageNote = activeFilter.key === "packageTypes" && focusedTitle === "整套包装";
  const selectedPackageSubtitle = showPackageNote ? `(${PANEL_SUBTITLES.packageTypes})` : "";

  return {
    ...activeFilter,
    displayTitle: displayFocusedTitle || activeFilter.title,
    showPackageNote,
    displaySubtitle: focusedTitle
      ? activeFilter.key === "packageTypes"
        ? selectedPackageSubtitle
        : PANEL_SUBTITLES[activeFilter.key] || `按${activeFilter.title}查看产品与案例`
      : `按${activeFilter.title}查看产品与案例`,
  };
}

function buildEmptyMessage(activePanel, query) {
  const keyword = String(query || "").trim();
  if (keyword) return `没有找到与“${keyword}”匹配的案例，换个关键词试试`;
  const displayTitle = activePanel && activePanel.displayTitle;
  if (!displayTitle || activePanel.key === "sort") return "暂无匹配案例，换个条件试试";
  return `暂无“${displayTitle}”案例，换个条件试试`;
}

function buildNavItems(filters, selectedSort, expandedNavKey) {
  return createNavItems(filters).map((item) => {
    if (item.key === "sort") {
      const selectedOption = SORT_OPTIONS.find((option) => option.key === selectedSort);
      return {
        ...item,
        expanded: expandedNavKey === item.key,
        selectedText: selectedOption ? selectedOption.title : "",
        optionItems: SORT_OPTIONS.map((option) => ({
          value: option.key,
          title: option.title,
          selected: option.key === selectedSort,
        })),
      };
    }

    const filter = filters.find((entry) => entry.key === item.key);
    return {
      ...item,
      expanded: expandedNavKey === item.key,
      optionItems: filter ? filter.optionItems : [],
      selectedText: filter && filter.selectedValues.length ? `${filter.selectedValues.length}` : "",
    };
  });
}

Page({
  data: {
    loading: true,
    errorMessage: "",
    query: "",
    selectedSort: "default",
    activeNavKey: "packageTypes",
    expandedNavKey: "packageTypes",
    filteredCount: 0,
    visibleCards: [],
    isLoadingMore: false,
    filters: createFilters(),
    navItems: [],
    activePanel: null,
    emptyMessage: "暂无匹配案例，换个条件试试",
    selectedPills: [],
    selectedCount: 0,
    focusedFilterValue: null,
    caseDataVersion: 0,
  },

  onLoad(options = {}) {
    options = options || {};
    this._alive = true;
    this._dataRequestVersion = 0;
    this._loadPromise = null;
    this._allCases = [];
    this._filteredCases = [];
    this._displayLimit = CARD_PAGE_SIZE;
    this._imageRequestVersion = 0;
    this._loadMoreIndicatorToken = null;
    this._categoryEntryLoadingToken = null;
    this._categoryEntryLoadingFinished = false;
    this._categoryEntryAwaitingImageId = "";
    this._categoryEntryAwaitingImageUrl = "";
    this._categoryEntryAwaitingImageRequestVersion = 0;
    this._categorySettledImageIdentities = new Set();
    this._catalogImageCache = {};
    this._catalogImageEndpointAvailable = true;
    this._searchTimer = null;
    this._catalogCache = readCache(CATALOG_CACHE_KEY);
    if (cachedCatalogNeedsEntryLoading(this._catalogCache)) {
      beginCategoryEntryIndicator(this);
    }
    const initialSort = normalizeInitialSort(options.sort || takePendingCategorySort());
    this.applySortFromEntry(initialSort);
    this.refreshPanels();
    if (this._catalogCache) {
      this.applyCatalogItems(this._catalogCache.data.items || [], {
        revision: this._catalogCache.revision,
      });
    }
    return this.loadData({ silent: Boolean(this._catalogCache) });
  },

  onShow() {
    if (!isPageAlive(this)) return Promise.resolve({ ok: false, cancelled: true });
    if (
      !this._categoryEntryLoadingToken
      && (this._loadPromise || this.data.loading)
    ) {
      beginCategoryEntryIndicator(this);
      primeCategoryEntryFromVisibleCard(this);
    }
    const pendingSort = normalizeInitialSort(takePendingCategorySort());
    if (pendingSort !== "default") {
      this.applySortFromEntry(pendingSort);
      if (this._allCases && this._allCases.length) {
        this.applyFilters();
      } else {
        this.refreshPanels();
      }
    }
    if (!this.data.loading && shouldRefreshCaseData(this.data.caseDataVersion)) {
      return this.loadData({ silent: true, forceRefresh: true });
    }
    return this._loadPromise || Promise.resolve({ ok: true, skipped: true });
  },

  onHide() {
    cancelCategoryEntryIndicator(this);
    cancelLoadMoreIndicator(this);
  },

  onPullDownRefresh() {
    return this.loadData({ forceRefresh: true, pageLoading: false }).then(
      (result) => {
        stopPullDownRefresh();
        return result;
      },
      (error) => {
        stopPullDownRefresh();
        reportCategoryFault("pull_down", error, { action: "pull_down" });
        return { ok: false, error };
      }
    );
  },

  retryLoadData() {
    if (!isPageAlive(this)) {
      return Promise.resolve({ ok: false, status: "stale", cancelled: true });
    }
    return this.loadData({ forceRefresh: true });
  },

  onShareAppMessage() {
    return {
      title: CATEGORY_SHARE_TITLE,
      path: "/pages/category/index",
    };
  },

  onShareTimeline() {
    return {
      title: CATEGORY_SHARE_TITLE,
    };
  },

  onUnload() {
    this._alive = false;
    this._dataRequestVersion = Number(this._dataRequestVersion || 0) + 1;
    this._loadPromise = null;
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = null;
    this._imageRequestVersion += 1;
    cancelCategoryEntryIndicator(this);
    cancelLoadMoreIndicator(this);
  },

  applyCatalogItems(items, options = {}) {
    if (!isCurrentDataRequest(this, options.dataRequestVersion)) return false;
    if (!Array.isArray(items)) {
      reportCategoryFault("catalog_items_validate", null, {
        code: "CATALOG_INVALID_ITEMS",
        action: "apply_catalog",
      });
      items = [];
    }
    this._allCases = items;
    const committed = safeSetData(this, {
      caseDataVersion: getCaseDataVersion(),
      catalogRevision: normalizeCatalogRevision(options.revision),
      loading: false,
      errorMessage: "",
    }, {
      dataRequestVersion: options.dataRequestVersion,
      stage: "apply_catalog",
    });
    if (!committed) return false;
    return this.applyFilters();
  },

  loadData(options = {}) {
    options = options || {};
    if (!isPageAlive(this)) {
      return Promise.resolve(normalizeLoadResult({ ok: false, cancelled: true }));
    }
    if (this._loadPromise && !options.forceRefresh) {
      return this._loadPromise;
    }
    const requestVersion = Number(this._dataRequestVersion || 0) + 1;
    this._dataRequestVersion = requestVersion;

    if (!options.silent && options.pageLoading !== false) {
      beginCategoryEntryIndicator(this);
    }

    if (!options.silent) {
      safeSetData(this, {
        loading: true,
        errorMessage: "",
      }, {
        dataRequestVersion: requestVersion,
        stage: "load_start",
      });
    } else if (this.data.errorMessage) {
      safeSetData(this, {
        errorMessage: "",
      }, {
        dataRequestVersion: requestVersion,
        stage: "load_start",
      });
    }

    const safePromise = Promise.resolve()
      .then(() => this.performLoadData(options, requestVersion))
      .catch((error) => {
        if (!isCurrentDataRequest(this, requestVersion)) {
          return { ok: false, cancelled: true };
        }
        console.error("分类数据读取失败", error);
        reportCategoryFault("load_unexpected", error, { action: "load_catalog" });
        safeSetData(this, {
          loading: false,
          errorMessage: "暂时读取不到案例数据，请检查云环境和数据库权限。",
        }, {
          dataRequestVersion: requestVersion,
          stage: "load_unexpected",
          onCommitted: () => finishCategoryEntryIndicator(this),
        });
        return { ok: false, error };
      })
      .then(normalizeLoadResult);
    this._loadPromise = safePromise;
    safePromise.then(() => {
      if (this._loadPromise === safePromise) this._loadPromise = null;
    });
    return safePromise;
  },

  async performLoadData(options, requestVersion) {
    try {
      const cachedRevision = this._catalogCache
        ? normalizeCatalogRevision(this._catalogCache.revision)
        : 0;
      const knownRevision = !options.forceRefresh && cachedRevision > 0
        ? cachedRevision
        : undefined;
      let result;
      try {
        result = await fetchCatalogSnapshot({ knownRevision });
      } catch (catalogError) {
        if (!isCurrentDataRequest(this, requestVersion)) {
          return { ok: false, cancelled: true };
        }
        if (!isLegacyCatalogFallbackAllowed(catalogError)) {
          throw catalogError;
        }
        console.warn("分类聚合接口不可用，使用兼容读取", catalogError);
        reportCategoryFault("catalog_fallback", catalogError, {
          action: "load_catalog",
          requestKind: "fallback",
          fallbackUsed: true,
        });
        const cases = await fetchVisibleCases({
          includeImageUrls: false,
          forceRefresh: options.forceRefresh,
        });
        if (!isCurrentDataRequest(this, requestVersion)) {
          return { ok: false, cancelled: true };
        }
        if (!Array.isArray(cases)) {
          const error = new Error("分类兼容接口返回数据异常");
          error.code = "INVALID_FALLBACK_ITEMS";
          throw error;
        }
        result = {
          revision: normalizeCatalogRevision(getCaseDataVersion()),
          notModified: false,
          items: cases,
        };
      }
      if (!isCurrentDataRequest(this, requestVersion)) {
        return { ok: false, cancelled: true };
      }
      if (!result || typeof result !== "object") {
        const error = new Error("分类聚合接口返回数据异常");
        error.code = "CATALOG_INVALID_RESULT";
        throw error;
      }
      if (result.notModified && this._catalogCache) {
        const applied = this.applyCatalogItems(this._catalogCache.data.items, {
          revision: result.revision,
          dataRequestVersion: requestVersion,
        });
        return applied
          ? { ok: true, notModified: true }
          : { ok: false, cancelled: true };
      }
      if (result.notModified) {
        const error = new Error("分类目录未返回内容，且本地没有可用缓存");
        error.code = "CATALOG_NOT_MODIFIED_WITHOUT_CACHE";
        throw error;
      }
      if (!Array.isArray(result.items)) {
        const error = new Error("分类聚合数据缺少案例列表");
        error.code = "CATALOG_INVALID_ITEMS";
        throw error;
      }
      const items = result.items;
      if (!isCurrentDataRequest(this, requestVersion)) {
        return { ok: false, cancelled: true };
      }
      const nextCache = {
        revision: normalizeCatalogRevision(result.revision),
        cachedAt: Date.now(),
        fresh: true,
        data: { items },
      };
      const applied = this.applyCatalogItems(items, {
        revision: result.revision,
        dataRequestVersion: requestVersion,
      });
      if (applied && isCurrentDataRequest(this, requestVersion)) {
        this._catalogCache = nextCache;
        setTimeout(() => {
          if (!isCurrentDataRequest(this, requestVersion)) return;
          if (typeof catalogCache.writeCacheAsync === "function") {
            void catalogCache.writeCacheAsync(
              CATALOG_CACHE_KEY,
              result.revision,
              { items }
            );
            return;
          }
          writeCache(CATALOG_CACHE_KEY, result.revision, { items });
        }, 0);
      }
      return applied
        ? { ok: true, notModified: false }
        : { ok: false, cancelled: true };
    } catch (error) {
      if (!isCurrentDataRequest(this, requestVersion)) {
        return { ok: false, cancelled: true };
      }
      console.error("分类数据读取失败", error);
      reportCategoryFault("load_catalog", error, {
        action: "load_catalog",
        cacheState: this._catalogCache ? "fallback" : "miss",
        fallbackUsed: Boolean(this._catalogCache),
      });
      if (this._catalogCache) {
        const applied = this.applyCatalogItems(this._catalogCache.data.items, {
          revision: this._catalogCache.revision,
          dataRequestVersion: requestVersion,
        });
        return { ok: false, cached: applied, error };
      }
      safeSetData(this, {
        loading: false,
        errorMessage: "暂时读取不到案例数据，请检查云环境和数据库权限。",
      }, {
        dataRequestVersion: requestVersion,
        stage: "load_error",
        onCommitted: () => finishCategoryEntryIndicator(this),
      });
      return { ok: false, error };
    }
  },

  refreshPanels() {
    if (!isPageAlive(this)) return false;
    const activePanel = buildActivePanel(
      this.data.filters,
      this.data.activeNavKey,
      this.data.selectedSort,
      this.data.focusedFilterValue
    );
    return safeSetData(this, {
      selectedPills: buildSelectedPills(
        this.data.filters,
        this.data.selectedSort
      ),
      navItems: buildNavItems(
        this.data.filters,
        this.data.selectedSort,
        this.data.expandedNavKey
      ),
      activePanel,
      emptyMessage: buildEmptyMessage(activePanel, this.data.query),
    }, {
      stage: "refresh_panels",
    });
  },

  applySortFromEntry(sortKey) {
    if (sortKey === "default") return true;
    return safeSetData(this, {
      selectedSort: sortKey,
      activeNavKey: "sort",
      expandedNavKey: "sort",
    }, {
      stage: "apply_sort",
    });
  },

  applyFilters() {
    if (!isPageAlive(this)) return false;
    cancelLoadMoreIndicator(this);
    try {
      const selectedFilters = buildSelectedFilters(this.data.filters);
      const filteredCases = filterCases(
        Array.isArray(this._allCases) ? this._allCases : [],
        {
          query: this.data.query,
          selectedFilters,
          pinnedFirst: this.data.selectedSort === "default",
        }
      );
      const sortedCases =
        this.data.selectedSort === "latest"
          ? filteredCases
              .filter(isLatestCase)
              .sort((a, b) => Number(b.sortOrder || 0) - Number(a.sortOrder || 0))
          : this.data.selectedSort === "popular"
            ? filteredCases.filter(isPopularCase)
            : filteredCases;

      this._filteredCases = buildCaseCards(sortedCases);
      this._displayLimit = CARD_PAGE_SIZE;
      const committed = safeSetData(this, {
        filteredCount: this._filteredCases.length,
        selectedCount: selectedFilterCount(selectedFilters),
      }, {
        stage: "apply_filters",
      });
      if (!committed) return false;
      this.refreshPanels();
      void this.refreshVisibleCards();
      return true;
    } catch (error) {
      console.error("分类条件处理失败", error);
      reportCategoryFault("apply_filters", error, { action: "filter_catalog" });
      safeSetData(this, {
        filteredCount: 0,
        visibleCards: [],
        isLoadingMore: false,
      }, {
        stage: "apply_filters_error",
        onCommitted: () => finishCategoryEntryIndicator(this),
      });
      return false;
    }
  },

  refreshVisibleCards(options = {}) {
    options = options || {};
    if (!isPageAlive(this)) {
      return Promise.resolve({ ok: false, cancelled: true });
    }
    const requestVersion = Number(this._imageRequestVersion || 0) + 1;
    this._imageRequestVersion = requestVersion;
    const currentCards = Array.isArray(this.data.visibleCards)
      ? this.data.visibleCards
      : [];
    const filteredCases = Array.isArray(this._filteredCases)
      ? this._filteredCases
      : [];
    const start = options.append ? currentCards.length : 0;
    const sourceCards = filteredCases.slice(start, this._displayLimit);
    safeSetData(this, { isLoadingMore: true }, {
      imageRequestVersion: requestVersion,
      stage: "image_load_start",
    });

    let hydrationPromise;
    try {
      hydrationPromise = this.hydrateVisibleCardImages(sourceCards, requestVersion);
    } catch (error) {
      hydrationPromise = Promise.reject(error);
    }
    return Promise.resolve(hydrationPromise)
      .then((visibleCards) => {
        if (!isCurrentImageRequest(this, requestVersion)) {
          return { ok: false, cancelled: true };
        }
        if (!options.append) {
          const entryCards = prepareCategoryEntryCards(
            this,
            visibleCards,
            requestVersion
          );
          const committed = safeSetData(this, {
            visibleCards: entryCards,
            isLoadingMore: false,
          }, {
            imageRequestVersion: requestVersion,
            stage: "image_load_complete",
            onCommitted: () => settleCategoryEntryAfterCards(this, entryCards),
          });
          return { ok: committed, cards: entryCards };
        }
        const patch = { isLoadingMore: false };
        visibleCards.forEach((item, index) => {
          patch[`visibleCards[${start + index}]`] = item;
        });
        const committed = safeSetData(this, patch, {
          imageRequestVersion: requestVersion,
          stage: "image_append_complete",
        });
        return { ok: committed, cards: visibleCards };
      })
      .catch((error) => {
        if (!isCurrentImageRequest(this, requestVersion)) {
          return { ok: false, cancelled: true };
        }
        console.warn("分类图片链接读取失败", error);
        reportCategoryFault("image_hydration", error, {
          action: "load_images",
          fallbackUsed: true,
        });
        const failedCards = sourceCards.map((item) => ({
          ...item,
          coverImageUrl: "",
          imageLoadState: "failed",
        }));
        if (!options.append) {
          const entryCards = prepareCategoryEntryCards(
            this,
            failedCards,
            requestVersion
          );
          safeSetData(this, {
            visibleCards: entryCards,
            isLoadingMore: false,
          }, {
            imageRequestVersion: requestVersion,
            stage: "image_load_error",
            onCommitted: () => settleCategoryEntryAfterCards(this, entryCards),
          });
          return { ok: false, cards: entryCards, error };
        }
        const patch = { isLoadingMore: false };
        failedCards.forEach((item, index) => {
          patch[`visibleCards[${start + index}]`] = item;
        });
        safeSetData(this, patch, {
          imageRequestVersion: requestVersion,
          stage: "image_append_error",
        });
        return { ok: false, cards: failedCards, error };
      });
  },

  rememberCatalogImages(cards = [], requestVersion) {
    if (!isCurrentImageRequest(this, requestVersion)) return false;
    if (!this._catalogImageCache || typeof this._catalogImageCache !== "object") {
      this._catalogImageCache = {};
    }
    cards.forEach((item) => {
      const imageFileId = getCardImageFileId(item);
      if (!item.id || !imageFileId || !item.coverImageUrl) return;
      this._catalogImageCache[item.id] = {
        imageFileId,
        thumbnailUrl: item.coverImageUrl,
      };
    });
    return true;
  },

  async hydrateVisibleCardImages(sourceCards = [], requestVersion) {
    const imageCache =
      this._catalogImageCache && typeof this._catalogImageCache === "object"
        ? this._catalogImageCache
        : {};
    let cards = applyCatalogImageMap(sourceCards, imageCache);
    let missingCards = cards.filter(needsImageUrl);
    if (!missingCards.length) return cards;
    let allowLegacyImageFallback = !this._catalogImageEndpointAvailable;

    if (this._catalogImageEndpointAvailable) {
      try {
        const images = await fetchCatalogImageUrls(
          missingCards.map((item) => item.id).filter(Boolean)
        );
        if (!isCurrentImageRequest(this, requestVersion)) return cards;
        const safeImages =
          images && typeof images === "object" && !Array.isArray(images)
            ? images
            : {};
        this._catalogImageCache = {
          ...this._catalogImageCache,
          ...safeImages,
        };
        cards = applyCatalogImageMap(cards, safeImages);
      } catch (error) {
        if (!isCurrentImageRequest(this, requestVersion)) return cards;
        if (!isLegacyCatalogFallbackAllowed(error)) throw error;
        this._catalogImageEndpointAvailable = false;
        allowLegacyImageFallback = true;
        console.warn("分类图片批量接口不可用，使用兼容读取", error);
      }
    }

    const missingIndexes = [];
    missingCards = [];
    cards.forEach((item, index) => {
      if (!needsImageUrl(item)) return;
      missingIndexes.push(index);
      missingCards.push(item);
    });
    if (!missingCards.length) {
      this.rememberCatalogImages(cards, requestVersion);
      return cards;
    }
    if (!allowLegacyImageFallback) {
      return cards.map((item) => needsImageUrl(item)
        ? { ...item, coverImageUrl: "", imageLoadState: "failed" }
        : item);
    }

    const fallbackCards = await attachCaseImageUrls(missingCards, {
      preferBanner: true,
    });
    if (!isCurrentImageRequest(this, requestVersion)) return cards;
    if (!Array.isArray(fallbackCards)) {
      const error = new Error("分类图片兼容接口返回数据异常");
      error.code = "INVALID_IMAGE_FALLBACK";
      throw error;
    }
    missingIndexes.forEach((cardIndex, index) => {
      if (fallbackCards[index]) cards[cardIndex] = fallbackCards[index];
    });
    this.rememberCatalogImages(cards, requestVersion);
    return cards;
  },

  async loadMore() {
    if (!isPageAlive(this)) return false;
    const filteredCases = Array.isArray(this._filteredCases)
      ? this._filteredCases
      : [];
    const visibleCards = Array.isArray(this.data.visibleCards)
      ? this.data.visibleCards
      : [];
    if (
      this.data.isLoadingMore ||
      visibleCards.length >= filteredCases.length
    ) return false;
    const indicatorToken = showLoadMoreIndicator(this);
    this._displayLimit += CARD_PAGE_SIZE;
    try {
      await this.refreshVisibleCards({ append: true });
      return true;
    } catch (error) {
      reportCategoryFault("load_more", error, { action: "load_more" });
      return false;
    } finally {
      hideLoadMoreIndicator(this, indicatorToken);
    }
  },

  onCardImageLoad(event) {
    if (!isPageAlive(this)) return false;
    const target = event && event.currentTarget ? event.currentTarget : {};
    const id = target.dataset && target.dataset.id;
    const currentCard = Array.isArray(this.data.visibleCards)
      ? this.data.visibleCards.find((item) => item && item.id === id)
      : null;
    const imageUrl = target.dataset && target.dataset.url
      ? target.dataset.url
      : currentCard && currentCard.coverImageUrl || "";
    const imageRequestVersion = Number(
      target.dataset && target.dataset.entryLoadRequestVersion
    );
    rememberCategoryImageSettled(this, id, imageUrl);
    if (
      !id
      || id !== this._categoryEntryAwaitingImageId
      || (
        this._categoryEntryAwaitingImageUrl
        && imageUrl !== this._categoryEntryAwaitingImageUrl
      )
      || (
        this._categoryEntryAwaitingImageRequestVersion
        && imageRequestVersion
        && imageRequestVersion !== this._categoryEntryAwaitingImageRequestVersion
      )
    ) return false;
    return finishCategoryEntryIndicator(this);
  },

  async retryCardImage(event) {
    if (!isPageAlive(this)) return false;
    this.onCardImageLoad(event);
    const requestVersion = this._imageRequestVersion;
    const target = event && event.currentTarget ? event.currentTarget : {};
    const dataset = target.dataset || {};
    const id = dataset.id;
    const visibleCards = Array.isArray(this.data.visibleCards)
      ? this.data.visibleCards
      : [];
    const card = visibleCards.find((item) => item.id === id);
    if (!card || !card.imageFileId) return false;
    const retryCount = Number(card.imageRetryCount || 0);
    const manualRetry = dataset.manual === true;
    if (retryCount >= 1 && !manualRetry) return false;
    console.warn("案例图片加载失败", {
      caseId: card.id,
      error: event && event.detail && event.detail.errMsg,
    });
    try {
      const coverImageUrl = await refreshImageUrl(card.imageFileId);
      if (!isCurrentImageRequest(this, requestVersion)) return false;
      const currentCards = Array.isArray(this.data.visibleCards)
        ? this.data.visibleCards
        : [];
      const index = currentCards.findIndex((item) => item.id === id);
      if (index === -1) return false;
      return safeSetData(this, {
        [`visibleCards[${index}].coverImageUrl`]: coverImageUrl,
        [`visibleCards[${index}].imageRetryCount`]: manualRetry ? 0 : retryCount + 1,
        [`visibleCards[${index}].imageLoadState`]: coverImageUrl ? "retrying" : "failed",
      }, {
        imageRequestVersion: requestVersion,
        stage: "image_retry_complete",
      });
    } catch (error) {
      if (!isCurrentImageRequest(this, requestVersion)) return false;
      reportCategoryFault("image_retry", error, { action: "retry_image" });
      const currentCards = Array.isArray(this.data.visibleCards)
        ? this.data.visibleCards
        : [];
      const index = currentCards.findIndex((item) => item.id === id);
      if (index === -1) return false;
      return safeSetData(this, {
        [`visibleCards[${index}].coverImageUrl`]: "",
        [`visibleCards[${index}].imageRetryCount`]: retryCount + 1,
        [`visibleCards[${index}].imageLoadState`]: "failed",
      }, {
        imageRequestVersion: requestVersion,
        stage: "image_retry_error",
      });
    }
  },

  onSearchInput(event) {
    if (!isPageAlive(this)) return;
    safeSetData(this, {
      query: event && event.detail ? event.detail.value : "",
    }, {
      stage: "search_input",
    });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      if (!isPageAlive(this)) return;
      this.applyFilters();
    }, SEARCH_DEBOUNCE_MS);
  },

  selectNav(event) {
    if (!isPageAlive(this)) return;
    const key = event.currentTarget.dataset.key;
    const expandedNavKey = this.data.expandedNavKey === key ? "" : key;
    safeSetData(this, {
      activeNavKey: key,
      expandedNavKey,
    }, {
      stage: "select_nav",
    });
    this.refreshPanels();
  },

  selectSort(event) {
    if (!isPageAlive(this)) return;
    const value = event.currentTarget.dataset.value;
    safeSetData(this, {
      selectedSort: value,
    }, {
      stage: "select_sort",
    });
    this.applyFilters();
  },

  toggleFilterOption(event) {
    if (!isPageAlive(this)) return;
    const { key, value } = event.currentTarget.dataset;
    let focusedFilterValue = this.data.focusedFilterValue;
    const filters = this.data.filters.map((filter) => {
      if (filter.key !== key) return filter;

      const exists = filter.selectedValues.includes(value);
      const selectedValues =
        filter.type === "single"
          ? exists
            ? []
            : [value]
          : exists
            ? filter.selectedValues.filter((item) => item !== value)
            : [...filter.selectedValues, value];

      if (!exists) {
        focusedFilterValue = { key, value };
      } else if (
        focusedFilterValue &&
        focusedFilterValue.key === key &&
        focusedFilterValue.value === value
      ) {
        focusedFilterValue = selectedValues.length ? { key, value: selectedValues[0] } : null;
      }

      return syncOptionItems({
        ...filter,
        selectedValues,
      });
    });

    safeSetData(this, { filters, focusedFilterValue }, {
      stage: "toggle_filter",
    });
    this.applyFilters();
  },

  removeSelectedPill(event) {
    if (!isPageAlive(this)) return;
    const { key, value } = event.currentTarget.dataset;
    if (key === "sort") {
      safeSetData(this, { selectedSort: "default" }, {
        stage: "remove_sort",
      });
      this.applyFilters();
      return;
    }

    let focusedFilterValue = this.data.focusedFilterValue;
    const filters = this.data.filters.map((filter) => {
      if (filter.key !== key) return filter;
      const selectedValues = filter.selectedValues.filter((item) => item !== value);
      if (
        focusedFilterValue &&
        focusedFilterValue.key === key &&
        focusedFilterValue.value === value
      ) {
        focusedFilterValue = selectedValues.length ? { key, value: selectedValues[0] } : null;
      }
      return syncOptionItems({
        ...filter,
        selectedValues,
      });
    });
    safeSetData(this, { filters, focusedFilterValue }, {
      stage: "remove_filter",
    });
    this.applyFilters();
  },

  clearFilters() {
    if (!isPageAlive(this)) return;
    const filters = createFilters();
    safeSetData(this, {
      query: "",
      selectedSort: "default",
      activeNavKey: "packageTypes",
      expandedNavKey: "packageTypes",
      filters,
      focusedFilterValue: null,
    }, {
      stage: "clear_filters",
    });
    this.applyFilters();
  },

  navigateToCase(event) {
    if (!isPageAlive(this)) return;
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    try {
      wx.navigateTo({
        url: `/pages/detail/index?id=${encodeURIComponent(id)}`,
        fail: (error) => {
          reportCategoryFault("navigate_detail", error, { action: "navigate" });
        },
      });
    } catch (error) {
      reportCategoryFault("navigate_detail", error, { action: "navigate" });
    }
  },
});
