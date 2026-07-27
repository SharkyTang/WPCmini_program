const {
  attachCaseImageUrls,
  fetchVisibleCases,
  fetchVisibleBanners,
} = require("../../utils/cloudData");
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
  const cardsWithImages = await attachCaseImageUrls(cards);
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
    allCases: [],
    banners: [],
    popularCases: [],
    latestCases: [],
    caseDataVersion: 0,
  },

  onLoad() {
    this.loadData();
  },

  onShow() {
    if (!this.data.loading && shouldRefreshCaseData(this.data.caseDataVersion)) {
      this.loadData({ silent: true });
    }
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
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
      const cases = await fetchVisibleCases({ includeImageUrls: false });
      const banners = await fetchVisibleBanners(cases);
      const { popularCases, latestCases } = await attachHomeSectionImages(
        buildHomeSections(cases)
      );

      this.setData({
        allCases: cases,
        banners,
        popularCases,
        latestCases,
        caseDataVersion: getCaseDataVersion(),
        loading: false,
      });
    } catch (error) {
      console.error("首页数据读取失败", error);
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
});
