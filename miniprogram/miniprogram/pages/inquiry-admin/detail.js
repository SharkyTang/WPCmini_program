const {
  CONTACT_TYPE_OPTIONS,
  INQUIRY_STATUS_OPTIONS,
  QUICK_REPLY_OPTIONS,
  buildInquiryTimeline,
  countCharacters,
  getContactCopyLabel,
  getContactTypeLabel,
  getInquiryStatusLabel,
  validateAdminNote,
  validateReplyContent,
} = require("./utils/inquiryAdminData");
const {
  claimInquiry,
  correctContactType,
  createClientMutationId,
  fetchInquiryDetail,
  replyInquiry,
  saveInquiryNote,
  takeOverInquiry,
  updateInquiryStatus,
} = require("./utils/inquiryAdminService");

const DEFAULT_DIALOG = {
  show: false,
  action: "",
  title: "",
  content: "",
  nextIndex: -1,
  nextValue: "",
  nextLabel: "",
  pendingReply: "",
  pendingMutationId: "",
  buttons: [{ text: "取消" }, { text: "确认" }],
};

Page({
  data: {
    id: "",
    loading: true,
    savingStatus: false,
    savingNote: false,
    savingClaim: false,
    sendingReply: false,
    correctingContactType: false,
    errorMessage: "",
    item: null,
    messages: [],
    timeline: [],
    statusOptions: INQUIRY_STATUS_OPTIONS,
    statusIndex: 0,
    contactTypeOptions: CONTACT_TYPE_OPTIONS || [],
    contactTypeIndex: 0,
    quickReplyOptions: QUICK_REPLY_OPTIONS || [],
    replyContent: "",
    replyLength: 0,
    adminNote: "",
    topTips: { show: false, message: "", type: "error" },
    confirmDialog: DEFAULT_DIALOG,
  },

  onLoad(options = {}) {
    this.setData({ id: options.id || "" });
    return this.loadDetail();
  },

  onUnload() {
    this._isUnloaded = true;
  },

  async loadDetail() {
    if (!this.data.id) {
      this.setData({ loading: false, errorMessage: "缺少需求 ID" });
      return false;
    }
    this.setData({ loading: true, errorMessage: "" });
    try {
      const detail = await fetchInquiryDetail(this.data.id);
      const item = detail && detail.item ? detail.item : detail;
      const messages = detail && Array.isArray(detail.messages) ? detail.messages : [];
      const timeline = detail && Array.isArray(detail.timeline)
        ? detail.timeline
        : typeof buildInquiryTimeline === "function"
          ? buildInquiryTimeline(item || {}, messages)
          : [];
      if (!item) throw new Error("需求详情为空");
      const statusIndex = this.data.statusOptions.findIndex(
        (option) => option.value === item.status
      );
      const contactTypeIndex = this.data.contactTypeOptions.findIndex(
        (option) => option.value === item.contactType
      );
      if (this._isUnloaded) return false;
      this.setData({
        item,
        messages,
        timeline,
        adminNote: item.adminNote,
        statusIndex: statusIndex >= 0 ? statusIndex : 0,
        contactTypeIndex: contactTypeIndex >= 0 ? contactTypeIndex : 0,
      });
      return true;
    } catch (error) {
      console.error("需求详情加载失败", error);
      if (!this._isUnloaded) {
        this.setData({ errorMessage: error.message || "需求详情加载失败" });
      }
      return false;
    } finally {
      if (!this._isUnloaded) this.setData({ loading: false });
    }
  },

  copyContact() {
    const contact = this.data.item && this.data.item.contact;
    if (!contact) {
      wx.showToast({ title: "暂无联系方式", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: contact,
      success: () => {
        wx.showToast({
          title: `已${(this.data.item && this.data.item.contactCopyLabel) || "复制联系方式"}`,
          icon: "none",
        });
      },
    });
  },

  goToCaseDetail() {
    const item = this.data.item;
    if (!item || !item.caseDocId) {
      wx.showToast({ title: "暂无参考案例", icon: "none" });
      return;
    }
    wx.navigateTo({ url: `/pages/detail/index?id=${encodeURIComponent(item.caseDocId)}` });
  },

  onStatusChange(event) {
    const nextIndex = Number(event.detail.value);
    const nextOption = this.data.statusOptions[nextIndex];
    if (!nextOption || !this.data.item || nextOption.value === this.data.item.status) return;
    this.openConfirmDialog({
      action: "status",
      title: "确认修改需求状态？",
      content: `将状态从“${this.data.item.statusLabel}”改为“${nextOption.label}”。`,
      nextIndex,
      nextValue: nextOption.value,
      nextLabel: nextOption.label,
      confirmText: "确认修改",
    });
  },

  openConfirmDialog(options = {}) {
    this.setData({
      confirmDialog: {
        ...DEFAULT_DIALOG,
        ...options,
        show: true,
        buttons: [
          { text: "取消" },
          { text: options.confirmText || "确认", extClass: "dialog-button-primary" },
        ],
      },
    });
  },

  closeConfirmDialog() {
    this.setData({ "confirmDialog.show": false });
  },

  async handleConfirmDialogTap(event) {
    const index = event.detail && event.detail.index;
    const dialog = this.data.confirmDialog;
    this.closeConfirmDialog();
    if (index !== 1) return;
    if (dialog.action === "status" || (!dialog.action && dialog.nextValue)) {
      await this.performStatusUpdate(dialog);
      return;
    }
    if (dialog.action === "takeover") {
      await this.performClaim(true);
      return;
    }
    if (dialog.action === "takeoverAndReply") {
      const claimed = await this.performClaim(true);
      if (claimed) {
        await this.performReply(dialog.pendingReply, dialog.pendingMutationId);
      }
      return;
    }
    if (dialog.action === "contactType") {
      await this.performContactTypeCorrection(dialog);
    }
  },

  async performStatusUpdate(dialog) {
    if (!dialog.nextValue || !this.data.item || this.data.savingStatus) return false;
    this.setData({ savingStatus: true });
    try {
      const status = await updateInquiryStatus(this.data.id, dialog.nextValue);
      this.setData({
        item: { ...this.data.item, status, statusLabel: dialog.nextLabel },
        statusIndex: dialog.nextIndex,
      });
      wx.showToast({ title: "状态已更新", icon: "none" });
      return true;
    } catch (error) {
      this.showTopTips(error.message || "状态更新失败");
      return false;
    } finally {
      this.setData({ savingStatus: false });
    }
  },

  handleClaimTap() {
    const claim = this.data.item && this.data.item.claim;
    if (claim && claim.isMine) {
      wx.showToast({ title: "该需求已由你跟进", icon: "none" });
      return;
    }
    if (claim && claim.isClaimed) {
      this.openTakeOverDialog();
      return;
    }
    this.performClaim(false);
  },

  openTakeOverDialog(pendingReply = "", pendingMutationId = "") {
    this.openConfirmDialog({
      action: pendingReply ? "takeoverAndReply" : "takeover",
      title: "确认接手该需求？",
      content: pendingReply
        ? "该需求已由其他管理员认领。接手后将继续发送当前回复。"
        : "该需求已由其他管理员认领，接手后跟进人将变更为你。",
      pendingReply,
      pendingMutationId,
      confirmText: "确认接手",
    });
  },

  async performClaim(takeOver) {
    if (!this.data.item || this.data.savingClaim) return false;
    const expectedClaimedBy = takeOver
      && this.data.item.claim
      && this.data.item.claim.claimedBy
      ? this.data.item.claim.claimedBy
      : "";
    this.setData({ savingClaim: true });
    try {
      const result = takeOver
        ? await takeOverInquiry(this.data.id, expectedClaimedBy)
        : await claimInquiry(this.data.id);
      const item = { ...this.data.item, claim: result.claim };
      item.claimState = result.claim.state;
      item.claimLabel = result.claim.label;
      const timeline = typeof buildInquiryTimeline === "function"
        ? buildInquiryTimeline(item, this.data.messages)
        : this.data.timeline;
      this.setData({ item, timeline });
      wx.showToast({ title: takeOver ? "已接手跟进" : "已认领需求", icon: "none" });
      return true;
    } catch (error) {
      if (error.code === "CLAIM_CONFLICT") {
        if (error.claim && this.data.item) {
          const item = { ...this.data.item, claim: error.claim };
          item.claimState = error.claim.state;
          item.claimLabel = error.claim.label;
          this.setData({ item });
        }
        this.openTakeOverDialog();
      } else {
        this.showTopTips(error.message || "认领失败");
      }
      return false;
    } finally {
      this.setData({ savingClaim: false });
    }
  },

  selectQuickReply(event) {
    const index = Number(event.currentTarget.dataset.index);
    const option = this.data.quickReplyOptions[index];
    if (!option || this.data.sendingReply) return;
    this._pendingReplyMutationId = "";
    this.setData({
      replyContent: option.content,
      replyLength: typeof countCharacters === "function"
        ? countCharacters(option.content)
        : option.content.length,
    });
  },

  onReplyInput(event) {
    const replyContent = event.detail.value || "";
    this._pendingReplyMutationId = "";
    this.setData({
      replyContent,
      replyLength: typeof countCharacters === "function"
        ? countCharacters(replyContent)
        : replyContent.length,
    });
  },

  async sendReply() {
    const validation = validateReplyContent(this.data.replyContent);
    if (!validation.valid) {
      this.showTopTips(validation.message);
      return false;
    }
    const mutationId = this._pendingReplyMutationId
      || (typeof createClientMutationId === "function" ? createClientMutationId() : `mini-${Date.now()}`);
    this._pendingReplyMutationId = mutationId;
    return this.performReply(validation.replyContent, mutationId);
  },

  async performReply(content, mutationId) {
    if (!this.data.item || this.data.sendingReply) return false;
    this.setData({ sendingReply: true });
    try {
      const result = await replyInquiry(this.data.id, content, mutationId);
      const messages = result.message && (result.message.id || result.message.content)
        ? this.data.messages.filter((message) => message.id !== result.message.id).concat(result.message)
        : this.data.messages;
      const statusLabel = typeof getInquiryStatusLabel === "function"
        ? getInquiryStatusLabel(result.status)
        : result.status;
      const item = {
        ...this.data.item,
        status: result.status,
        statusLabel,
        claim: result.claim && result.claim.isClaimed ? result.claim : this.data.item.claim,
        lastReply: result.message ? {
          content: result.message.content,
          contentPreview: result.message.content,
          createdAt: result.message.createdAt,
          createdAtText: result.message.createdAtText,
          createdByOpenid: result.message.createdByOpenid,
        } : this.data.item.lastReply,
      };
      item.claimState = item.claim ? item.claim.state : "unclaimed";
      item.claimLabel = item.claim ? item.claim.label : "未认领";
      const nextStatusIndex = this.data.statusOptions.findIndex(
        (option) => option.value === result.status
      );
      this.setData({
        item,
        messages,
        timeline: typeof buildInquiryTimeline === "function"
          ? buildInquiryTimeline(item, messages)
          : this.data.timeline,
        statusIndex: nextStatusIndex >= 0 ? nextStatusIndex : this.data.statusIndex,
        replyContent: "",
        replyLength: 0,
      });
      this._pendingReplyMutationId = "";
      if (result.pushNotice && result.pushNotice.type === "warning") {
        this.showTopTips(result.pushNotice.message, "warn");
      } else {
        wx.showToast({
          title: (result.pushNotice && result.pushNotice.message) || "回复已保存",
          icon: "none",
        });
      }
      return true;
    } catch (error) {
      if (error.code === "CLAIM_CONFLICT") {
        if (error.claim && this.data.item) {
          const item = { ...this.data.item, claim: error.claim };
          item.claimState = error.claim.state;
          item.claimLabel = error.claim.label;
          this.setData({ item });
        }
        this.openTakeOverDialog(content, mutationId);
      } else {
        this.showTopTips(error.message || "回复发送失败");
      }
      return false;
    } finally {
      this.setData({ sendingReply: false });
    }
  },

  onContactTypeChange(event) {
    const nextIndex = Number(event.detail.value);
    const nextOption = this.data.contactTypeOptions[nextIndex];
    if (!nextOption || !this.data.item) return;
    if (
      nextOption.value === this.data.item.contactType
      && this.data.item.contactTypeSource === "admin_corrected"
    ) return;
    this.openConfirmDialog({
      action: "contactType",
      title: "确认联系方式类型？",
      content: `将客户联系方式标注为“${nextOption.label}”。该操作会记录管理员确认结果。`,
      nextIndex,
      nextValue: nextOption.value,
      nextLabel: nextOption.label,
      confirmText: "确认类型",
    });
  },

  async performContactTypeCorrection(dialog) {
    if (!dialog.nextValue || !this.data.item || this.data.correctingContactType) return false;
    this.setData({ correctingContactType: true });
    try {
      const result = await correctContactType(this.data.id, dialog.nextValue);
      const contactType = result.contactType;
      this.setData({
        item: {
          ...this.data.item,
          contactType,
          contactTypeLabel: typeof getContactTypeLabel === "function"
            ? getContactTypeLabel(contactType)
            : dialog.nextLabel,
          contactCopyLabel: typeof getContactCopyLabel === "function"
            ? getContactCopyLabel(contactType)
            : "复制联系方式",
          contactTypeSource: "admin_corrected",
          contactTypeSourceLabel: "管理员已确认",
          contactTypeNeedsConfirmation: false,
          contactTypeNeedsCorrection: false,
        },
        contactTypeIndex: dialog.nextIndex,
      });
      wx.showToast({ title: "联系方式类型已确认", icon: "none" });
      return true;
    } catch (error) {
      this.showTopTips(error.message || "联系方式类型修正失败");
      return false;
    } finally {
      this.setData({ correctingContactType: false });
    }
  },

  onAdminNoteInput(event) {
    this.setData({ adminNote: event.detail.value || "" });
  },

  showTopTips(message, type = "error") {
    this.setData({ topTips: { show: true, message, type } });
  },

  hideTopTips() {
    this.setData({ "topTips.show": false });
  },

  async saveAdminNote() {
    const validation = validateAdminNote(this.data.adminNote);
    if (!validation.valid) {
      this.showTopTips(validation.message);
      return false;
    }
    if (this.data.savingNote) return false;
    this.setData({ savingNote: true });
    try {
      const adminNote = await saveInquiryNote(this.data.id, validation.adminNote);
      this.setData({ item: { ...this.data.item, adminNote }, adminNote });
      wx.showToast({ title: "备注已保存", icon: "none" });
      return true;
    } catch (error) {
      this.showTopTips(error.message || "备注保存失败");
      return false;
    } finally {
      this.setData({ savingNote: false });
    }
  },

  retry() {
    return this.loadDetail();
  },
});
