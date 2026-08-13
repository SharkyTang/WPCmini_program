const {
  CONTENT_MAX_LENGTH,
  FEEDBACK_TYPES,
  validateFeedbackDraft,
} = require("./utils/feedbackData");
const { submitFeedback } = require("./utils/feedbackService");

const SOURCE_PAGE_MAP = {
  profile: "pages/profile/index",
};

const CONTACT_TYPE_OPTIONS = [
  { value: "wechat", label: "微信号", placeholder: "请输入微信号" },
  { value: "phone", label: "手机号", placeholder: "请输入手机号" },
  { value: "email", label: "邮箱", placeholder: "请输入邮箱" },
];

Page({
  data: {
    feedbackTypes: FEEDBACK_TYPES,
    selectedType: "",
    content: "",
    contact: "",
    contactType: CONTACT_TYPE_OPTIONS[0].value,
    contactTypes: CONTACT_TYPE_OPTIONS.map((item) => item.label),
    selectedContactTypeIndex: 0,
    selectedContactType: CONTACT_TYPE_OPTIONS[0].label,
    contactPlaceholder: CONTACT_TYPE_OPTIONS[0].placeholder,
    contentMaxLength: CONTENT_MAX_LENGTH,
    submitting: false,
    sourcePage: "",
    topTips: {
      show: false,
      message: "",
      type: "error",
    },
  },

  onLoad(options = {}) {
    this.setData({
      sourcePage: SOURCE_PAGE_MAP[options.source] || "",
    });
  },

  selectType(event) {
    const type = event.currentTarget.dataset.type;
    if (!type) return;

    this.setData({
      selectedType: type,
    });
  },

  updateContent(event) {
    this.setData({
      content: event.detail.value,
    });
  },

  updateContact(event) {
    this.setData({
      contact: event.detail.value,
    });
  },

  changeContactType(event) {
    const index = Number(event.detail.value);
    const selectedOption = CONTACT_TYPE_OPTIONS[index];
    if (!selectedOption) return;

    this.setData({
      selectedContactTypeIndex: index,
      selectedContactType: selectedOption.label,
      contactPlaceholder: selectedOption.placeholder,
      contactType: selectedOption.value,
    });
  },

  showTopTips(message, type = "error") {
    this.setData({
      topTips: {
        show: true,
        message,
        type,
      },
    });
  },

  hideTopTips() {
    this.setData({
      "topTips.show": false,
    });
  },

  openPrivacyNotice() {
    wx.navigateTo({
      url: "/pages/privacy/index",
    });
  },

  async submitForm() {
    if (this.data.submitting) return;

    const draft = {
      type: this.data.selectedType,
      content: this.data.content,
      contact: this.data.contact,
      contactType: this.data.contactType,
    };
    const validation = validateFeedbackDraft(draft);
    if (!validation.valid) {
      this.showTopTips(validation.message);
      return;
    }

    this.setData({
      submitting: true,
    });

    try {
      await submitFeedback(validation.data, {
        sourcePage: this.data.sourcePage,
      });
      wx.showToast({
        title: "已收到反馈，谢谢你",
        icon: "none",
      });

      setTimeout(() => {
        const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
        if (pages.length > 1) {
          wx.navigateBack();
        } else {
          wx.switchTab({
            url: "/pages/profile/index",
          });
        }
      }, 700);
    } catch (error) {
      console.error("意见反馈提交失败", error);
      this.showTopTips("提交失败，请稍后重试");
    } finally {
      this.setData({
        submitting: false,
      });
    }
  },
});
