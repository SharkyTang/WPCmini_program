Page({
  data: {
    quickActions: [
      { key: "favorites", icon: "♡", title: "我的收藏" },
      { key: "history", icon: "◷", title: "浏览记录" },
      { key: "notice", icon: "♢", title: "消息通知" },
      { key: "service", icon: "☎", title: "联系客服" },
    ],
    flowSteps: [
      { step: "1", title: "沟通需求", subtitle: "确认酒类、包装类型、预算定位" },
      { step: "2", title: "确认方向", subtitle: "选择风格参考与包装组合" },
      { step: "3", title: "设计打样", subtitle: "出设计方案并确认材质工艺" },
      { step: "4", title: "批量制作", subtitle: "确认样品后进入生产交付" },
    ],
    faqItems: [
      { key: "draft", title: "没有设计稿可以做吗？", subtitle: "可以，根据酒类和包装需求整理方向。" },
      { key: "single", title: "可以只做单项包装吗？", subtitle: "可以，支持瓶标、礼盒、手提袋等单项定制。" },
      { key: "time", title: "多久可以看到方案？", subtitle: "根据需求复杂度沟通确认。" },
      { key: "save", title: "图片可以保存参考吗？", subtitle: "详情页支持查看原图和下载图片。" },
    ],
  },

  handleQuickAction(event) {
    const key = event.currentTarget.dataset.key;
    if (key === "favorites") {
      wx.navigateTo({
        url: "/pages/favorites/index",
      });
      return;
    }
    if (key === "history") {
      wx.navigateTo({
        url: "/pages/history/index",
      });
      return;
    }

    wx.showToast({
      title: "入口后续开放",
      icon: "none",
    });
  },
});
