const {
  CASE_ADMIN_FORM_OPTIONS,
  buildCaseAdminImagePath,
  buildCaseAdminOptionViews,
  buildCaseAdminPayload,
  createEmptyCaseForm,
  CASE_ADMIN_GALLERY_MAX,
  validateCaseAdminForm,
} = require("../../utils/caseAdminData");
const {
  createCaseAdmin,
  fetchCaseAdminDetail,
  updateCaseAdmin,
  uploadCaseCoverImage,
} = require("../../utils/caseAdminService");
const {
  publishProductAnnouncement,
} = require("../../utils/notificationAdminService");

function buildProductNotificationDraft(form = {}) {
  const summary = [
    ...(form.packageTypes || []).slice(0, 2),
    ...(form.styles || []).slice(0, 1),
    ...(form.scenes || []).slice(0, 1),
  ].filter(Boolean).join(" / ");
  return {
    title: `新品案例上新｜${String(form.title || "").trim() || "新案例"}`,
    content: summary ? `新案例已上线：${summary}` : "新案例已上线，欢迎查看包装设计详情。",
    sendSubscription: true,
  };
}

function toggleValue(values = [], value) {
  if (!value) return values;
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : values.concat(value);
}

function getMediaPath(result = {}) {
  const file = result.tempFiles && result.tempFiles[0];
  return file && (file.tempFilePath || file.path);
}

function getMediaPaths(result = {}) {
  return (result.tempFiles || [])
    .map((file) => file && (file.tempFilePath || file.path))
    .filter(Boolean);
}

