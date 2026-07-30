const {
  CASE_ADMIN_FORM_OPTIONS,
  buildCaseAdminImagePath,
  buildCaseAdminOptionViews,
  buildCaseAdminPayload,
  createEmptyCaseForm,
  CASE_ADMIN_GALLERY_MAX,
  validateCaseAdminForm,
} = require("./utils/caseAdminData");
const {
  createCaseAdmin,
  cleanupUnreferencedFiles,
  fetchCaseAdminDetail,
  generateCaseImageVariants,
  updateCaseAdmin,
  uploadCaseCoverImage,
} = require("./utils/caseAdminService");
const {
  publishProductAnnouncement,
} = require("./utils/notificationAdminService");

const MEDIA_PICKER_MAX = 9;
const SOURCE_UPLOAD_CONCURRENCY = 3;
const IMAGE_PROCESSING_BATCH_SIZE = 3;

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

function alignGalleryFiles(fileIDs = [], fallbackFileIDs = []) {
  return fallbackFileIDs.map((fallbackFileID, index) => {
    return fileIDs[index] || fallbackFileID;
  });
}

function chunkGalleryFiles(
  fileIDs = [],
  batchSize = IMAGE_PROCESSING_BATCH_SIZE
) {
  const batches = [];
  for (let index = 0; index < fileIDs.length; index += batchSize) {
    batches.push(fileIDs.slice(index, index + batchSize));
  }
  return batches;
}

