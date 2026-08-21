const {
  INQUIRY_CLAIM_FILTER_OPTIONS,
  INQUIRY_FILTER_OPTIONS,
  formatDateTime,
  normalizeInquirySummary,
} = require("./utils/inquiryAdminData");
const {
  DEFAULT_PAGE_SIZE,
  checkInquiryAdminAccess,
  fetchInquiryList,
  fetchInquirySummary,
} = require("./utils/inquiryAdminService");

const POLL_INTERVAL_MS = 30 * 1000;

Page({
  data: {
    isCheckingAccess: true,
    isAdmin: false,
    loading: false,
    loadingMore: false,
    refreshing: false,
    errorMessage: "",
    summaryErrorMessage: "",
    statusOptions: INQUIRY_FILTER_OPTIONS,
    claimFilterOptions: INQUIRY_CLAIM_FILTER_OPTIONS,
    activeStatus: "all",
    activeClaimFilter: "all",
    keyword: "",
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    nextCursor: "",
    hasMore: false,
    inquiries: [],
    summary: normalizeInquirySummary(),
    hasSummary: false,
    lastRefreshedAtText: "",
  },

  onLoad() {
    return this.checkAccessAndLoad();
  },

  onShow() {
    this._isVisible = true;
    if (this._hasLoadedOnce && this.data.isAdmin) {
      this.refreshDashboard({ silent: true });
    }
    this.startPolling();
  },

  onHide() {
    this._isVisible = false;
    this.stopPolling();
  },

  onUnload() {
    this._isVisible = false;
    this._isUnloaded = true;
    this.stopPolling();
  },

  async checkAccessAndLoad() {
    this.setData({ isCheckingAccess: true, errorMessage: "" });
    const isAdmin = await checkInquiryAdminAccess();
    if (this._isUnloaded) return false;
    this.setData({ isCheckingAccess: false, isAdmin });
    if (!isAdmin) return false;
    await this.refreshDashboard({ silent: false });
    this._hasLoadedOnce = true;
    this.startPolling();
    return true;
  },

  async refreshDashboard(options = {}) {
    if (!this.data.isAdmin || this._dashboardRefreshPromise) {
      return this._dashboardRefreshPromise || false;
    }
    const silent = Boolean(options.silent);
    if (!silent) this.setData({ refreshing: true });
    this._dashboardRefreshPromise = Promise.all([
      this.loadSummary(),
      this.loadInquiries({ reset: true, silent }),
    ]).then(() => {
      if (!this._isUnloaded) {
        this.setData({ lastRefreshedAtText: formatDateTime(new Date()) });
      }
      return true;
    }).finally(() => {
      this._dashboardRefreshPromise = null;
      if (!this._isUnloaded) this.setData({ refreshing: false });
      if (wx.stopPullDownRefresh) wx.stopPullDownRefresh();
    });
    return this._dashboardRefreshPromise;
  },

  async loadSummary() {
    try {
      const summary = await fetchInquirySummary();
      if (!this._isUnloaded) {
        this.setData({ summary, hasSummary: true, summaryErrorMessage: "" });
      }
      return true;
    } catch (error) {
      console.warn("需求概览加载失败", error);
      if (!this._isUnloaded) {
        this.setData({ summaryErrorMessage: "需求概览暂时无法更新" });
      }
      return false;
    }
  },

  async loadInquiries(options = {}) {
    if (!this.data.isAdmin) return false;
    const reset = Boolean(options.reset);
    const silent = Boolean(options.silent);
    if (this.data.loading || this.data.loadingMore) return false;
    const nextPage = reset ? 1 : this.data.page + 1;
    this.setData({
      loading: reset && !silent,
      loadingMore: !reset,
      errorMessage: "",
    });
    try {
      const result = await fetchInquiryList({
        status: this.data.activeStatus,
        filter: this.data.activeClaimFilter,
        keyword: this.data.keyword,
        cursor: reset ? "" : this.data.nextCursor,
        page: nextPage,
        pageSize: this.data.pageSize,
      });
      if (this._isUnloaded) return false;
      this.setData({
        inquiries: reset ? result.items : this.data.inquiries.concat(result.items),
        page: result.page,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
      return true;
    } catch (error) {
      console.error("需求列表加载失败", error);
      if (!this._isUnloaded) {
        this.setData({ errorMessage: error.message || "需求列表加载失败" });
      }
      return false;
    } finally {
      if (!this._isUnloaded) this.setData({ loading: false, loadingMore: false });
      if (wx.stopPullDownRefresh) wx.stopPullDownRefresh();
    }
  },

  startPolling() {
    this.stopPolling();
    if (!this._isVisible || !this.data.isAdmin || this._isUnloaded) return;
    this._pollTimer = setTimeout(async () => {
      this._pollTimer = null;
      if (!this._isVisible || !this.data.isAdmin || this._isUnloaded) return;
      await this.refreshDashboard({ silent: true });
      this.startPolling();
    }, POLL_INTERVAL_MS);
  },

  stopPolling() {
    if (!this._pollTimer) return;
    clearTimeout(this._pollTimer);
    this._pollTimer = null;
  },

  onPullDownRefresh() {
    return this.refreshDashboard({ silent: true });
  },

  onReachBottom() {
    if (this.data.hasMore) return this.loadInquiries({ reset: false });
    return false;
  },

  selectStatus(event) {
    const status = event.currentTarget.dataset.status || "all";
    if (status === this.data.activeStatus) return;
    this.setData({ activeStatus: status });
    this.loadInquiries({ reset: true });
  },

  selectClaimFilter(event) {
    const filter = event.currentTarget.dataset.filter || "all";
    if (filter === this.data.activeClaimFilter) return;
    this.setData({ activeClaimFilter: filter });
    this.loadInquiries({ reset: true });
  },

  onKeywordInput(event) {
    this.setData({ keyword: event.detail.value || "" });
  },

  searchInquiries() {
    this.loadInquiries({ reset: true });
  },

  clearKeyword() {
    this.setData({ keyword: "" });
    this.loadInquiries({ reset: true });
  },

  openDetail(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/inquiry-admin/detail?id=${encodeURIComponent(id)}` });
  },

  retry() {
    return this.refreshDashboard({ silent: false });
  },
});
