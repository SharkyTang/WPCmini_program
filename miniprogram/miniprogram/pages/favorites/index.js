const {
  clearFavorites,
  fetchFavoriteCases,
  removeFavoriteRecords,
} = require("../../utils/favoriteService");
const { ensureProfileIdentity, getCachedOpenId } = require("../../utils/userService");

function buildFavoriteCards(items, selectedIds = []) {
  const selectedMap = selectedIds.reduce((map, id) => {
    map[id] = true;
    return map;
  }, {});

  return (items || []).map((item) => {
    const caseItem = item.caseItem;
    return {
      favoriteId: item.favoriteId,
      id: caseItem.id,
      title: caseItem.title,
      imageUrl: caseItem.coverImageUrl,
      tagSummary: (caseItem.tags || []).slice(0, 3).join(" / "),
      selected: Boolean(selectedMap[item.favoriteId]),
    };
  });
}

function getAllFavoriteIds(cards) {
  return (cards || []).map((card) => card.favoriteId).filter(Boolean);
}

Page({
  data: {
    loading: false,
    errorMessage: "",
    profileBlocked: false,
    manageMode: false,
    selectedCount: 0,
    selectedFavoriteIds: [],
    favoriteCards: [],
    confirmDialog: {
      show: false,
      title: "",
      content: "",
      action: "",
      ids: [],
      buttons: [{ text: "取消" }, { text: "确认" }],
    },
  },

  onShow() {
    this.ensureProfileAndLoad();
  },

  async ensureProfileAndLoad() {
    this.setData({
      loading: true,
      errorMessage: "",
      profileBlocked: false,
    });
    const identity = await ensureProfileIdentity();
    if (!identity.ready) {
      this.setData({
        loading: false,
        profileBlocked: !identity.error,
        manageMode: false,
        selectedCount: 0,
        selectedFavoriteIds: [],
        favoriteCards: [],
      });
      return;
    }
    this.loadFavorites();
  },

  async loadFavorites() {
    if (!getCachedOpenId()) {
      this.setData({
        loading: false,
        profileBlocked: true,
        manageMode: false,
        selectedCount: 0,
        selectedFavoriteIds: [],
        favoriteCards: [],
      });
      return;
    }

    this.setData({
      loading: true,
      errorMessage: "",
      profileBlocked: false,
    });

    try {
      const items = await fetchFavoriteCases();
      this.setData({
        loading: false,
        manageMode: false,
        selectedCount: 0,
        selectedFavoriteIds: [],
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

  toggleManageMode() {
    const nextManageMode = !this.data.manageMode;
    this.setData({
      manageMode: nextManageMode,
      selectedCount: 0,
      selectedFavoriteIds: [],
      favoriteCards: this.data.favoriteCards.map((card) => ({
        ...card,
        selected: false,
      })),
    });
  },

  updateSelectedFavoriteIds(selectedFavoriteIds) {
    const selectedMap = selectedFavoriteIds.reduce((map, id) => {
      map[id] = true;
      return map;
    }, {});
    const favoriteCards = this.data.favoriteCards.map((card) => ({
      ...card,
      selected: Boolean(selectedMap[card.favoriteId]),
    }));

    this.setData({
      selectedFavoriteIds,
      selectedCount: selectedFavoriteIds.length,
      favoriteCards,
    });
  },

  handleCardTap(event) {
    const id = event.currentTarget.dataset.id;
    const favoriteId = event.currentTarget.dataset.favoriteId;
    if (this.data.manageMode) {
      this.toggleFavoriteSelection(favoriteId);
      return;
    }

    if (!id) return;
    wx.navigateTo({
      url: `/pages/detail/index?id=${encodeURIComponent(id)}`,
    });
  },

  toggleFavoriteSelection(favoriteId) {
    if (!favoriteId) return;

    const selected = this.data.selectedFavoriteIds.slice();
    const index = selected.indexOf(favoriteId);
    if (index >= 0) {
      selected.splice(index, 1);
    } else {
      selected.push(favoriteId);
    }

    this.updateSelectedFavoriteIds(selected);
  },

  toggleSelectAll() {
    const allIds = getAllFavoriteIds(this.data.favoriteCards);
    const shouldClear = this.data.selectedFavoriteIds.length === allIds.length;
    this.updateSelectedFavoriteIds(shouldClear ? [] : allIds);
  },

  cancelSelectedFavorites() {
    const ids = this.data.selectedFavoriteIds;
    if (!ids.length) {
      wx.showToast({
        title: "请选择要删除的收藏",
        icon: "none",
      });
      return;
    }

    this.openConfirmDialog({
      title: "删除收藏",
      content: `删除选中的 ${ids.length} 个收藏？删除后的收藏将不会恢复。`,
      confirmText: "删除收藏",
      action: "selected",
      ids,
    });
  },

  clearAllFavorites() {
    if (!this.data.favoriteCards.length) return;

    this.openConfirmDialog({
      title: "删除全部收藏",
      content: "删除全部收藏？删除后的收藏将不会恢复。",
      confirmText: "删除全部",
      action: "all",
    });
  },

  openConfirmDialog(options = {}) {
    this.setData({
      confirmDialog: {
        show: true,
        title: options.title || "",
        content: options.content || "",
        action: options.action || "",
        ids: (options.ids || []).slice(),
        buttons: [
          { text: "取消" },
          { text: options.confirmText || "确认", extClass: "dialog-button-danger" },
        ],
      },
    });
  },

  closeConfirmDialog() {
    this.setData({
      "confirmDialog.show": false,
    });
  },

  async handleConfirmDialogTap(event) {
    const index = event.detail && event.detail.index;
    const dialog = this.data.confirmDialog;
    this.closeConfirmDialog();
    if (index !== 1) return;

    if (dialog.action === "all") {
      await this.performClearAllFavorites();
      return;
    }
    if (dialog.action === "selected") {
      await this.removeFavoriteIds(dialog.ids);
    }
  },

  async performClearAllFavorites() {
    wx.showLoading({
      title: "正在删除",
    });
    try {
      await clearFavorites();
      wx.hideLoading();
      wx.showToast({
        title: "已删除全部收藏",
        icon: "success",
      });
      this.setData({
        manageMode: false,
        selectedCount: 0,
        selectedFavoriteIds: [],
        favoriteCards: [],
      });
    } catch (error) {
      console.error("删除全部收藏失败", error);
      wx.hideLoading();
      wx.showToast({
        title: "删除失败，请稍后重试",
        icon: "none",
      });
    }
  },

  async removeFavoriteIds(ids) {
    wx.showLoading({
      title: "正在删除",
    });
    try {
      await removeFavoriteRecords(ids);
      wx.hideLoading();
      wx.showToast({
        title: "已删除收藏",
        icon: "success",
      });
      this.loadFavorites();
    } catch (error) {
      console.error("批量删除收藏失败", error);
      wx.hideLoading();
      wx.showToast({
        title: "删除失败，请稍后重试",
        icon: "none",
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
