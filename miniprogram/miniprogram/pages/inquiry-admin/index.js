const {
  INQUIRY_FILTER_OPTIONS,
} = require("./utils/inquiryAdminData");
const {
  DEFAULT_PAGE_SIZE,
  checkInquiryAdminAccess,
  fetchInquiryList,
} = require("./utils/inquiryAdminService");

Page({
  data: {
    isCheckingAccess: true,
    isAdmin: false,
    loading: false,
    loadingMore: false,
    errorMessage: "",
    statusOptions: INQUIRY_FILTER_OPTIONS,
    activeStatus: "all",
    keyword: "",
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    hasMore: false,
    inquiries: [],
  },

  onLoad() {
    this.checkAccessAndLoad();
  },

  async checkAccessAndLoad() {
    this.setData({
      isCheckingAccess: true,
      errorMessage: "",
    });

    const isAdmin = await checkInquiryAdminAccess();
    this.setData({
      isCheckingAccess: false,
      isAdmin,
    });

    if (isAdmin) {
      await this.loadInquiries({ reset: true });
    }
  },

  async loadInquiries(options = {}) {
    if (!this.data.isAdmin) return;

    const reset = Boolean(options.reset);
    if (this.data.loading || this.data.loadingMore) return;

    const nextPage = reset ? 1 : this.data.page + 1;
    this.setData({
      loading: reset,
      loadingMore: !reset,
      errorMessage: "",
    });

    try {
      const result = await fetchInquiryList({
        status: this.data.activeStatus,
        keyword: this.data.keyword,
        page: nextPage,
        pageSize: this.data.pageSize,
      });

      this.setData({
        inquiries: reset ? result.items : this.data.inquiries.concat(result.items),
        page: result.page,
        hasMore: result.hasMore,
      });
    } catch (error) {
      console.error("需求列表加载失败", error);
      this.setData({
        errorMessage: error.message || "需求列表加载失败",
      });
    } finally {
      this.setData({
        loading: false,
        loadingMore: false,
      });
      if (wx.stopPullDownRefresh) {
        wx.stopPullDownRefresh();
      }
    }
  },

  onPullDownRefresh() {
    this.loadInquiries({ reset: true });
  },

  onReachBottom() {
    if (this.data.hasMore) {
      this.loadInquiries({ reset: false });
    }
  },

  selectStatus(event) {
    const status = event.currentTarget.dataset.status || "all";
    if (status === this.data.activeStatus) return;
    this.setData({
      activeStatus: status,
    });
    this.loadInquiries({ reset: true });
  },

  onKeywordInput(event) {
    this.setData({
      keyword: event.detail.value || "",
    });
  },

  searchInquiries() {
    this.loadInquiries({ reset: true });
  },

  clearKeyword() {
    this.setData({
      keyword: "",
    });
    this.loadInquiries({ reset: true });
  },

  openDetail(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/inquiry-admin/detail?id=${id}`,
    });
  },

  retry() {
    this.loadInquiries({ reset: true });
  },
});
