const {
  attachCaseImageUrls,
  fetchVisibleCases,
  fetchVisibleBanners,
} = require("../../utils/cloudData");
const { fetchHomeFeed } = require("../../utils/caseCatalogService");
const {
  HOME_CACHE_KEY,
  readCache,
  writeCache,
} = require("../../utils/catalogCache");
const {
  getCaseDataVersion,
  shouldRefreshCaseData,
} = require("../../utils/caseRefresh");
const { HOME_SECTION_VALUES } = require("../../utils/caseData");

const PENDING_CATEGORY_SORT_KEY = "pendingCategorySort";

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

function buildProductCard(caseItem, homeBadge) {
  return {
    ...caseItem,
    tagSummary: summarizeTags(caseItem),
    homeBadge,
  };
}

function decorateHomeFeed(feed = {}) {
  return {
    banners: feed.banners || [],
    popularCases: (feed.popularCases || []).map((item) =>
      buildProductCard(item, "近期热门")
    ),
    latestCases: (feed.latestCases || []).map((item) =>
      buildProductCard(item, "最近上新")
    ),
  };
}

function buildHomeSections(cases) {
  const visibleCases = cases.filter((caseItem) => caseItem.isVisible);
  const popularSource = visibleCases.filter((caseItem) =>
    (caseItem.homeSections || []).includes(HOME_SECTION_VALUES.POPULAR)
  );
  const latestSource = visibleCases
    .filter((caseItem) => (caseItem.homeSections || []).includes(HOME_SECTION_VALUES.LATEST))
    .sort((a, b) => b.sortOrder - a.sortOrder);

  return {
    popularCases: popularSource
      .slice(0, 4)
      .map((caseItem) => buildProductCard(caseItem, "近期热门")),
    latestCases: latestSource
      .slice(0, 6)
      .map((caseItem) => buildProductCard(caseItem, "最近上新")),
  };
}

async function attachHomeSectionImages(sections) {
  const cards = [...sections.popularCases, ...sections.latestCases];
  const cardsWithImages = await attachCaseImageUrls(cards, { preferBanner: true });
  const imageById = cardsWithImages.reduce((map, card) => {
    map[card.id] = card.coverImageUrl;
    return map;
  }, {});

  return {
    popularCases: sections.popularCases.map((card) => ({
      ...card,
      coverImageUrl: imageById[card.id] || "",
    })),
    latestCases: sections.latestCases.map((card) => ({
      ...card,
      coverImageUrl: imageById[card.id] || "",
    })),
  };
}

Page({
  data: {
    loading: true,
    errorMessage: "",
    banners: [],
    popularCases: [],
    latestCases: [],
    caseDataVersion: 0,
    activeBannerIndex: 0,
  },

  onLoad() {
    this._homeCache = readCache(HOME_CACHE_KEY);
    if (this._homeCache) {
      this.applyHomeFeed(this._homeCache.data, {
        revision: this._homeCache.revision,
      });
    }
    this.loadData({ silent: Boolean(this._homeCache) });
  },

  onShow() {
    if (!this.data.loading && shouldRefreshCaseData(this.data.caseDataVersion)) {
      this.loadData({ silent: true, forceRefresh: true });
    }
  },

  onPullDownRefresh() {
    this.loadData({ forceRefresh: true }).finally(() => wx.stopPullDownRefresh());
  },

  applyHomeFeed(feed, options = {}) {
    const decorated = decorateHomeFeed(feed);
    this.setData({
      ...decorated,
      caseDataVersion: getCaseDataVersion(),
      catalogRevision: Number(options.revision) || 1,
      loading: false,
      errorMessage: "",
    });
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
        !options.forceRefresh && this._homeCache && this._homeCache.fresh
          ? this._homeCache.revision
          : undefined;
      let result;
      try {
        result = await fetchHomeFeed({ knownRevision });
      } catch (catalogError) {
        console.warn("首页聚合接口不可用，使用兼容读取", catalogError);
        const cases = await fetchVisibleCases({
          includeImageUrls: false,
          forceRefresh: options.forceRefresh,
        });
        const banners = await fetchVisibleBanners(cases, {
          forceRefresh: options.forceRefresh,
        });
        const sections = await attachHomeSectionImages(buildHomeSections(cases));
        result = {
          revision: getCaseDataVersion() || 1,
          notModified: false,
          banners,
          ...sections,
        };
      }
      if (result.notModified && this._homeCache) {
        this.applyHomeFeed(this._homeCache.data, {
          revision: result.revision,
        });
        return;
      }
      const feed = {
        banners: result.banners || [],
        popularCases: result.popularCases || [],
        latestCases: result.latestCases || [],
      };
      this._homeCache = {
        revision: result.revision,
        cachedAt: Date.now(),
        fresh: true,
        data: feed,
      };
      writeCache(HOME_CACHE_KEY, result.revision, feed);
      this.applyHomeFeed(feed, { revision: result.revision });
    } catch (error) {
      console.error("首页数据读取失败", error);
      if (this._homeCache) {
        this.applyHomeFeed(this._homeCache.data, {
          revision: this._homeCache.revision,
        });
        return;
      }
      this.setData({
        loading: false,
        errorMessage: "暂时读取不到案例数据，请检查云环境和数据库权限。",
      });
    }
  },

  navigateToCase(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/detail/index?id=${encodeURIComponent(id)}`,
    });
  },

  navigateToCategory(event) {
    const sort = event.currentTarget.dataset.sort;
    const app = typeof getApp === "function" ? getApp() : null;
    if (app && app.globalData) {
      app.globalData[PENDING_CATEGORY_SORT_KEY] = sort || "";
    }
    wx.setStorageSync(PENDING_CATEGORY_SORT_KEY, sort || "");
    wx.switchTab({
      url: "/pages/category/index",
    });
  },

  onBannerTap(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/detail/index?id=${encodeURIComponent(id)}`,
    });
  },

  onBannerChange(event) {
    const current = Number(event && event.detail && event.detail.current);
    if (!Number.isInteger(current) || current < 0) return;
    this.setData({
      activeBannerIndex: current,
    });
  },
});
