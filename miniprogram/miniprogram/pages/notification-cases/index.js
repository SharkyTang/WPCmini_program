const { fetchRecentCaseAdminList } = require("../../utils/caseAdminService");
const { fetchPublishedLinkedCases } = require("../../utils/notificationAdminService");
const { normalizeCaseRecord } = require("../../utils/caseData");
const { attachCaseImageUrls } = require("../../utils/cloudData");

const PAGE_SIZE = 20;
const MAX_SELECTION = 20;

function buildCaseCard(item = {}, selectedIds = []) {
  const id = item.id || item._id || "";
  return {
    ...item,
    id,
    tagSummary: (item.tags || []).slice(0, 3).join(" / "),
    selected: selectedIds.includes(id),
  };
}

function mergeById(current = [], next = []) {
  const map = new Map();
  current.concat(next).forEach((item) => {
    if (item && item.id) map.set(item.id, item);
  });
  return Array.from(map.values());
}

Page({
  data: {
    mode: "view",
    announcementId: "",
    title: "上新案例",
    loading: false,
    loadingMore: false,
    errorMessage: "",
    unavailableCount: 0,
    page: 1,
    hasMore: false,
    selectMode: false,
    selectedCaseIds: [],
    selectedItems: [],
    cards: [],
  },

  onLoad(options = {}) {
    const mode = options.mode === "select" ? "select" : "view";
    this.eventChannel = this.getOpenerEventChannel ? this.getOpenerEventChannel() : null;
    if (this.eventChannel && this.eventChannel.on) {
      this.eventChannel.on("initSelection", (payload = {}) => {
        const ids = Array.isArray(payload.caseDocIds) ? payload.caseDocIds.slice(0, MAX_SELECTION) : [];
        this.setData({
          selectedCaseIds: ids,
          selectedItems: payload.items || [],
          cards: this.data.cards.map((item) => buildCaseCard(item, ids)),
        });
      });
    }
    this.setData({
      mode,
      announcementId: options.announcementId || "",
      title: mode === "select" ? "选择上新案例" : "上新案例",
    });
    if (wx.setNavigationBarTitle) {
      wx.setNavigationBarTitle({ title: mode === "select" ? "选择上新案例" : "上新案例" });
    }
    if (mode === "select") {
      this.loadRecentCases(true);
    } else {
      this.loadPublishedCases(options.announcementId || "");
    }
  },

  async loadRecentCases(reset = false) {
    if (this.data.loading || this.data.loadingMore) return;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({
      [reset ? "loading" : "loadingMore"]: true,
      errorMessage: reset ? "" : this.data.errorMessage,
    });
    try {
      const result = await fetchRecentCaseAdminList({ page, pageSize: PAGE_SIZE });
      const nextCards = (result.items || []).map((item) =>
        buildCaseCard(item, this.data.selectedCaseIds)
      );
      this.setData({
        loading: false,
        loadingMore: false,
        page,
        hasMore: result.hasMore,
        cards: reset ? nextCards : mergeById(this.data.cards, nextCards),
      });
    } catch (error) {
      console.error("近期案例读取失败", error);
      this.setData({
        loading: false,
        loadingMore: false,
        errorMessage: error.message || "近期案例读取失败，请稍后重试",
      });
    }
  },

  async loadPublishedCases(announcementId) {
    if (!announcementId) {
      this.setData({ errorMessage: "缺少产品上新通知 ID" });
      return;
    }
    this.setData({ loading: true, errorMessage: "" });
    try {
      const result = await fetchPublishedLinkedCases(announcementId);
      const normalized = (result.items || []).map(normalizeCaseRecord);
      const items = await attachCaseImageUrls(normalized);
      this.setData({
        loading: false,
        title: (result.announcement && result.announcement.title) || "上新案例",
        unavailableCount: Number(result.unavailableCount || 0),
        cards: items.map((item) => buildCaseCard(item)),
      });
    } catch (error) {
      console.error("上新案例读取失败", error);
      this.setData({
        loading: false,
        errorMessage: error.message || "上新案例读取失败，请稍后重试",
      });
    }
  },

  toggleSelectMode() {
    if (this.data.mode !== "select") return;
    this.setData({ selectMode: !this.data.selectMode });
  },

  handleCardTap(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    if (this.data.mode === "select" && this.data.selectMode) {
      this.toggleCaseSelection(id);
      return;
    }
    wx.navigateTo({
      url: `/pages/detail/index?id=${encodeURIComponent(id)}`,
    });
  },

  toggleCaseSelection(id) {
    const selectedCaseIds = this.data.selectedCaseIds.slice();
    const selectedItems = this.data.selectedItems.slice();
    const index = selectedCaseIds.indexOf(id);
    if (index >= 0) {
      selectedCaseIds.splice(index, 1);
      const itemIndex = selectedItems.findIndex((item) => (item.id || item._id) === id);
      if (itemIndex >= 0) selectedItems.splice(itemIndex, 1);
    } else {
      if (selectedCaseIds.length >= MAX_SELECTION) {
        wx.showToast({ title: `最多选择 ${MAX_SELECTION} 个案例`, icon: "none" });
        return;
      }
      const item = this.data.cards.find((card) => card.id === id);
      selectedCaseIds.push(id);
      if (item) selectedItems.push({ ...item, selected: true });
    }
    this.updateSelection(selectedCaseIds, selectedItems);
  },

  updateSelection(selectedCaseIds, selectedItems) {
    this.setData({
      selectedCaseIds,
      selectedItems,
      cards: this.data.cards.map((item) => buildCaseCard(item, selectedCaseIds)),
    });
  },

  toggleSelectAll() {
    const loadedIds = this.data.cards.map((item) => item.id).filter(Boolean);
    const allLoadedSelected = loadedIds.length
      && loadedIds.every((id) => this.data.selectedCaseIds.includes(id));
    if (allLoadedSelected) {
      const loadedSet = new Set(loadedIds);
      this.updateSelection(
        this.data.selectedCaseIds.filter((id) => !loadedSet.has(id)),
        this.data.selectedItems.filter((item) => !loadedSet.has(item.id || item._id))
      );
      return;
    }
    const nextIds = this.data.selectedCaseIds.slice();
    const nextItems = this.data.selectedItems.slice();
    for (const item of this.data.cards) {
      if (nextIds.includes(item.id)) continue;
      if (nextIds.length >= MAX_SELECTION) break;
      nextIds.push(item.id);
      nextItems.push({ ...item, selected: true });
    }
    this.updateSelection(nextIds, nextItems);
    if (loadedIds.length > MAX_SELECTION) {
      wx.showToast({ title: `最多选择 ${MAX_SELECTION} 个案例`, icon: "none" });
    }
  },

  completeSelection() {
    if (!this.data.selectedCaseIds.length) {
      wx.showToast({ title: "请至少选择一个案例", icon: "none" });
      return;
    }
    if (this.eventChannel && this.eventChannel.emit) {
      this.eventChannel.emit("confirmSelection", {
        caseDocIds: this.data.selectedCaseIds,
        items: this.data.selectedItems,
      });
    }
    wx.navigateBack({ delta: 1 });
  },

  loadMore() {
    if (this.data.mode === "select" && this.data.hasMore) {
      this.loadRecentCases(false);
    }
  },

  retry() {
    if (this.data.mode === "select") {
      this.loadRecentCases(true);
    } else {
      this.loadPublishedCases(this.data.announcementId);
    }
  },

  goToCategory() {
    wx.switchTab({ url: "/pages/category/index" });
  },
});
