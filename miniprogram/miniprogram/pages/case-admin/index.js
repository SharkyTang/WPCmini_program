const {
  CASE_ADMIN_VISIBILITY_OPTIONS,
  DEFAULT_PAGE_SIZE,
  checkCaseAdminAccess,
  fetchCaseAdminList,
  setCaseVisibility,
} = require("../../utils/caseAdminService");

function toBoolean(value) {
  return value === true || value === "true";
}

Page({
  data: {
    isCheckingAccess: true,
    isAdmin: false,
    loading: false,
    loadingMore: false,
    errorMessage: "",
    cases: [],
    keyword: "",
    activeVisibility: "all",
    visibilityOptions: CASE_ADMIN_VISIBILITY_OPTIONS,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    hasMore: false,
  },

  onLoad() {
    this.checkAccessAndLoad();
  },

  onPullDownRefresh() {
    if (!this.data.isAdmin) {
      wx.stopPullDownRefresh();
      return;
    }
    this.loadCases({ reset: true }).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) {
      this.loadCases({ reset: false });
    }
  },

  async checkAccessAndLoad() {
    this.setData({
      isCheckingAccess: true,
      errorMessage: "",
    });

    const isAdmin = await checkCaseAdminAccess();
    this.setData({
      isCheckingAccess: false,
      isAdmin,
    });

    if (isAdmin) {
      await this.loadCases({ reset: true });
    }
  },

  async loadCases(options = {}) {
    const reset = options.reset !== false;
    const nextPage = reset ? 1 : this.data.page + 1;

    this.setData({
      loading: reset,
      loadingMore: !reset,
      errorMessage: "",
    });

    try {
      const result = await fetchCaseAdminList({
        keyword: this.data.keyword,
        visibility: this.data.activeVisibility,
        page: nextPage,
        pageSize: this.data.pageSize,
      });

      this.setData({
        cases: reset ? result.items : this.data.cases.concat(result.items),
        page: nextPage,
        hasMore: result.hasMore,
        loading: false,
        loadingMore: false,
      });
    } catch (error) {
      console.warn("读取案例管理列表失败", error);
      this.setData({
        loading: false,
        loadingMore: false,
        errorMessage: "案例列表读取失败，请稍后重试",
      });
    }
  },

  onKeywordInput(event) {
    this.setData({
      keyword: event.detail.value || "",
    });
  },

  searchCases() {
    this.loadCases({ reset: true });
  },

  clearKeyword() {
    this.setData({
      keyword: "",
    });
    this.loadCases({ reset: true });
  },

  selectVisibility(event) {
    const value = event.currentTarget.dataset.value || "all";
    if (value === this.data.activeVisibility) return;
    this.setData({
      activeVisibility: value,
    });
    this.loadCases({ reset: true });
  },

  createCase() {
    wx.navigateTo({
      url: "/pages/case-admin/edit",
    });
  },

  editCase(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/case-admin/edit?id=${id}`,
    });
  },

  toggleCaseVisibility(event) {
    const id = event.currentTarget.dataset.id;
    const nextVisible = toBoolean(event.currentTarget.dataset.visible);
    const title = nextVisible ? "恢复显示这个案例？" : "隐藏这个案例？";
    const content = nextVisible
      ? "恢复后，普通用户可以在首页、分类页看到它。"
      : "隐藏后，普通用户将看不到它，但数据和图片不会被删除。";

    if (!id) return;

    wx.showModal({
      title,
      content,
      confirmText: nextVisible ? "恢复" : "隐藏",
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await setCaseVisibility(id, nextVisible);
          wx.showToast({
            title: nextVisible ? "已恢复显示" : "已隐藏",
            icon: "none",
          });
          this.loadCases({ reset: true });
        } catch (error) {
          console.warn("更新案例显示状态失败", error);
          wx.showToast({
            title: "操作失败，请稍后重试",
            icon: "none",
          });
        }
      },
    });
  },

  retry() {
    if (this.data.isAdmin) {
      this.loadCases({ reset: true });
      return;
    }
    this.checkAccessAndLoad();
  },
});
