const {
  clearFavorites,
  fetchFavoriteCases,
  removeFavoriteRecords,
} = require("../../utils/favoriteService");
const {
  checkLibraryAccess,
  reportLibraryEvent,
  requestLibraryAccess,
  resumePendingLibraryAction,
} = require("../../utils/libraryAccessService");
const { resumePendingProfileAction } = require("../../utils/userService");

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

function beginNativeLoading(page) {
  const epoch = page._nativeLoadingEpoch || 0;
  page._nativeLoadingCount = (page._nativeLoadingCount || 0) + 1;
  if (page._nativeLoadingCount === 1) {
    page._nativeLoadingVisible = true;
    wx.showLoading({
      title: "加载中",
      mask: true,
    });
  }
  return epoch;
}

function endNativeLoading(page, epoch) {
  if (epoch !== (page._nativeLoadingEpoch || 0)) return;
  page._nativeLoadingCount = Math.max((page._nativeLoadingCount || 0) - 1, 0);
  if (page._nativeLoadingCount || !page._nativeLoadingVisible) return;
  page._nativeLoadingVisible = false;
  wx.hideLoading();
}

function resetNativeLoading(page) {
  page._nativeLoadingEpoch = (page._nativeLoadingEpoch || 0) + 1;
  page._nativeLoadingCount = 0;
  if (!page._nativeLoadingVisible) return;
  page._nativeLoadingVisible = false;
  wx.hideLoading();
}

Page({
  data: {
    loading: false,
    errorMessage: "",
    accessState: "checking",
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

  async onShow() {
    const loadingEpoch = beginNativeLoading(this);
    try {
      const resumed = await resumePendingLibraryAction("profile_favorites");
      if (resumed === true || (resumed && resumed.resumed)) return;
      const legacyResumed = await resumePendingProfileAction();
      if (legacyResumed === true || (legacyResumed && legacyResumed.resumed)) return;
      return await this.ensureProfileAndLoad();
    } finally {
      endNativeLoading(this, loadingEpoch);
    }
  },

  onUnload() {
    resetNativeLoading(this);
  },

  async ensureProfileAndLoad() {
    const loadingEpoch = beginNativeLoading(this);
    try {
      this.setData({
        loading: true,
        errorMessage: "",
        accessState: "checking",
      });

      const access = await checkLibraryAccess("favorites");
      if (access.status === "error") {
        this.setData({
          loading: false,
          accessState: "error",
          errorMessage: "暂时无法验证资料，请检查网络后重试。",
          manageMode: false,
          selectedCount: 0,
          selectedFavoriteIds: [],
        });
        return false;
      }

      if (access.status === "profile_required") {
        this.setData({
          loading: false,
          accessState: "profile_required",
          manageMode: false,
          selectedCount: 0,
          selectedFavoriteIds: [],
          favoriteCards: [],
        });
        return false;
      }

      return await this.loadFavorites();
    } finally {
      endNativeLoading(this, loadingEpoch);
    }
  },

  async loadFavorites() {
    const loadingEpoch = beginNativeLoading(this);
    const startedAt = Date.now();
    this.setData({
      loading: true,
      errorMessage: "",
      accessState: "ready",
    });

    try {
      const items = await fetchFavoriteCases();
      this.setData({
        loading: false,
        accessState: "ready",
        manageMode: false,
        selectedCount: 0,
        selectedFavoriteIds: [],
        favoriteCards: buildFavoriteCards(items),
      });
      reportLibraryEvent("library_load_result", {
        kind: "favorites",
        source: "profile_favorites",
        result: "success",
        durationMs: Date.now() - startedAt,
      });
      return true;
    } catch (error) {
      console.error("收藏列表读取失败", error);
      this.setData({
        loading: false,
        accessState: "error",
        errorMessage: "暂时读取不到收藏，请稍后重试。",
      });
      reportLibraryEvent("library_load_result", {
        kind: "favorites",
        source: "profile_favorites",
        result: "error",
        durationMs: Date.now() - startedAt,
      });
      return false;
    } finally {
      endNativeLoading(this, loadingEpoch);
    }
  },

  async requestProfileAccess() {
    if (this.profileAccessPending) return;
    this.profileAccessPending = true;
    let result;
    try {
      result = await requestLibraryAccess({
        kind: "favorites",
        source: "profile_favorites",
        resume: () => this.ensureProfileAndLoad(),
      });
    } catch (error) {
      console.error("收藏资料访问请求失败", error);
      result = { status: "error", stage: "access_check" };
    } finally {
      this.profileAccessPending = false;
    }
    if (result && result.status === "ready") {
      return this.loadFavorites();
    }
    if (result && result.status === "error") {
      wx.showToast({
        title: result.stage === "navigation"
          ? "暂时无法打开资料页，请重试"
          : "暂时无法验证资料，请重试",
        icon: "none",
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
      await this.loadFavorites();
      wx.showToast({
        title: "已删除收藏",
        icon: "success",
      });
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
