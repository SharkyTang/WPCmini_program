const {
  CASE_ADMIN_VIEW_OPTIONS,
  DEFAULT_PAGE_SIZE,
  checkCaseAdminAccess,
  deleteCaseAdmin,
  fetchCaseAdminHomepageDisplay,
  fetchCaseAdminList,
  setCaseVisibility,
} = require("../../utils/caseAdminService");

const HOME_DISPLAY_VIEWS = new Set(["banner", "popular", "latest"]);

function getEmptyState(view) {
  if (view === "banner") return { title: "暂无首页轮播", description: "当前首页没有正在展示的轮播图。" };
  if (view === "popular") return { title: "暂无热门产品", description: "当前首页没有正在展示的热门产品。" };
  if (view === "latest") return { title: "暂无最新产品", description: "当前首页没有正在展示的最新产品。" };
  return { title: "暂无案例", description: "可以先新增一个隐藏案例，确认后再打开显示。" };
}

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
    activeView: "all",
    viewOptions: CASE_ADMIN_VIEW_OPTIONS,
    isHomeDisplay: false,
    emptyTitle: "暂无案例",
    emptyDescription: "可以先新增一个隐藏案例，确认后再打开显示。",
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
    const homeDisplay = HOME_DISPLAY_VIEWS.has(this.data.activeView);

    this.setData({
      loading: reset,
      loadingMore: !reset,
      errorMessage: "",
    });

    try {
      const result = homeDisplay
        ? await fetchCaseAdminHomepageDisplay({
          slot: this.data.activeView,
          keyword: this.data.keyword,
        })
        : await fetchCaseAdminList({
          keyword: this.data.keyword,
          visibility: this.data.activeView,
          page: nextPage,
          pageSize: this.data.pageSize,
        });

      this.setData({
        cases: homeDisplay || reset ? result.items : this.data.cases.concat(result.items),
        page: homeDisplay ? 1 : nextPage,
        hasMore: homeDisplay ? false : result.hasMore,
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

  selectView(event) {
    const value = event.currentTarget.dataset.value || "all";
    if (value === this.data.activeView) return;
    const emptyState = getEmptyState(value);
    this.setData({
      activeView: value,
      isHomeDisplay: HOME_DISPLAY_VIEWS.has(value),
      emptyTitle: emptyState.title,
      emptyDescription: emptyState.description,
    });
    this.loadCases({ reset: true });
  },

  selectVisibility(event) {
    this.selectView(event);
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

  deleteCase(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;

    wx.showModal({
      title: "删除这个案例？",
      content: "删除后将从前台和案例管理中移除，无法恢复。",
      confirmText: "删除",
      confirmColor: "#b04236",
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await deleteCaseAdmin(id);
          wx.showToast({
            title: "已删除",
            icon: "none",
          });
          this.loadCases({ reset: true });
        } catch (error) {
          console.warn("删除案例失败", error);
          wx.showToast({
            title: "删除失败，请稍后重试",
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
