const { fetchCaseById } = require("../../utils/cloudData");
const {
  CONTACT_MAX_LENGTH,
  CONTENT_MAX_LENGTH,
  buildInquiryDraftFromCase,
  getInquiryOptionGroups,
  normalizeInquiryDraft,
  validateInquiryDraft,
} = require("./utils/inquiryData");
const { submitInquiry } = require("./utils/inquiryService");

const SOURCE_PAGE_MAP = {
  profile: "pages/profile/index",
  detail: "pages/detail/index",
};

const CONTACT_TYPE_OPTIONS = [
  {
    label: "微信号",
    placeholder: "请输入微信号",
  },
  {
    label: "手机号",
    placeholder: "请输入手机号",
  },
  {
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
      options: group.options.map((label) => ({
        label,
        selected: selectedValues.includes(label),
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
    }),
    optionGroups: buildOptionGroups({
      source: "profile",
      wineType: "白酒",
    }),
    contentMaxLength: CONTENT_MAX_LENGTH,
    contactMaxLength: CONTACT_MAX_LENGTH,
    contactTypes: CONTACT_TYPE_OPTIONS.map((option) => option.label),
    contactTypeIndex: 0,
    selectedContactType: CONTACT_TYPE_OPTIONS[0].label,
    contactPlaceholder: CONTACT_TYPE_OPTIONS[0].placeholder,
    submitting: false,
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

    this.setData({
      contactTypeIndex: validIndex,
      selectedContactType: CONTACT_TYPE_OPTIONS[validIndex].label,
      contactPlaceholder: CONTACT_TYPE_OPTIONS[validIndex].placeholder,
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

  async submitForm() {
    if (this.data.submitting) return;

    const validation = validateInquiryDraft(this.data.draft);
    if (!validation.valid) {
      this.showTopTips(validation.message);
      wx.showToast({
        title: validation.message,
        icon: "none",
      });
      return;
    }

    this.setData({
      submitting: true,
    });

    try {
      await submitInquiry(validation.data, {
        source: this.data.source,
        sourcePage: this.data.sourcePage,
      });

      wx.showToast({
        title: "已收到需求，我们会尽快联系你",
        icon: "none",
      });

      setTimeout(() => {
        wx.navigateBack({
          fail() {
            wx.switchTab({
              url: "/pages/profile/index",
            });
          },
        });
      }, 800);
    } catch (error) {
      console.error("需求提交失败", error);
      this.showTopTips(error.code === "INVALID_INQUIRY" ? error.message : "提交失败，请稍后重试");
      wx.showToast({
        title: error.code === "INVALID_INQUIRY" ? error.message : "提交失败，请稍后重试",
        icon: "none",
      });
    } finally {
      this.setData({
        submitting: false,
      });
    }
  },
});
