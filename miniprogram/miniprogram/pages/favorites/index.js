const { fetchFavoriteCases } = require("../../utils/favoriteService");
const { ensureWxIdentity, getCachedOpenId } = require("../../utils/userService");

function buildFavoriteCards(items) {
  return (items || []).map((item) => {
    const caseItem = item.caseItem;
    return {
      favoriteId: item.favoriteId,
      id: caseItem.id,
      title: caseItem.title,
      imageUrl: caseItem.coverImageUrl,
      tagSummary: (caseItem.tags || []).slice(0, 3).join(" / "),
    };
  });
}

Page({
  data: {
    loading: false,
    errorMessage: "",
    needIdentity: true,
    favoriteCards: [],
  },

  onShow() {
    if (getCachedOpenId()) {
      this.loadFavorites();
      return;
    }

    this.setData({
      loading: false,
      errorMessage: "",
      needIdentity: true,
      favoriteCards: [],
    });
  },

  async loginAndLoad() {
    const openid = await ensureWxIdentity();
    if (!openid) return;
    this.loadFavorites();
  },

  async loadFavorites() {
    if (!getCachedOpenId()) {
      this.setData({
        loading: false,
        needIdentity: true,
        favoriteCards: [],
      });
      return;
    }

    this.setData({
      loading: true,
      errorMessage: "",
      needIdentity: false,
    });

    try {
      const items = await fetchFavoriteCases();
      this.setData({
        loading: false,
        favoriteCards: buildFavoriteCards(items),
      });
    } catch (error) {
      console.error("收藏列表读取失败", error);
      this.setData({
        loading: false,
        errorMessage: "暂时读取不到收藏，请稍后重试。",
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

  goToCategory() {
    wx.switchTab({
      url: "/pages/category/index",
    });
  },
});