async function mapSettledWithConcurrency(
  items = [],
  concurrency = SOURCE_UPLOAD_CONCURRENCY,
  mapper
) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        try {
          results[currentIndex] = {
            status: "fulfilled",
            value: await mapper(items[currentIndex], currentIndex),
          };
        } catch (reason) {
          results[currentIndex] = {
            status: "rejected",
            reason,
          };
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function collectVariantFileIDs(variants = []) {
  return variants.flatMap((variant) => {
    return [
      variant && variant.displayFileID,
      variant && variant.thumbnailFileID,
      variant && variant.bannerFileID,
    ].filter(Boolean);
  });
}

Page({
  data: {
    id: "",
    isEdit: false,
    loading: false,
    saving: false,
    uploading: false,
    imageProcessingFailed: false,
    pendingImagePaths: [],
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
        coverBanner: caseItem.coverBanner || "",
        galleryImages: (caseItem.galleryImages && caseItem.galleryImages.length
          ? caseItem.galleryImages
          : [caseItem.coverImage]).filter(Boolean),
        sourceGalleryImages:
          caseItem.sourceGalleryImages && caseItem.sourceGalleryImages.length
            ? caseItem.sourceGalleryImages
            : (caseItem.galleryImages || [caseItem.coverImage]).filter(Boolean),
        galleryThumbnails:
          caseItem.galleryThumbnails && caseItem.galleryThumbnails.length
            ? caseItem.galleryThumbnails
            : [caseItem.coverThumbnail].filter(Boolean),
        galleryBanners:
          caseItem.galleryBanners &&
          caseItem.galleryBanners.length ===
            (caseItem.galleryImages || [caseItem.coverImage]).filter(Boolean).length
            ? caseItem.galleryBanners
            : (caseItem.galleryImages || [caseItem.coverImage]).filter(Boolean),
        imageVariantVersion: Number(caseItem.imageVariantVersion) || 0,
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
      const message = `最多上传 ${CASE_ADMIN_GALLERY_MAX} 张图片`;
      this.showTopTips(message);
      wx.showToast({ title: message, icon: "none" });
      return;
    }
    wx.chooseMedia({
      count: Math.min(MEDIA_PICKER_MAX, remaining),
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      sizeType: ["original"],
      success: async (result) => {
        const filePaths = getMediaPaths(result);
        if (!filePaths.length) return;
        await this.uploadGalleryImages(filePaths);
      },
    });
  },

  async uploadGalleryImages(filePaths = []) {
    if (this.data.uploading) return;
    const selectedPaths = filePaths.slice(
      0,
      CASE_ADMIN_GALLERY_MAX - this.data.form.galleryImages.length
    );
    if (!selectedPaths.length) return;
    this.setData({
      uploading: true,
      imageProcessingFailed: false,
      pendingImagePaths: selectedPaths,
    });

    const uploadedSources = [];
    const generatedVariants = [];
    try {
      const galleryImages = [...this.data.form.galleryImages];
      const sourceGalleryImages = alignGalleryFiles(
        this.data.form.sourceGalleryImages || [],
        galleryImages
      );
      const galleryThumbnails = alignGalleryFiles(
        this.data.form.galleryThumbnails || [],
        galleryImages
      );
      const galleryBanners = alignGalleryFiles(
        this.data.form.galleryBanners || [],
        galleryImages
      );
      const galleryPreviewUrls = [...this.data.galleryPreviewUrls];
      const uploadResults = await mapSettledWithConcurrency(
        selectedPaths,
        SOURCE_UPLOAD_CONCURRENCY,
        (filePath) => {
          const cloudPath = buildCaseAdminImagePath(filePath);
          return uploadCaseCoverImage({ filePath, cloudPath });
        }
      );
      uploadResults.forEach((result) => {
        if (result.status === "fulfilled" && result.value) {
          uploadedSources.push(result.value);
        }
      });
      const failedUpload = uploadResults.find(
        (result) => result.status === "rejected"
      );
      if (failedUpload) {
        throw failedUpload.reason;
      }
      if (uploadedSources.length !== selectedPaths.length) {
        throw new Error("部分原图上传失败");
      }

      const variantBatches = chunkGalleryFiles(uploadedSources);
      const variantResults = await mapSettledWithConcurrency(
        variantBatches,
        variantBatches.length,
        (batch) => generateCaseImageVariants(batch)
      );
      let variantProcessingError = null;
      variantResults.forEach((result) => {
        if (result.status === "fulfilled" && Array.isArray(result.value)) {
          generatedVariants.push(...result.value);
          return;
        }
        if (!variantProcessingError) {
          variantProcessingError =
            result.status === "rejected"
              ? result.reason
              : new Error("图片处理结果格式错误");
        }
      });
      if (variantProcessingError) {
        throw variantProcessingError;
      }
      const variantMap = new Map();
      generatedVariants.forEach((variant) => {
        const sourceFileID = variant && variant.sourceFileID;
        if (!sourceFileID || variantMap.has(sourceFileID)) {
          variantProcessingError = new Error("图片处理结果与原图不匹配");
          return;
        }
        variantMap.set(sourceFileID, variant);
      });
      if (variantProcessingError) {
        throw variantProcessingError;
      }
      const variants = uploadedSources.map((sourceFileID) => {
        return variantMap.get(sourceFileID);
      });
      const variantsAreComplete =
        generatedVariants.length === uploadedSources.length &&
        variants.length === uploadedSources.length &&
        variants.every((variant) => {
          return Boolean(
            variant &&
            variant.sourceFileID &&
            variant.displayFileID &&
            variant.thumbnailFileID &&
            variant.bannerFileID &&
            Number(variant.variantVersion) === 2
          );
        });
      if (!variantsAreComplete) {
        throw new Error("图片处理结果不完整");
      }

      variants.forEach((variant, index) => {
        sourceGalleryImages.push(variant.sourceFileID);
        galleryImages.push(variant.displayFileID);
        galleryThumbnails.push(variant.thumbnailFileID);
        galleryBanners.push(variant.bannerFileID);
        galleryPreviewUrls.push(selectedPaths[index]);
      });
      const form = {
        ...this.data.form,
        galleryImages,
        sourceGalleryImages,
        galleryThumbnails,
        galleryBanners,
        coverImage: galleryImages[0] || "",
        coverThumbnail: galleryThumbnails[0] || "",
        coverBanner: galleryBanners[0] || "",
        imageVariantVersion:
          Number(this.data.form.imageVariantVersion) === 2 ||
          galleryImages.length === variants.length
            ? 2
            : Number(this.data.form.imageVariantVersion) || 0,
      };
      this.setData({
        uploading: false,
        imageProcessingFailed: false,
        pendingImagePaths: [],
        coverImageUrl: galleryPreviewUrls[0] || "",
        galleryPreviewUrls,
        form,
        optionViews: buildCaseAdminOptionViews(form, this.data.formOptions),
      });
      wx.showToast({
        title: `已上传 ${variants.length} 张`,
        icon: "none",
      });
    } catch (error) {
      console.warn("图片处理失败", error);
      const cleanupFileIDs = [
        ...uploadedSources,
        ...collectVariantFileIDs(generatedVariants),
      ];
      if (cleanupFileIDs.length) {
        try {
          await cleanupUnreferencedFiles(cleanupFileIDs);
        } catch (cleanupError) {
          console.warn("未引用图片清理失败", cleanupError);
        }
      }
      this.setData({
        uploading: false,
        imageProcessingFailed: true,
        pendingImagePaths: selectedPaths,
      });
      this.showTopTips("图片处理失败，请重试");
      wx.showToast({
        title: "图片处理失败，请重试",
        icon: "none",
      });
    }
  },

  retryImageProcessing() {
    if (!this.data.pendingImagePaths.length || this.data.uploading) return;
    return this.uploadGalleryImages(this.data.pendingImagePaths);
  },

  moveGalleryImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    const direction = event.currentTarget.dataset.direction;
    const nextIndex = direction === "left" ? index - 1 : index + 1;
    const galleryImages = [...this.data.form.galleryImages];
    const sourceGalleryImages = [...(this.data.form.sourceGalleryImages || galleryImages)];
    const galleryThumbnails = [...(this.data.form.galleryThumbnails || [])];
    const galleryBanners = [...(this.data.form.galleryBanners || [])];
    const galleryPreviewUrls = [...this.data.galleryPreviewUrls];
    if (index < 0 || nextIndex < 0 || index >= galleryImages.length || nextIndex >= galleryImages.length) return;
    [galleryImages[index], galleryImages[nextIndex]] = [galleryImages[nextIndex], galleryImages[index]];
    [sourceGalleryImages[index], sourceGalleryImages[nextIndex]] = [sourceGalleryImages[nextIndex], sourceGalleryImages[index]];
    [galleryThumbnails[index], galleryThumbnails[nextIndex]] = [galleryThumbnails[nextIndex], galleryThumbnails[index]];
    [galleryBanners[index], galleryBanners[nextIndex]] = [galleryBanners[nextIndex], galleryBanners[index]];
    [galleryPreviewUrls[index], galleryPreviewUrls[nextIndex]] = [galleryPreviewUrls[nextIndex], galleryPreviewUrls[index]];
    const form = {
      ...this.data.form,
      galleryImages,
      sourceGalleryImages,
      galleryThumbnails,
      galleryBanners,
      coverImage: galleryImages[0],
      coverThumbnail: galleryThumbnails[0] || "",
      coverBanner: galleryBanners[0] || "",
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
    const sourceGalleryImages = [...(this.data.form.sourceGalleryImages || galleryImages)];
    const galleryThumbnails = [...(this.data.form.galleryThumbnails || [])];
    const galleryBanners = [...(this.data.form.galleryBanners || [])];
    const galleryPreviewUrls = [...this.data.galleryPreviewUrls];
    if (galleryImages.length <= 1) {
      this.showTopTips("案例至少保留一张图片");
      wx.showToast({ title: "案例至少保留一张图片", icon: "none" });
      return;
    }
    galleryImages.splice(index, 1);
    sourceGalleryImages.splice(index, 1);
    galleryThumbnails.splice(index, 1);
    galleryBanners.splice(index, 1);
    galleryPreviewUrls.splice(index, 1);
    const form = {
      ...this.data.form,
      galleryImages,
      sourceGalleryImages,
      galleryThumbnails,
      galleryBanners,
      coverImage: galleryImages[0],
      coverThumbnail: galleryThumbnails[0] || "",
      coverBanner: galleryBanners[0] || "",
    };
    this.setData({
      form,
      coverImageUrl: galleryPreviewUrls[0] || "",
      galleryPreviewUrls,
      optionViews: buildCaseAdminOptionViews(form, this.data.formOptions),
    });
  },

  async saveCase() {
    if (this.data.imageProcessingFailed || this.data.pendingImagePaths.length) {
      this.showTopTips("请先重试并完成图片处理");
      wx.showToast({
        title: "请先完成图片处理",
        icon: "none",
      });
      return;
    }
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
