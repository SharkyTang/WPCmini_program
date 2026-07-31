const {
  DEFAULT_NICKNAME,
  cacheProfile,
  fetchSessionSummary,
  getLegacyProfile,
  hasCompletedProfile,
} = require("../../utils/profileService");
const {
  cacheCompletedProfileIdentity,
  cacheOpenId,
} = require("../../utils/userService");
const {
  CUSTOMER_SERVICE_SOURCE,
  buildCustomerSessionFrom,
} = require("../../utils/customerServiceData");
const HOME_SHARE_TITLE = "金亿诚包装科技｜酒包装灵感库";
const DEFAULT_PROFILE_INFO = {
  nickname: DEFAULT_NICKNAME,
  avatarUrl: "",
  note: "点击使用微信头像和名称",
};

function toProfileInfo(profile = {}) {
  const nickname = typeof profile.nickname === "string" ? profile.nickname.trim() : "";
  const avatarUrl = typeof profile.avatarUrl === "string" ? profile.avatarUrl : "";
  const complete = hasCompletedProfile(profile);
  return {
    nickname: nickname || DEFAULT_PROFILE_INFO.nickname,
    avatarUrl,
    note: complete ? "点击修改头像和名称" : DEFAULT_PROFILE_INFO.note,
  };
}

Page({
  data: {
    profileInfo: DEFAULT_PROFILE_INFO,
    hasCompletedProfile: false,
    isProfileLoading: false,
    profileLoadError: false,
    hasInquiryAdminAccess: false,
    checkingInquiryAdminAccess: false,
    hasCaseAdminAccess: false,
    checkingCaseAdminAccess: false,
    hasNotificationAdminAccess: false,
    checkingNotificationAdminAccess: false,
    quickActions: [
      { key: "favorites", iconSrc: "/assets/profile/icon-favorite.png", title: "我的收藏" },
      { key: "history", iconSrc: "/assets/profile/icon-history.png", title: "浏览记录" },
      { key: "notice", iconSrc: "/assets/profile/icon-notice.png", title: "消息通知" },
      { key: "service", iconSrc: "/assets/profile/icon-service.png", title: "咨询客服" },
      { key: "feedback", iconSrc: "/assets/profile/icon-feedback.png", title: "意见反馈" },
      { key: "contact", iconSrc: "/assets/profile/icon-contact.png", title: "联系我们" },
    ],
    customerServiceSessionFrom: buildCustomerSessionFrom({
      source: CUSTOMER_SERVICE_SOURCE.PROFILE,
    }),
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

  onLoad() {
    // 资料在 onShow 读取，保证从编辑页返回后立即同步最新头像和昵称。
  },

  onShow() {
    this.loadProfileInfo();
  },

  onPullDownRefresh() {
    this.loadProfileInfo({ stopRefresh: true, forceRefresh: true });
  },

  onShareAppMessage() {
    return {
      title: HOME_SHARE_TITLE,
      path: "/pages/index/index",
    };
  },

  onShareTimeline() {
    return {
      title: HOME_SHARE_TITLE,
    };
  },

  async loadProfileInfo(options = {}) {
    const legacyProfile = getLegacyProfile();
    this.setData({
      profileInfo: toProfileInfo(legacyProfile),
      // 本机缓存只用于首屏和导航判断；云端请求仍会在完成后覆盖它。
      // 这样已完成资料的用户无需等请求结束，第一次点击即可进入编辑页。
      hasCompletedProfile: hasCompletedProfile(legacyProfile),
      isProfileLoading: true,
      profileLoadError: false,
    });

    try {
      const summary = await fetchSessionSummary({
        forceRefresh: options.forceRefresh === true,
      });
      const profile = summary.profile;
      cacheOpenId(summary.openid);
      this.setData({
        hasInquiryAdminAccess: summary.roles.inquiryAdmin,
        hasCaseAdminAccess: summary.roles.caseAdmin,
        hasNotificationAdminAccess: summary.roles.notificationAdmin,
        checkingInquiryAdminAccess: false,
        checkingCaseAdminAccess: false,
        checkingNotificationAdminAccess: false,
      });
      if (profile && hasCompletedProfile(profile)) {
        cacheProfile(profile);
        cacheCompletedProfileIdentity(summary.openid, profile);
        this.setData({
          profileInfo: toProfileInfo(profile),
          hasCompletedProfile: true,
        });
      }
    } catch (error) {
      console.error("读取个人资料失败", error);
      this.setData({
        profileLoadError: true,
      });
    } finally {
      this.setData({
        isProfileLoading: false,
      });
      if (options.stopRefresh && wx.stopPullDownRefresh) {
        wx.stopPullDownRefresh();
      }
    }
  },

  openProfileEditor() {
    const mode = this.data.hasCompletedProfile ? "edit" : "setup";
    wx.navigateTo({
      url: `/pages/profile/edit/index?mode=${mode}`,
    });
  },

  handleQuickAction(event) {
    const key = event.currentTarget.dataset.key;
    if (key === "favorites") {
      wx.navigateTo({ url: "/pages/favorites/index" });
      return;
    }
    if (key === "history") {
      wx.navigateTo({ url: "/pages/history/index" });
      return;
    }
    if (key === "notice") {
      wx.navigateTo({ url: "/pages/notifications/index" });
      return;
    }
    if (key === "feedback") {
      wx.navigateTo({ url: "/pages/feedback/index?source=profile" });
      return;
    }
    if (key === "contact") {
      wx.navigateTo({ url: "/pages/contact/index" });
      return;
    }

    wx.showToast({ title: "入口后续开放", icon: "none" });
  },

  openInquiryForm() {
    wx.navigateTo({ url: "/pages/inquiry/index?source=profile" });
  },

  openInquiryAdmin() {
    wx.navigateTo({ url: "/pages/inquiry-admin/index" });
  },

  openCaseAdmin() {
    wx.navigateTo({ url: "/pages/case-admin/index" });
  },

  openNotificationAdmin() {
    wx.navigateTo({ url: "/pages/notification-admin/index" });
  },

  handleContact(event) {
    console.log("客服会话入口", event.detail || {});
  },
});
