const {
  DEFAULT_NICKNAME,
  cacheProfile,
  fetchProfile,
  getLegacyProfile,
  hasCompletedProfile,
} = require("../../utils/profileService");
const {
  CUSTOMER_SERVICE_SOURCE,
  buildCustomerSessionFrom,
} = require("../../utils/customerServiceData");
const {
  checkInquiryAdminAccess,
} = require("../../utils/inquiryAdminService");
const {
  checkCaseAdminAccess,
} = require("../../utils/caseAdminService");

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
    quickActions: [
      { key: "favorites", iconSrc: "/assets/profile/icon-favorite.png", title: "我的收藏" },
      { key: "history", iconSrc: "/assets/profile/icon-history.png", title: "浏览记录" },
      { key: "notice", iconSrc: "/assets/profile/icon-notice.png", title: "消息通知" },
      { key: "service", iconSrc: "/assets/profile/icon-service.png", title: "联系客服" },
      { key: "feedback", iconSrc: "/assets/profile/icon-feedback.png", title: "意见反馈" },
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
    this.refreshInquiryAdminAccess();
    this.refreshCaseAdminAccess();
  },

  onPullDownRefresh() {
    this.loadProfileInfo({ stopRefresh: true });
  },

  async loadProfileInfo(options = {}) {
    const legacyProfile = getLegacyProfile();
    this.setData({
      profileInfo: toProfileInfo(legacyProfile),
      hasCompletedProfile: false,
      isProfileLoading: true,
      profileLoadError: false,
    });

    try {
      const profile = await fetchProfile();
      if (profile && hasCompletedProfile(profile)) {
        cacheProfile(profile);
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
    if (this.data.isProfileLoading) {
      wx.showToast({ title: "正在读取资料", icon: "none" });
      return;
    }
    if (this.data.profileLoadError) {
      wx.showToast({
        title: "资料读取失败，请下拉重试",
        icon: "none",
      });
      return;
    }

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

    wx.showToast({ title: "入口后续开放", icon: "none" });
  },

  openInquiryForm() {
    wx.navigateTo({ url: "/pages/inquiry/index?source=profile" });
  },

  async refreshInquiryAdminAccess() {
    if (this.data.checkingInquiryAdminAccess) return;
    this.setData({ checkingInquiryAdminAccess: true });
    const hasInquiryAdminAccess = await checkInquiryAdminAccess();
    this.setData({
      hasInquiryAdminAccess,
      checkingInquiryAdminAccess: false,
    });
  },

  openInquiryAdmin() {
    wx.navigateTo({ url: "/pages/inquiry-admin/index" });
  },

  async refreshCaseAdminAccess() {
    if (this.data.checkingCaseAdminAccess) return;
    this.setData({ checkingCaseAdminAccess: true });
    const hasCaseAdminAccess = await checkCaseAdminAccess();
    this.setData({
      hasCaseAdminAccess,
      checkingCaseAdminAccess: false,
    });
  },

  openCaseAdmin() {
    wx.navigateTo({ url: "/pages/case-admin/index" });
  },

  handleContact(event) {
    console.log("客服会话入口", event.detail || {});
  },
});
