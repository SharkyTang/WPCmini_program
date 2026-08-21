const { fetchCaseById } = require("../../utils/cloudData");
const {
  CONTACT_MAX_LENGTH,
  CONTENT_MAX_LENGTH,
  buildInquiryDraftFromCase,
  getInquiryOptionLabel,
  getInquiryOptionGroups,
  normalizeInquiryDraft,
  validateInquiryDraft,
} = require("./utils/inquiryData");
const { submitInquiry } = require("./utils/inquiryService");
const { subscribeToInquiryReply } = require("../../utils/inquiryFollowupService");

const SOURCE_PAGE_MAP = {
  profile: "pages/profile/index",
  detail: "pages/detail/index",
};

const CONTACT_TYPE_OPTIONS = [
  {
    value: "wechat",
    label: "微信号",
    placeholder: "请输入微信号",
  },
  {
    value: "phone",
    label: "手机号",
    placeholder: "请输入手机号",
  },
  {
    value: "email",
    label: "邮箱",
    placeholder: "请输入邮箱",
  },
];

function getSource(value) {
  return value === "detail" ? "detail" : "profile";
}

function getSourcePage(source) {
  return SOURCE_PAGE_MAP[source] || SOURCE_PAGE_MAP.profile;
}

function buildOptionGroups(draft) {
  const normalized = normalizeInquiryDraft(draft);
  return getInquiryOptionGroups().map((group) => {
    const selectedValues = group.type === "multi"
      ? normalized[group.key] || []
      : [normalized[group.key]].filter(Boolean);

    return {
      ...group,
      options: group.options.map((value) => ({
        value,
        label: getInquiryOptionLabel(group.key, value),
        selected: selectedValues.includes(value),
      })),
    };
  });
}

Page({
  data: {
    source: "profile",
    sourcePage: SOURCE_PAGE_MAP.profile,
    caseLoading: false,
    caseError: "",
    caseItem: null,
    draft: normalizeInquiryDraft({
      source: "profile",
      wineType: "白酒",
      contactType: CONTACT_TYPE_OPTIONS[0].value,
    }),
    optionGroups: buildOptionGroups({
      source: "profile",
      wineType: "白酒",
      contactType: CONTACT_TYPE_OPTIONS[0].value,
    }),
    contentMaxLength: CONTENT_MAX_LENGTH,
    contactMaxLength: CONTACT_MAX_LENGTH,
    contactTypes: CONTACT_TYPE_OPTIONS.map((option) => option.label),
    contactTypeIndex: 0,
    selectedContactType: CONTACT_TYPE_OPTIONS[0].label,
    contactPlaceholder: CONTACT_TYPE_OPTIONS[0].placeholder,
    submitting: false,
    submitSucceeded: false,
    submittedInquiryId: "",
    alertStatus: "deferred",
    replySubscription: {
      enabled: false,
      templateId: "",
    },
    subscribing: false,
    topTips: {
      show: false,
      message: "",
      type: "error",
    },
  },

  onLoad(options = {}) {
    const source = getSource(options.source);
    const nextDraft = normalizeInquiryDraft({
      ...this.data.draft,
      source,
    });

    this.setData({
      source,
      sourcePage: getSourcePage(source),
    });
    this.updateDraft(nextDraft);

    if (source === "detail" && options.id) {
      this.loadCaseDefaults(decodeURIComponent(options.id));
    }
  },

  async loadCaseDefaults(id) {
    this.setData({
      caseLoading: true,
      caseError: "",
    });

    try {
      const caseItem = await fetchCaseById(id);
      const caseDraft = buildInquiryDraftFromCase(caseItem);
      this.setData({
        caseLoading: false,
        caseItem,
      });
      this.updateDraft({
        ...caseDraft,
        source: "detail",
        content: this.data.draft.content,
        contact: this.data.draft.contact,
        contactType: this.data.draft.contactType,
      });
    } catch (error) {
      console.warn("需求页案例读取失败", error);
      this.setData({
        caseLoading: false,
        caseError: "参考案例暂时读取失败，你仍然可以直接填写需求。",
      });
    }
  },

  updateDraft(nextDraft) {
    const draft = normalizeInquiryDraft(nextDraft);
    this.setData({
      draft,
      optionGroups: buildOptionGroups(draft),
    });
  },

  toggleOption(event) {
    const { key, type, value } = event.currentTarget.dataset;
    const draft = {
      ...this.data.draft,
    };

    if (type === "multi") {
      const values = draft[key] || [];
      draft[key] = values.includes(value)
        ? values.filter((item) => item !== value)
        : values.concat(value);
    } else if (key === "wineType") {
      draft[key] = value;
    } else {
      draft[key] = draft[key] === value ? "" : value;
    }

    this.updateDraft(draft);
  },

  updateContent(event) {
    this.updateDraft({
      ...this.data.draft,
      content: event.detail.value,
    });
  },

  updateContact(event) {
    this.updateDraft({
      ...this.data.draft,
      contact: event.detail.value,
    });
  },

  changeContactType(event) {
    const nextIndex = Number(event.detail.value);
    const validIndex = Number.isInteger(nextIndex)
      && nextIndex >= 0
      && nextIndex < CONTACT_TYPE_OPTIONS.length
      ? nextIndex
      : 0;

    const selectedOption = CONTACT_TYPE_OPTIONS[validIndex];
    this.setData({
      contactTypeIndex: validIndex,
      selectedContactType: selectedOption.label,
      contactPlaceholder: selectedOption.placeholder,
    });
    this.updateDraft({
      ...this.data.draft,
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

    const validation = validateInquiryDraft(this.data.draft);
    if (!validation.valid) {
      this.showTopTips(validation.message);
      return;
    }

    this.setData({
      submitting: true,
    });

    try {
      const result = await submitInquiry(validation.data, {
        source: this.data.source,
        sourcePage: this.data.sourcePage,
      });
      this.setData({
        submitSucceeded: true,
        submittedInquiryId: result.id,
        alertStatus: result.alertStatus || "deferred",
        replySubscription: result.replySubscription,
      });
    } catch (error) {
      console.error("需求提交失败", error);
      this.showTopTips(error.code === "INVALID_INQUIRY" ? error.message : "提交失败，请稍后重试");
    } finally {
      this.setData({
        submitting: false,
      });
    }
  },

  async subscribeReply() {
    if (this.data.subscribing) return;
    const { enabled, templateId } = this.data.replySubscription || {};
    if (!enabled || !templateId) {
      wx.showToast({
        title: "微信提醒尚未启用，回复仍会保存在“我的需求”",
        icon: "none",
      });
      return;
    }
    this.setData({ subscribing: true });
    try {
      const result = await subscribeToInquiryReply(
        this.data.submittedInquiryId,
        templateId
      );
      wx.showToast({
        title: result.accepted ? "已开启回复提醒" : "未开启提醒，可稍后再试",
        icon: "none",
      });
    } catch (error) {
      console.error("需求回复订阅失败", error);
      wx.showToast({ title: error.message || "订阅失败，请稍后再试", icon: "none" });
    } finally {
      this.setData({ subscribing: false });
    }
  },

  openMyInquiry() {
    const id = this.data.submittedInquiryId;
    const url = id
      ? `/pages/my-inquiries/detail?id=${encodeURIComponent(id)}`
      : "/pages/my-inquiries/index";
    wx.redirectTo({ url });
  },

  finishSubmission() {
    wx.navigateBack({
      fail() {
        wx.switchTab({ url: "/pages/profile/index" });
      },
    });
  },
});
