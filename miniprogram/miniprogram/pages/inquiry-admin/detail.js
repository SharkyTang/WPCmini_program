const {
  INQUIRY_STATUS_OPTIONS,
  validateAdminNote,
} = require("./utils/inquiryAdminData");
const {
  fetchInquiryDetail,
  saveInquiryNote,
  updateInquiryStatus,
} = require("./utils/inquiryAdminService");

Page({
  data: {
    id: "",
    loading: true,
    savingStatus: false,
    savingNote: false,
    errorMessage: "",
    item: null,
    statusOptions: INQUIRY_STATUS_OPTIONS,
    statusIndex: 0,
    adminNote: "",
    topTips: {
      show: false,
      message: "",
      type: "error",
    },
    confirmDialog: {
      show: false,
      title: "",
      content: "",
      nextIndex: -1,
      nextValue: "",
      nextLabel: "",
      buttons: [{ text: "取消" }, { text: "确认" }],
    },
  },

  onLoad(options = {}) {
    this.setData({
      id: options.id || "",
    });
    this.loadDetail();
  },

  async loadDetail() {
    if (!this.data.id) {
      this.setData({
        loading: false,
        errorMessage: "缺少需求 ID",
      });
      return;
    }

    this.setData({
      loading: true,
      errorMessage: "",
    });

    try {
      const item = await fetchInquiryDetail(this.data.id);
      const statusIndex = this.data.statusOptions.findIndex(
        (option) => option.value === item.status
      );
      this.setData({
        item,
        adminNote: item.adminNote,
        statusIndex: statusIndex >= 0 ? statusIndex : 0,
      });
    } catch (error) {
      console.error("需求详情加载失败", error);
      this.setData({
        errorMessage: error.message || "需求详情加载失败",
      });
    } finally {
      this.setData({
        loading: false,
      });
    }
  },

  copyContact() {
    const contact = this.data.item && this.data.item.contact;
    if (!contact) {
      wx.showToast({
        title: "暂无联系方式",
        icon: "none",
      });
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
      wx.showToast({
        title: "暂无参考案例",
        icon: "none",
      });
      return;
    }

    wx.navigateTo({
      url: `/pages/detail/index?id=${item.caseDocId}`,
    });
  },

  onStatusChange(event) {
    const nextIndex = Number(event.detail.value);
    const nextOption = this.data.statusOptions[nextIndex];
    if (!nextOption || !this.data.item || nextOption.value === this.data.item.status) {
      return;
    }

    this.setData({
      confirmDialog: {
        show: true,
        title: "确认修改需求状态？",
        content: `将状态从“${this.data.item.statusLabel}”改为“${nextOption.label}”。`,
        nextIndex,
        nextValue: nextOption.value,
        nextLabel: nextOption.label,
        buttons: [
          { text: "取消" },
          { text: "确认修改", extClass: "dialog-button-primary" },
        ],
      },
    });
  },

  closeConfirmDialog() {
    this.setData({
      "confirmDialog.show": false,
    });
  },

  async handleConfirmDialogTap(event) {
    const index = event.detail && event.detail.index;
    const dialog = this.data.confirmDialog;
    this.closeConfirmDialog();
    if (index !== 1) return;
    await this.performStatusUpdate(dialog);
  },

  async performStatusUpdate(dialog) {
    if (!dialog.nextValue || !this.data.item) return;

    this.setData({
      savingStatus: true,
    });

    try {
      const status = await updateInquiryStatus(this.data.id, dialog.nextValue);
      const item = {
        ...this.data.item,
        status,
        statusLabel: dialog.nextLabel,
      };
      this.setData({
        item,
        statusIndex: dialog.nextIndex,
      });
      wx.showToast({
        title: "状态已更新",
        icon: "none",
      });
    } catch (error) {
      this.showTopTips(error.message || "状态更新失败");
    } finally {
      this.setData({
        savingStatus: false,
      });
    }
  },

  onAdminNoteInput(event) {
    this.setData({
      adminNote: event.detail.value || "",
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

  async saveAdminNote() {
    const validation = validateAdminNote(this.data.adminNote);
    if (!validation.valid) {
      this.showTopTips(validation.message);
      return;
    }

    this.setData({
      savingNote: true,
    });

    try {
      const adminNote = await saveInquiryNote(this.data.id, validation.adminNote);
      this.setData({
        item: {
          ...this.data.item,
          adminNote,
        },
        adminNote,
      });
      wx.showToast({
        title: "备注已保存",
        icon: "none",
      });
    } catch (error) {
      this.showTopTips(error.message || "备注保存失败");
    } finally {
      this.setData({
        savingNote: false,
      });
    }
  },

  retry() {
    this.loadDetail();
  },
});
