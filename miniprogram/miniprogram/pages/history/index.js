const { fetchHistoryCases } = require("../../utils/historyService");
const { ensureWxIdentity, getCachedOpenId } = require("../../utils/userService");

function buildHistoryCards(items) {
  return (items || []).map((item) => {
    const caseItem = item.caseItem;
    return {
      historyId: item.historyId,
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
    historyCards: [],
  },

  onShow() {
    if (getCachedOpenId()) {
      this.loadHistory();
      return;
    }

    this.setData({
      loading: false,
      errorMessage: "",
      needIdentity: true,
      historyCards: [],
    });
  },

  async loginAndLoad() {
    const openid = await ensureWxIdentity({
      content: "浏览记录需要识别你的微信身份，用来保存和查看自己看过的案例。",
      confirmText: "查看记录",
    });
    if (!openid) return;
    this.loadHistory();
  },

  async loadHistory() {
    if (!getCachedOpenId()) {
      this.setData({
        loading: false,
        needIdentity: true,
        historyCards: [],
      });
      return;
    }

    this.setData({
      loading: true,
      errorMessage: "",
      needIdentity: false,
    });

    try {
      const items = await fetchHistoryCases();
      this.setData({
        loading: false,
        historyCards: buildHistoryCards(items),
      });
    } catch (error) {
      console.error("浏览记录读取失败", error);
      this.setData({
        loading: false,
        errorMessage: "暂时读取不到浏览记录，请稍后重试。",
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
