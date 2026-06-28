const {
  clearHistory,
  fetchHistoryCases,
  removeHistoryRecords,
} = require("../../utils/historyService");
const { ensureWxIdentity, getCachedOpenId } = require("../../utils/userService");

function buildHistoryCards(items, selectedIds = []) {
  const selectedMap = selectedIds.reduce((map, id) => {
    map[id] = true;
    return map;
  }, {});

  return (items || []).map((item) => {
    const caseItem = item.caseItem;
    return {
      historyId: item.historyId,
      id: caseItem.id,
      title: caseItem.title,
      imageUrl: caseItem.coverImageUrl,
      tagSummary: (caseItem.tags || []).slice(0, 3).join(" / "),
      selected: Boolean(selectedMap[item.historyId]),
    };
  });
}

function getAllHistoryIds(cards) {
  return (cards || []).map((card) => card.historyId).filter(Boolean);
}

Page({
  data: {
    loading: false,
    errorMessage: "",
    needIdentity: true,
    manageMode: false,
    selectedCount: 0,
    selectedHistoryIds: [],
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
      manageMode: false,
      selectedCount: 0,
      selectedHistoryIds: [],
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
        manageMode: false,
        selectedCount: 0,
        selectedHistoryIds: [],
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

  toggleManageMode() {
    const nextManageMode = !this.data.manageMode;
    this.setData({
      manageMode: nextManageMode,
      selectedCount: 0,
      selectedHistoryIds: [],
      historyCards: this.data.historyCards.map((card) => ({
        ...card,
        selected: false,
      })),
    });
  },

  updateSelectedHistoryIds(selectedHistoryIds) {
    const selectedMap = selectedHistoryIds.reduce((map, id) => {
      map[id] = true;
      return map;
    }, {});
    const historyCards = this.data.historyCards.map((card) => ({
      ...card,
      selected: Boolean(selectedMap[card.historyId]),
    }));

    this.setData({
      selectedHistoryIds,
      selectedCount: selectedHistoryIds.length,
      historyCards,
    });
  },

  handleCardTap(event) {
    const id = event.currentTarget.dataset.id;
    const historyId = event.currentTarget.dataset.historyId;
    if (this.data.manageMode) {
      this.toggleHistorySelection(historyId);
      return;
    }

    if (!id) return;
    wx.navigateTo({
      url: `/pages/detail/index?id=${encodeURIComponent(id)}`,
    });
  },

  toggleHistorySelection(historyId) {
    if (!historyId) return;

    const selected = this.data.selectedHistoryIds.slice();
    const index = selected.indexOf(historyId);
    if (index >= 0) {
      selected.splice(index, 1);
    } else {
      selected.push(historyId);
    }

    this.updateSelectedHistoryIds(selected);
  },

  toggleSelectAll() {
    const allIds = getAllHistoryIds(this.data.historyCards);
    const shouldClear = this.data.selectedHistoryIds.length === allIds.length;
    this.updateSelectedHistoryIds(shouldClear ? [] : allIds);
  },

  async deleteSelectedHistory() {
    const ids = this.data.selectedHistoryIds;
    if (!ids.length) {
      wx.showToast({
        title: "请选择要删除的记录",
        icon: "none",
      });
      return;
    }

    wx.showModal({
      title: "删除浏览记录",
      content: `删除选中的 ${ids.length} 条浏览记录？`,
      confirmText: "删除",
      confirmColor: "#241d16",
      success: async (response) => {
        if (!response.confirm) return;
        await this.removeHistoryIds(ids);
      },
    });
  },

  async clearAllHistory() {
    if (!this.data.historyCards.length) return;

    wx.showModal({
      title: "清空浏览记录",
      content: "清空全部浏览记录？清空后的浏览记录将不会恢复。",
      confirmText: "清空",
      confirmColor: "#241d16",
      success: async (response) => {
        if (!response.confirm) return;

        wx.showLoading({
          title: "正在清空",
        });
        try {
          await clearHistory();
          wx.hideLoading();
          wx.showToast({
            title: "已清空",
            icon: "success",
          });
          this.setData({
            manageMode: false,
            selectedCount: 0,
            selectedHistoryIds: [],
            historyCards: [],
          });
        } catch (error) {
          console.error("清空浏览记录失败", error);
          wx.hideLoading();
          wx.showToast({
            title: "清空失败，请稍后重试",
            icon: "none",
          });
        }
      },
    });
  },

  async removeHistoryIds(ids) {
    wx.showLoading({
      title: "正在删除",
    });
    try {
      await removeHistoryRecords(ids);
      wx.hideLoading();
      wx.showToast({
        title: "已删除",
        icon: "success",
      });
      this.loadHistory();
    } catch (error) {
      console.error("删除浏览记录失败", error);
      wx.hideLoading();
      wx.showToast({
        title: "删除失败，请稍后重试",
        icon: "none",
      });
    }
  },

  goToCategory() {
    wx.switchTab({
      url: "/pages/category/index",
    });
  },
});