Page({
  data: {
    id: "",
    isEdit: false,
    loading: false,
    saving: false,
    uploading: false,
    errorMessage: "",
    coverImageUrl: "",
    galleryPreviewUrls: [],
    galleryMax: CASE_ADMIN_GALLERY_MAX,
    publishProductNotification: false,
    productNotificationDraft: buildProductNotificationDraft(),
    topTips: {
      show: false,
      message: "",
      type: "error",
    },
    form: createEmptyCaseForm(),
    formOptions: CASE_ADMIN_FORM_OPTIONS,
    optionViews: buildCaseAdminOptionViews(createEmptyCaseForm(), CASE_ADMIN_FORM_OPTIONS),
  },

  onLoad(options = {}) {
    if (options.id) {
      this.loadCase(options.id);
    }
  },

  async loadCase(id) {
    this.setData({
      id,
      isEdit: true,
      loading: true,
      errorMessage: "",
    });

    try {
      const caseItem = await fetchCaseAdminDetail(id);
      const form = {
        title: caseItem.title || "",
        caseId: caseItem.caseId || "",
        coverImage: caseItem.coverImage || "",
        coverThumbnail: caseItem.coverThumbnail || "",
        galleryImages: (caseItem.galleryImages && caseItem.galleryImages.length
          ? caseItem.galleryImages
          : [caseItem.coverImage]).filter(Boolean),
        wineType: caseItem.wineType || "白酒",
        packageTypes: caseItem.packageTypes || [],
        styles: caseItem.styles || [],
        priceLevel: caseItem.priceLevel || "",
        scenes: caseItem.scenes || [],
        statuses: caseItem.statuses || [],
        homeSections: caseItem.homeSections || [],
        sortOrder:
          caseItem.sortOrder === undefined || caseItem.sortOrder === null
            ? ""
            : String(caseItem.sortOrder),
        notes: caseItem.notes || "",
        isVisible: caseItem.isVisible !== false,
        isPinned: caseItem.isPinned === true,
      };
      this.setData({
        loading: false,
        coverImageUrl: caseItem.coverImageUrl || caseItem.coverImage || "",
        galleryPreviewUrls: caseItem.galleryImageUrls || [caseItem.coverImageUrl || caseItem.coverImage].filter(Boolean),
        form,
        optionViews: buildCaseAdminOptionViews(form, this.data.formOptions),
      });
    } catch (error) {
      console.warn("读取案例详情失败", error);
      this.setData({
        loading: false,
        errorMessage: "案例读取失败，请返回后重试",
      });
    }
  },

  updateFormField(field, value) {
    const form = {
      ...this.data.form,
      [field]: value,
    };
    this.setData({
      [`form.${field}`]: value,
      optionViews: buildCaseAdminOptionViews(form, this.data.formOptions),
    });
  },

  onTitleInput(event) {
    this.updateFormField("title", event.detail.value || "");
  },

  onCaseIdInput(event) {
    this.updateFormField("caseId", event.detail.value || "");
  },

  onSortOrderInput(event) {
    this.updateFormField("sortOrder", event.detail.value || "");
  },

  onNotesInput(event) {
    this.updateFormField("notes", event.detail.value || "");
  },

  onVisibleChange(event) {
    this.updateFormField("isVisible", event.detail.value === true);
  },

  onPinnedChange(event) {
    this.updateFormField("isPinned", event.detail.value === true);
  },

  onPublishNotificationChange(event) {
    const publishProductNotification = event.detail.value === true;
    this.setData({
      publishProductNotification,
      ...(publishProductNotification
        ? { productNotificationDraft: buildProductNotificationDraft(this.data.form) }
        : {}),
    });
  },

  onNotificationTitleInput(event) {
    this.setData({
      "productNotificationDraft.title": event.detail.value || "",
    });
  },

  onNotificationContentInput(event) {
    this.setData({
      "productNotificationDraft.content": event.detail.value || "",
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

  selectSingle(event) {
    const { field, value } = event.currentTarget.dataset;
    if (!field) return;
    const current = this.data.form[field];
    this.updateFormField(field, current === value ? "" : value);
  },

  toggleMulti(event) {
    const { field, value } = event.currentTarget.dataset;
    if (!field) return;
    const nextValues = toggleValue(this.data.form[field] || [], value);
    this.updateFormField(field, nextValues);
  },

  chooseGalleryImages() {
    const remaining = CASE_ADMIN_GALLERY_MAX - this.data.form.galleryImages.length;
    if (remaining <= 0) {
      this.showTopTips("最多上传 5 张图片");
      wx.showToast({ title: "最多上传 5 张图片", icon: "none" });
      return;
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      sizeType: ["compressed"],
      success: async (result) => {
        const filePaths = getMediaPaths(result);
        if (!filePaths.length) return;
        await this.uploadGalleryImages(filePaths);
      },
    });
  },

  compressImage(filePath) {
    if (!wx.compressImage) {
      return Promise.resolve(filePath);
    }

    return new Promise((resolve) => {
      wx.compressImage({
        src: filePath,
        quality: 70,
        success: (result) => resolve(result.tempFilePath || filePath),
        fail: () => resolve(filePath),
      });
    });
  },

  async uploadGalleryImages(filePaths = []) {
    this.setData({
      uploading: true,
    });

    try {
      const galleryImages = [...this.data.form.galleryImages];
      const galleryPreviewUrls = [...this.data.galleryPreviewUrls];
      let coverThumbnail = this.data.form.coverThumbnail;
      let uploadedCount = 0;

      for (const filePath of filePaths.slice(0, CASE_ADMIN_GALLERY_MAX - galleryImages.length)) {
        try {
          const compressedPath = await this.compressImage(filePath);
          const cloudPath = buildCaseAdminImagePath(compressedPath);
          const fileID = await uploadCaseCoverImage({ filePath: compressedPath, cloudPath });
          if (!galleryImages.length) {
            try {
              const thumbnailPath = await this.compressThumbnail(filePath);
              coverThumbnail = await uploadCaseCoverImage({
                filePath: thumbnailPath,
                cloudPath: cloudPath.replace(/(\.[a-zA-Z0-9]+)$/, "-thumb$1"),
              });
            } catch (thumbnailError) {
              console.warn("缩略图上传失败，将继续使用原图", thumbnailError);
            }
          }
          galleryImages.push(fileID);
          galleryPreviewUrls.push(compressedPath);
          uploadedCount += 1;
        } catch (uploadError) {
          console.warn("上传案例图片失败", uploadError);
        }
      }
      const form = {
        ...this.data.form,
        galleryImages,
        coverImage: galleryImages[0] || "",
        coverThumbnail,
      };
      this.setData({
        uploading: false,
        coverImageUrl: galleryPreviewUrls[0] || "",
        galleryPreviewUrls,
        form,
        optionViews: buildCaseAdminOptionViews(form, this.data.formOptions),
      });
      wx.showToast({
        title: uploadedCount ? `已上传 ${uploadedCount} 张` : "图片上传失败",
        icon: "none",
      });
      if (!uploadedCount) {
        this.showTopTips("图片上传失败，请重新选择一张图片");
      }
    } catch (error) {
      console.warn("上传案例封面失败", error);
      this.setData({
        uploading: false,
      });
      this.showTopTips("图片上传失败，请重新选择一张图片");
      wx.showToast({
        title: "图片上传失败",
        icon: "none",
      });
    }
  },

  async compressThumbnail(filePath) {
    if (!wx.compressImage) return filePath;
    return new Promise((resolve) => {
      wx.compressImage({
        src: filePath,
        quality: 35,
        success: (result) => resolve(result.tempFilePath || filePath),
        fail: () => resolve(filePath),
      });
    });
  },

  moveGalleryImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    const direction = event.currentTarget.dataset.direction;
    const nextIndex = direction === "left" ? index - 1 : index + 1;
    const galleryImages = [...this.data.form.galleryImages];
    const galleryPreviewUrls = [...this.data.galleryPreviewUrls];
    if (index < 0 || nextIndex < 0 || index >= galleryImages.length || nextIndex >= galleryImages.length) return;
    [galleryImages[index], galleryImages[nextIndex]] = [galleryImages[nextIndex], galleryImages[index]];
    [galleryPreviewUrls[index], galleryPreviewUrls[nextIndex]] = [galleryPreviewUrls[nextIndex], galleryPreviewUrls[index]];
    const form = {
      ...this.data.form,
      galleryImages,
      coverImage: galleryImages[0],
      // 旧缩略图只对应原封面，调整首图后安全回退到原图。
      coverThumbnail: "",
    };
    this.setData({
      form,
      coverImageUrl: galleryPreviewUrls[0] || "",
      galleryPreviewUrls,
      optionViews: buildCaseAdminOptionViews(form, this.data.formOptions),
    });
  },

  removeGalleryImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    const galleryImages = [...this.data.form.galleryImages];
    const galleryPreviewUrls = [...this.data.galleryPreviewUrls];
    if (galleryImages.length <= 1) {
      this.showTopTips("案例至少保留一张图片");
      wx.showToast({ title: "案例至少保留一张图片", icon: "none" });
      return;
    }
    galleryImages.splice(index, 1);
    galleryPreviewUrls.splice(index, 1);
    const form = {
      ...this.data.form,
      galleryImages,
      coverImage: galleryImages[0],
      coverThumbnail: index === 0 ? "" : this.data.form.coverThumbnail,
    };
    this.setData({
      form,
      coverImageUrl: galleryPreviewUrls[0] || "",
      galleryPreviewUrls,
      optionViews: buildCaseAdminOptionViews(form, this.data.formOptions),
    });
  },

  async saveCase() {
    const validation = validateCaseAdminForm(this.data.form, {
      isCreate: !this.data.isEdit,
    });

    if (!validation.valid) {
      this.showTopTips(validation.message);
      wx.showToast({
        title: validation.message,
        icon: "none",
      });
      return;
    }
    if (!this.data.isEdit && this.data.publishProductNotification) {
      if (!this.data.form.isVisible) {
        this.showTopTips("发布产品上新通知前，请先打开前台显示");
        return;
      }
      if (!this.data.productNotificationDraft.title.trim()) {
        this.showTopTips("请填写产品上新通知标题");
        return;
      }
      if (!this.data.productNotificationDraft.content.trim()) {
        this.showTopTips("请填写产品上新通知内容");
        return;
      }
    }

    this.setData({
      saving: true,
    });

    try {
      const payload = buildCaseAdminPayload(this.data.form);
      let saveResult;
      if (this.data.isEdit) {
        await updateCaseAdmin(this.data.id, payload);
      } else {
        saveResult = await createCaseAdmin(payload);
        if (this.data.publishProductNotification) {
          try {
            await publishProductAnnouncement({
              caseDocId: saveResult.id,
              title: this.data.productNotificationDraft.title,
              content: this.data.productNotificationDraft.content,
              sendSubscription: this.data.productNotificationDraft.sendSubscription,
            });
          } catch (notificationError) {
            console.warn("案例已保存，但产品上新通知发布失败", notificationError);
            wx.showModal({
              title: "案例已保存",
              content: "产品上新通知发布失败，可稍后在通知管理中补发。",
              showCancel: false,
              success: () => wx.navigateBack({ delta: 1 }),
            });
            return;
          }
        }
      }
      wx.showToast({
        title: "已保存",
        icon: "none",
      });
      setTimeout(() => {
        wx.navigateBack({
          delta: 1,
        });
      }, 350);
    } catch (error) {
      console.warn("保存案例失败", error);
      const message = error.message || "保存失败，请稍后重试";
      this.showTopTips(message);
      wx.showToast({
        title: error.code === "HOME_DISPLAY_LIMIT_REACHED" ? "首页展示名额已满" : "保存失败，请稍后重试",
        icon: "none",
      });
    } finally {
      this.setData({
        saving: false,
      });
    }
  },
});
