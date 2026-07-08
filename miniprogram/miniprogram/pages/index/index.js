const {
  fetchVisibleCases,
  fetchVisibleBanners,
} = require("../../utils/cloudData");
const {
  getCaseDataVersion,
  shouldRefreshCaseData,
} = require("../../utils/caseRefresh");

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

function buildProductCard(caseItem) {
  return {
    ...caseItem,
    tagSummary: summarizeTags(caseItem),
  };
}

function buildHomeSections(cases) {
  const visibleCases = cases.filter((caseItem) => caseItem.isVisible);
  const featuredCases = visibleCases.filter(
    (caseItem) =>
      (caseItem.statuses || []).includes("热门") ||
      (caseItem.statuses || []).includes("推荐")
  );
  const popularSource = featuredCases.length ? featuredCases : visibleCases;
  const latestSource = [...visibleCases].sort((a, b) => b.sortOrder - a.sortOrder);

  return {
    popularCases: popularSource.slice(0, 4).map(buildProductCard),
    latestCases: latestSource.slice(0, 4).map(buildProductCard),
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
      const cases = await fetchVisibleCases();
      const banners = await fetchVisibleBanners(cases);
      const { popularCases, latestCases } = buildHomeSections(cases);

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

  onBannerTap(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/detail/index?id=${encodeURIComponent(id)}`,
    });
  },
});
