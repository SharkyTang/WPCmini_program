const {
  DEFAULT_FILTERS,
  filterCases,
  selectedFilterCount,
} = require("../../utils/caseData");
const { attachCaseImageUrls, fetchVisibleCases, refreshImageUrl } = require("../../utils/cloudData");
const { fetchCatalogSnapshot } = require("../../utils/caseCatalogService");
const {
  CATALOG_CACHE_KEY,
  readCache,
  writeCache,
} = require("../../utils/catalogCache");
const {
  getCaseDataVersion,
  shouldRefreshCaseData,
} = require("../../utils/caseRefresh");

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
const PANEL_SUBTITLES = {
  sort: "选择案例排序方式",
  wineType: "按酒类查看产品与案例",
  packageTypes: "包含: 瓶标/酒瓶/酒盒/手提袋/外箱",
  styles: "按设计风格查看产品与案例",
  priceLevel: "按价位感查看产品与案例",
  scenes: "按使用场景查看产品与案例",
};

function createFilters() {
  return DEFAULT_FILTERS.filter((filter) => FILTER_KEYS.includes(filter.key)).map((filter) => ({
    ...filter,
    title: FILTER_TITLE_OVERRIDES[filter.key] || filter.title,
    selectedValues: [],
    optionItems: filter.options.map((value) => ({
      value,
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

function buildSelectedPills(filters) {
  return filters.reduce((pills, filter) => {
    filter.selectedValues.forEach((value) => {
      pills.push({
        id: `${filter.key}:${value}`,
        key: filter.key,
        value,
        title: filter.title,
      });
    });
    return pills;
  }, []);
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

function isValidSortKey(sortKey) {
  return SORT_OPTIONS.some((option) => option.key === sortKey);
}

function normalizeInitialSort(sortKey) {
  return isValidSortKey(sortKey) ? sortKey : "default";
}

function takePendingCategorySort() {
  let sortKey = "";
  if (typeof getApp === "function") {
    const app = getApp();
    if (app && app.globalData && app.globalData[PENDING_CATEGORY_SORT_KEY]) {
      sortKey = app.globalData[PENDING_CATEGORY_SORT_KEY];
      app.globalData[PENDING_CATEGORY_SORT_KEY] = "";
    }
  }
  if (!sortKey && wx.getStorageSync) {
    sortKey = wx.getStorageSync(PENDING_CATEGORY_SORT_KEY) || "";
  }
  if (wx.removeStorageSync) {
    wx.removeStorageSync(PENDING_CATEGORY_SORT_KEY);
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
  const showPackageNote = activeFilter.key === "packageTypes" && focusedTitle === "整套包装";
  const selectedPackageSubtitle = showPackageNote ? `(${PANEL_SUBTITLES.packageTypes})` : "";

  return {
    ...activeFilter,
    displayTitle: focusedTitle || activeFilter.title,
    showPackageNote,
    displaySubtitle: focusedTitle
      ? activeFilter.key === "packageTypes"
        ? selectedPackageSubtitle
        : PANEL_SUBTITLES[activeFilter.key] || `按${activeFilter.title}查看产品与案例`
      : `按${activeFilter.title}查看产品与案例`,
  };
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
    selectedPills: [],
    selectedCount: 0,
    focusedFilterValue: null,
    caseDataVersion: 0,
  },

  onLoad(options = {}) {
    this._allCases = [];
    this._filteredCases = [];
    this._displayLimit = CARD_PAGE_SIZE;
    this._imageRequestVersion = 0;
    this._searchTimer = null;
    this._catalogCache = readCache(CATALOG_CACHE_KEY);
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
      this.loadData({ silent: true, forceRefresh: true });
    }
  },

  onPullDownRefresh() {
    this.loadData({ forceRefresh: true }).finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
  },

  applyCatalogItems(items, options = {}) {
    this._allCases = items || [];
    this.setData({
      caseDataVersion: getCaseDataVersion(),
      catalogRevision: Number(options.revision) || 1,
      loading: false,
      errorMessage: "",
    });
    this.applyFilters();
  },

  async loadData(options = {}) {
    if (!options.silent) {
      this.setData({
        loading: true,
        errorMessage: "",
      });
    } else {
      this.setData({
        errorMessage: "",
      });
    }

    try {
      const knownRevision =
        !options.forceRefresh && this._catalogCache && this._catalogCache.fresh
          ? this._catalogCache.revision
          : undefined;
      let result;
      try {
        result = await fetchCatalogSnapshot({ knownRevision });
      } catch (catalogError) {
        console.warn("分类聚合接口不可用，使用兼容读取", catalogError);
        const cases = await fetchVisibleCases({
          includeImageUrls: false,
          forceRefresh: options.forceRefresh,
        });
        result = {
          revision: getCaseDataVersion() || 1,
          notModified: false,
          items: cases,
        };
      }
      if (result.notModified && this._catalogCache) {
        this.applyCatalogItems(this._catalogCache.data.items || [], {
          revision: result.revision,
        });
        return;
      }
      const items = result.items || [];
      this._catalogCache = {
        revision: result.revision,
        cachedAt: Date.now(),
        fresh: true,
        data: { items },
      };
      writeCache(CATALOG_CACHE_KEY, result.revision, { items });
      this.applyCatalogItems(items, { revision: result.revision });
    } catch (error) {
      console.error("分类数据读取失败", error);
      if (this._catalogCache) {
        this.applyCatalogItems(this._catalogCache.data.items || [], {
          revision: this._catalogCache.revision,
        });
        return;
      }
      this.setData({
        loading: false,
        errorMessage: "暂时读取不到案例数据，请检查云环境和数据库权限。",
      });
    }
  },

  refreshPanels() {
    this.setData({
      navItems: buildNavItems(
        this.data.filters,
        this.data.selectedSort,
        this.data.expandedNavKey
      ),
      activePanel: buildActivePanel(
        this.data.filters,
        this.data.activeNavKey,
        this.data.selectedSort,
        this.data.focusedFilterValue
      ),
    });
  },

  applySortFromEntry(sortKey) {
    if (sortKey === "default") return;
    this.setData({
      selectedSort: sortKey,
      activeNavKey: "sort",
      expandedNavKey: "sort",
    });
  },

  applyFilters() {
    const selectedFilters = buildSelectedFilters(this.data.filters);
    const filteredCases = filterCases(this._allCases || [], {
      query: this.data.query,
      selectedFilters,
      pinnedFirst: this.data.selectedSort === "default",
    });
    const sortedCases =
      this.data.selectedSort === "latest"
        ? filteredCases.filter(isLatestCase).sort((a, b) => b.sortOrder - a.sortOrder)
        : this.data.selectedSort === "popular"
          ? filteredCases.filter(isPopularCase)
          : filteredCases;

    this._filteredCases = buildCaseCards(sortedCases);
    this._displayLimit = CARD_PAGE_SIZE;
    this.setData({
      filteredCount: this._filteredCases.length,
      selectedPills: buildSelectedPills(this.data.filters),
      selectedCount: selectedFilterCount(selectedFilters),
    });
    this.refreshPanels();
    this.refreshVisibleCards();
  },

  async refreshVisibleCards(options = {}) {
    const requestVersion = this._imageRequestVersion + 1;
    this._imageRequestVersion = requestVersion;
    const start = options.append ? this.data.visibleCards.length : 0;
    const sourceCards = this._filteredCases.slice(start, this._displayLimit);
    this.setData({ isLoadingMore: true });
    try {
      const alreadyHydrated = sourceCards.every(
        (item) =>
          item.coverImageUrl ||
          !(item.imageFileId || item.coverThumbnail || item.coverImage)
      );
      const visibleCards = alreadyHydrated
        ? sourceCards
        : await attachCaseImageUrls(sourceCards, { preferThumbnail: true });
      if (this._imageRequestVersion !== requestVersion) return;
      if (!options.append) {
        this.setData({ visibleCards, isLoadingMore: false });
        return;
      }
      const patch = { isLoadingMore: false };
      visibleCards.forEach((item, index) => {
        patch[`visibleCards[${start + index}]`] = item;
      });
      this.setData(patch);
    } catch (error) {
      console.warn("分类图片链接读取失败", error);
      if (this._imageRequestVersion === requestVersion) {
        const failedCards = sourceCards.map((item) => ({
          ...item,
          coverImageUrl: "",
          imageLoadState: "failed",
        }));
        if (!options.append) {
          this.setData({ visibleCards: failedCards, isLoadingMore: false });
          return;
        }
        const patch = { isLoadingMore: false };
        failedCards.forEach((item, index) => {
          patch[`visibleCards[${start + index}]`] = item;
        });
        this.setData(patch);
      }
    }
  },

  loadMore() {
    if (
      this.data.isLoadingMore ||
      this.data.visibleCards.length >= this._filteredCases.length
    ) return;
    this._displayLimit += CARD_PAGE_SIZE;
    this.refreshVisibleCards({ append: true });
  },

  async retryCardImage(event) {
    const id = event.currentTarget.dataset.id;
    const card = this.data.visibleCards.find((item) => item.id === id);
    if (!card || !card.imageFileId) return;
    const retryCount = Number(card.imageRetryCount || 0);
    const manualRetry = event.currentTarget.dataset.manual === true;
    if (retryCount >= 1 && !manualRetry) return;
    console.warn("案例图片加载失败", { caseId: card.id, fileId: card.imageFileId, error: event.detail && event.detail.errMsg });
    try {
      const coverImageUrl = await refreshImageUrl(card.imageFileId);
      const index = this.data.visibleCards.findIndex((item) => item.id === id);
      if (index === -1) return;
      this.setData({
        [`visibleCards[${index}].coverImageUrl`]: coverImageUrl,
        [`visibleCards[${index}].imageRetryCount`]: manualRetry ? 0 : retryCount + 1,
        [`visibleCards[${index}].imageLoadState`]: coverImageUrl ? "retrying" : "failed",
      });
    } catch (error) {
      const index = this.data.visibleCards.findIndex((item) => item.id === id);
      if (index === -1) return;
      this.setData({
        [`visibleCards[${index}].coverImageUrl`]: "",
        [`visibleCards[${index}].imageRetryCount`]: retryCount + 1,
        [`visibleCards[${index}].imageLoadState`]: "failed",
      });
    }
  },

  onSearchInput(event) {
    this.setData({
      query: event.detail.value,
    });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      this.applyFilters();
    }, SEARCH_DEBOUNCE_MS);
  },

  selectNav(event) {
    const key = event.currentTarget.dataset.key;
    const expandedNavKey = this.data.expandedNavKey === key ? "" : key;
    this.setData({
      activeNavKey: key,
      expandedNavKey,
    });
    this.refreshPanels();
  },

  selectSort(event) {
    const value = event.currentTarget.dataset.value;
    this.setData({
      selectedSort: value,
    });
    this.applyFilters();
  },

  toggleFilterOption(event) {
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

    this.setData({ filters, focusedFilterValue });
    this.applyFilters();
  },

  removeSelectedPill(event) {
    const { key, value } = event.currentTarget.dataset;
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
    this.setData({ filters, focusedFilterValue });
    this.applyFilters();
  },

  clearFilters() {
    const filters = createFilters();
    this.setData({
      query: "",
      selectedSort: "default",
      activeNavKey: "packageTypes",
      expandedNavKey: "packageTypes",
      filters,
      focusedFilterValue: null,
    });
    this.applyFilters();
  },

  navigateToCase(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/detail/index?id=${encodeURIComponent(id)}`,
    });
  },
});
