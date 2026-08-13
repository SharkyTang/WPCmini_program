const DATA_ACTIONS = {
  profile: "/pages/profile/edit/index?mode=edit",
  favorites: "/pages/favorites/index",
  history: "/pages/history/index",
};

Page({
  openDataAction(event) {
    const key = event.currentTarget.dataset.key;
    const url = DATA_ACTIONS[key];
    if (!url) return;
    wx.navigateTo({
      url,
      fail() {
        wx.showToast({
          title: "页面暂时无法打开，请重试",
          icon: "none",
        });
      },
    });
  },

  handleDeletionContact(event) {
    console.log("数据删除申请客服入口", event.detail || {});
  },
});
