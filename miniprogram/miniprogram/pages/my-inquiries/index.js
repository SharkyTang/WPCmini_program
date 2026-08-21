const {
  fetchMyInquiryList,
  fetchMyInquirySummary,
} = require("./utils/myInquiryService");

Page({
  data: {
    loading: false,
    loadingMore: false,
    errorMessage: "",
    items: [],
    nextCursor: "",
    hasMore: false,
    unreadCount: 0,
  },

  onShow() {
    this.loadList({ reset: true });
  },

  onPullDownRefresh() {
    this.loadList({ reset: true, stopRefresh: true });
  },

  onReachBottom() {
    if (this.data.hasMore) this.loadList({ reset: false });
  },

  async loadList(options = {}) {
    const reset = options.reset !== false;
    if (this.data.loading || this.data.loadingMore) return;
    this.setData({
      loading: reset,
      loadingMore: !reset,
      errorMessage: "",
    });
    try {
      const [result, summary] = await Promise.all([
        fetchMyInquiryList({
          cursor: reset ? "" : this.data.nextCursor,
          pageSize: 20,
        }),
        reset ? fetchMyInquirySummary() : Promise.resolve(null),
      ]);
      this.setData({
        items: reset ? result.items : this.data.items.concat(result.items),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        unreadCount: summary ? summary.unreadCount : this.data.unreadCount,
      });
    } catch (error) {
      console.error("我的需求加载失败", error);
      this.setData({
        errorMessage: error.message || "我的需求加载失败，请稍后重试",
      });
    } finally {
      this.setData({ loading: false, loadingMore: false });
      if (options.stopRefresh && wx.stopPullDownRefresh) wx.stopPullDownRefresh();
    }
  },

  openDetail(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/my-inquiries/detail?id=${encodeURIComponent(id)}`,
    });
  },

  openInquiryForm() {
    wx.navigateTo({ url: "/pages/inquiry/index?source=profile" });
  },

  retry() {
    this.loadList({ reset: true });
  },
});
