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

    this.setData({
      saving: true,
    });

    try {
      const payload = buildCaseAdminPayload(this.data.form);
      if (this.data.isEdit) {
        await updateCaseAdmin(this.data.id, payload);
      } else {
        await createCaseAdmin(payload);
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
      this.showTopTips("保存失败，请稍后重试");
      wx.showToast({
        title: "保存失败，请稍后重试",
        icon: "none",
      });
    } finally {
      this.setData({
        saving: false,
      });
    }
  },
});
