const {
  createAnnouncement,
  fetchAnnouncementDetail,
  publishAnnouncement,
  updateAnnouncement,
} = require("../../utils/notificationAdminService");

function createDraft() {
  return {
    type: "version_update",
    title: "",
    content: "",
    version: "",
    caseDocIds: [],
    sendSubscription: true,
  };
}

Page({
  data: {
    id: "",
    isEdit: false,
    publishStatus: "draft",
    saving: false,
    draft: createDraft(),
    topTips: { show: false, message: "", type: "error" },
    selectedCases: [],
  },

  onLoad(options = {}) {
    if (options.id) {
      this.setData({ id: options.id, isEdit: true });
      this.loadAnnouncement(options.id);
    }
  },

  async loadAnnouncement(id) {
    try {
      const item = await fetchAnnouncementDetail(id);
      this.setData({
        publishStatus: item.publishStatus || "draft",
        selectedCases: item.linkedCaseItems || [],
        draft: {
          type: item.type || "version_update",
          title: item.title || "",
          content: item.content || "",
          version: item.version || "",
          caseDocIds: item.caseDocIds || [item.caseDocId].filter(Boolean),
          sendSubscription: true,
        },
      });
    } catch (error) {
      this.showTopTips(error.message || "通知读取失败");
    }
  },

  hideTopTips() {
    this.setData({ "topTips.show": false });
  },

  showTopTips(message) {
    this.setData({
      topTips: { show: true, message, type: "error" },
    });
  },

  selectType(event) {
    if (this.data.publishStatus !== "draft") return;
    const type = event.currentTarget.dataset.type;
    if (type) this.setData({ "draft.type": type });
  },

  onTitleInput(event) {
    this.setData({ "draft.title": event.detail.value || "" });
  },

  onContentInput(event) {
    this.setData({ "draft.content": event.detail.value || "" });
  },

  onVersionInput(event) {
    this.setData({ "draft.version": event.detail.value || "" });
  },

  chooseCases() {
    if (this.data.publishStatus !== "draft") return;
    wx.navigateTo({
      url: "/pages/notification-cases/index?mode=select",
      events: {
        confirmSelection: (payload = {}) => {
          this.setData({
            "draft.caseDocIds": payload.caseDocIds || [],
            selectedCases: payload.items || [],
          });
        },
      },
      success: (response) => {
        if (!response.eventChannel) return;
        response.eventChannel.emit("initSelection", {
          caseDocIds: this.data.draft.caseDocIds || [],
          items: this.data.selectedCases || [],
        });
      },
    });
  },

  clearCases() {
    if (this.data.publishStatus !== "draft") return;
    this.setData({
      "draft.caseDocIds": [],
      selectedCases: [],
    });
  },

  onSendChange(event) {
    this.setData({ "draft.sendSubscription": event.detail.value === true });
  },

  validate() {
    const draft = this.data.draft;
    if (!draft.title.trim()) return "请填写通知标题";
    if (!draft.content.trim()) return "请填写通知内容";
    if (draft.type === "product_new" && !draft.caseDocIds.length) return "请至少选择一个上新案例";
    return "";
  },

  async persist(publishNow) {
    const validationMessage = this.validate();
    if (validationMessage) {
      this.showTopTips(validationMessage);
      return;
    }

    this.setData({ saving: true });
    try {
      const announcement = {
        type: this.data.draft.type,
        title: this.data.draft.title,
        content: this.data.draft.content,
        version: this.data.draft.version,
        caseDocIds: this.data.draft.caseDocIds,
      };
      let id = this.data.id;
      if (id) {
        await updateAnnouncement(id, announcement);
      } else {
        const result = await createAnnouncement(announcement);
        id = result.id;
        this.setData({ id });
      }
      if (publishNow) {
        await publishAnnouncement(id, this.data.draft.sendSubscription);
      }
      const successTitle = publishNow
        ? "已发布"
        : this.data.publishStatus === "draft"
          ? "草稿已保存"
          : "修改已保存";
      wx.showToast({ title: successTitle, icon: "none" });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 350);
    } catch (error) {
      console.error("通知保存失败", error);
      this.showTopTips(error.message || "通知保存失败");
    } finally {
      this.setData({ saving: false });
    }
  },

  saveDraft() {
    return this.persist(false);
  },

  publishNow() {
    return this.persist(true);
  },
});
