const {
  clearHistory,
  fetchHistoryCases,
  removeHistoryRecords,
} = require("../../utils/historyService");
const {
  checkLibraryAccess,
  reportLibraryEvent,
  requestLibraryAccess,
  resumePendingLibraryAction,
} = require("../../utils/libraryAccessService");
const { resumePendingProfileAction } = require("../../utils/userService");

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
    accessState: "checking",
    manageMode: false,
    selectedCount: 0,
    selectedHistoryIds: [],
    historyCards: [],
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
    const resumed = await resumePendingLibraryAction("profile_history");
    if (resumed === true || (resumed && resumed.resumed)) return;
    const legacyResumed = await resumePendingProfileAction();
    if (legacyResumed === true || (legacyResumed && legacyResumed.resumed)) return;
    return this.ensureProfileAndLoad();
  },

  async ensureProfileAndLoad() {
    this.setData({
      loading: true,
      errorMessage: "",
      accessState: "checking",
    });

    const access = await checkLibraryAccess("history");
    if (access.status === "error") {
      this.setData({
        loading: false,
        accessState: "error",
        errorMessage: "暂时无法验证资料，请检查网络后重试。",
        manageMode: false,
        selectedCount: 0,
        selectedHistoryIds: [],
      });
      return false;
    }

    if (access.status === "profile_required") {
      this.setData({
        loading: false,
        accessState: "profile_required",
        manageMode: false,
        selectedCount: 0,
        selectedHistoryIds: [],
        historyCards: [],
      });
      return false;
    }

    return this.loadHistory();
  },

  async loadHistory() {
    const startedAt = Date.now();
    this.setData({
      loading: true,
      errorMessage: "",
      accessState: "ready",
    });

    try {
      const items = await fetchHistoryCases();
      this.setData({
        loading: false,
        accessState: "ready",
        manageMode: false,
        selectedCount: 0,
        selectedHistoryIds: [],
        historyCards: buildHistoryCards(items),
      });
      reportLibraryEvent("library_load_result", {
        kind: "history",
        source: "profile_history",
        result: "success",
        durationMs: Date.now() - startedAt,
      });
      return true;
    } catch (error) {
      console.error("浏览记录读取失败", error);
      this.setData({
        loading: false,
        accessState: "error",
        errorMessage: "暂时读取不到浏览记录，请稍后重试。",
      });
      reportLibraryEvent("library_load_result", {
        kind: "history",
        source: "profile_history",
        result: "error",
        durationMs: Date.now() - startedAt,
      });
      return false;
    }
  },

  async requestProfileAccess() {
    if (this.profileAccessPending) return;
    this.profileAccessPending = true;
    let result;
    try {
      result = await requestLibraryAccess({
        kind: "history",
        source: "profile_history",
        resume: () => this.ensureProfileAndLoad(),
      });
    } catch (error) {
      console.error("历史资料访问请求失败", error);
      result = { status: "error", stage: "access_check" };
    } finally {
      this.profileAccessPending = false;
    }
    if (result && result.status === "ready") {
      return this.loadHistory();
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

  deleteSelectedHistory() {
    const ids = this.data.selectedHistoryIds;
    if (!ids.length) {
      wx.showToast({
        title: "请选择要删除的记录",
        icon: "none",
      });
      return;
    }

    this.openConfirmDialog({
      title: "删除浏览记录",
      content: `删除选中的 ${ids.length} 条浏览记录？`,
      confirmText: "删除",
      action: "selected",
      ids,
    });
  },

  clearAllHistory() {
    if (!this.data.historyCards.length) return;

    this.openConfirmDialog({
      title: "清空浏览记录",
      content: "清空全部浏览记录？清空后的浏览记录将不会恢复。",
      confirmText: "清空",
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
      await this.performClearAllHistory();
      return;
    }
    if (dialog.action === "selected") {
      await this.removeHistoryIds(dialog.ids);
    }
  },

  async performClearAllHistory() {
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
