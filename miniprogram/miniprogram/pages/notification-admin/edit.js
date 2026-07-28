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
    caseDocId: "",
    sendSubscription: true,
  };
}

Page({
  data: {
    id: "",
    isEdit: false,
    saving: false,
    draft: createDraft(),
    topTips: { show: false, message: "", type: "error" },
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
        draft: {
          type: item.type || "version_update",
          title: item.title || "",
          content: item.content || "",
          version: item.version || "",
          caseDocId: item.caseDocId || "",
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

  onCaseIdInput(event) {
    this.setData({ "draft.caseDocId": event.detail.value || "" });
  },

  onSendChange(event) {
    this.setData({ "draft.sendSubscription": event.detail.value === true });
  },

  validate() {
    const draft = this.data.draft;
    if (!draft.title.trim()) return "请填写通知标题";
    if (!draft.content.trim()) return "请填写通知内容";
    if (draft.type === "product_new" && !draft.caseDocId.trim()) return "请填写关联案例文档 ID";
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
        caseDocId: this.data.draft.caseDocId,
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
      wx.showToast({ title: publishNow ? "已发布" : "草稿已保存", icon: "none" });
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
