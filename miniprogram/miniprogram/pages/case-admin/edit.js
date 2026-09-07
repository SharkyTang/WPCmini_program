const {
  CASE_ADMIN_FORM_OPTIONS,
  CASE_ADMIN_VIDEO_DEFAULT_LIMITS = {
    videoUploadBytes: 100 * 1024 * 1024,
    videoDurationSeconds: 120,
    videoPosterUploadBytes: 5 * 1024 * 1024,
  },
  buildCaseAdminImagePath,
  buildCaseAdminOptionViews,
  buildCaseAdminPayload,
  buildCaseAdminVideoPatch = () => ({ valid: true, patch: null }),
  createEmptyCaseForm,
  CASE_ADMIN_GALLERY_MAX,
  getSceneLabel = (value) => value || "",
  normalizeCaseAdminVideoLimits = (limits) => limits || CASE_ADMIN_VIDEO_DEFAULT_LIMITS,
  validateCaseAdminForm,
  validateCaseAdminVideoPosterSelection = () => ({ valid: false, message: "暂不支持视频封面" }),
  validateCaseAdminVideoSelection = () => ({ valid: false, message: "暂不支持视频上传" }),
} = require("./utils/caseAdminData");
const {
  createCaseAdmin,
  cleanupUnreferencedFiles,
  fetchCaseAdminConfig,
  fetchCaseAdminDetail,
  generateCaseImageVariants,
  prepareCaseVideoUpload,
  updateCaseAdmin,
  uploadCaseCoverImage,
  uploadCaseVideoMedia,
} = require("./utils/caseAdminService");
const {
  publishProductAnnouncement,
} = require("./utils/notificationAdminService");

const MEDIA_PICKER_MAX = 9;
const SOURCE_UPLOAD_CONCURRENCY = 3;
const IMAGE_PROCESSING_BATCH_SIZE = 3;

function createEmptyVideoDraft() {
  return {
    uploadFileID: "",
    uploadPreviewUrl: "",
    uploadDurationSeconds: null,
    uploadFileSizeBytes: 0,
    uploadPosterFileID: "",
    uploadPosterPreviewUrl: "",
    externalUrl: "",
    externalPosterUrl: "",
    externalDurationSeconds: "",
  };
}

function buildVideoDraft(caseItem = {}) {
  return {
    ...createEmptyVideoDraft(),
    uploadFileID: caseItem.videoFileID || "",
    uploadPreviewUrl: caseItem.videoPreviewUrl || "",
    uploadDurationSeconds: caseItem.videoFileID
      ? Number(caseItem.videoDurationSeconds) || null
      : null,
    uploadFileSizeBytes: caseItem.videoFileID
      ? Number(caseItem.videoFileSizeBytes) || 0
      : 0,
    uploadPosterFileID: caseItem.videoPosterFileID || "",
    uploadPosterPreviewUrl: caseItem.videoPosterPreviewUrl || "",
    externalUrl: caseItem.videoUrl || "",
    externalPosterUrl: caseItem.videoPoster || "",
    externalDurationSeconds:
      !caseItem.videoFileID && caseItem.videoDurationSeconds
        ? String(caseItem.videoDurationSeconds)
        : "",
  };
}

function getSelectedFile(result = {}) {
  return result.tempFiles && result.tempFiles[0];
}

function getFilePath(file = {}) {
  return file.tempFilePath || file.path || "";
}

function getFileName(file = {}) {
  const path = String(file.name || getFilePath(file));
  return path.split(/[\\/]/).pop() || "upload";
}

function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.ceil(value / 1024)}KB`;
}

function normalizeVideoErrorCode(error, fallbackCode) {
  const rawCode = String((error && error.code) || "")
    .trim()
    .toUpperCase();
  return /^[A-Z0-9_:-]{1,64}$/.test(rawCode) ? rawCode : fallbackCode;
}

function logVideoIssue(stage, error, fallbackCode = "VIDEO_OPERATION_FAILED") {
  console.warn("case admin video operation", {
    stage,
    errorCode: normalizeVideoErrorCode(error, fallbackCode),
  });
}

function normalizeCleanupOutcome(result, targets = []) {
  if (Array.isArray(result)) {
    const deleted = new Set(result);
    return {
      deletedFileIds: result,
      skippedFileIds: [],
      failedFileIds: targets.filter((fileID) => !deleted.has(fileID)),
    };
  }
  const deletedFileIds = Array.isArray(result && result.deletedFileIds)
    ? result.deletedFileIds
    : [];
  const skippedFileIds = Array.isArray(result && result.skippedFileIds)
    ? result.skippedFileIds
    : [];
  const explicitFailedFileIds = Array.isArray(result && result.failedFileIds)
    ? result.failedFileIds
    : [];
  const settled = new Set([...deletedFileIds, ...skippedFileIds, ...explicitFailedFileIds]);
  return {
    deletedFileIds,
    skippedFileIds,
    failedFileIds: Array.from(new Set([
      ...explicitFailedFileIds,
      ...targets.filter((fileID) => !settled.has(fileID)),
    ])),
  };
}

function buildProductNotificationDraft(form = {}) {
  const summary = [
    ...(form.packageTypes || []).slice(0, 2),
    ...(form.styles || []).slice(0, 1),
    ...(form.scenes || []).slice(0, 1).map(getSceneLabel),
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
    videoUploadEnabled: false,
    videoLimits: CASE_ADMIN_VIDEO_DEFAULT_LIMITS,
    videoSource: "upload",
    videoAdvancedOpen: false,
    videoDirty: false,
    videoRemoved: false,
    videoUploading: false,
    videoUploadProgress: 0,
    videoUploadError: "",
    posterUploading: false,
    posterUploadProgress: 0,
    posterUploadError: "",
    pendingVideoFileIDs: [],
    videoDraft: createEmptyVideoDraft(),
    videoFileSizeLabel: "",
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
    this.pageUnloaded = false;
    this.pageLifecycleToken = (Number(this.pageLifecycleToken) || 0) + 1;
    if (options.id) {
      this.loadCase(options.id);
    }
  },

  onUnload() {
    this.pageUnloaded = true;
    this.pageLifecycleToken = (Number(this.pageLifecycleToken) || 0) + 1;
    this.abortActiveVideoUploads();
    if (this.data.saving) return;
    const pendingFileIDs = [...(this.data.pendingVideoFileIDs || [])];
    if (pendingFileIDs.length) {
      this.cleanupDetachedVideoFiles(pendingFileIDs, "unload_cleanup");
    }
  },

  getPageLifecycleToken() {
    if (!Number.isInteger(this.pageLifecycleToken)) {
      this.pageLifecycleToken = 1;
      this.pageUnloaded = false;
    }
    return this.pageLifecycleToken;
  },

  isPageLifecycleActive(token) {
    return !this.pageUnloaded && token === this.getPageLifecycleToken();
  },

  async loadCase(id) {
    this.setData({
      id,
      isEdit: true,
      loading: true,
      errorMessage: "",
    });

    try {
      const [caseItem, config] = await Promise.all([
        fetchCaseAdminDetail(id),
        fetchCaseAdminConfig().catch((error) => {
          logVideoIssue("config_load", error, "VIDEO_CONFIG_LOAD_FAILED");
          return {};
        }),
      ]);
      const videoDraft = buildVideoDraft(caseItem);
      const videoSource = caseItem.videoFileID
        ? "upload"
        : caseItem.videoUrl
          ? "external"
          : "upload";
      this.initialVideoDraft = { ...videoDraft };
      this.initialVideoSource = videoSource;
      const loadedVersion = Number(caseItem.version);
      this.caseVersion = Number.isInteger(loadedVersion) && loadedVersion > 0
        ? loadedVersion
        : 1;
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
        videoUploadEnabled: Boolean(
          config.features && config.features.videoUploadEnabled
        ),
        videoLimits: normalizeCaseAdminVideoLimits(config.limits),
        videoSource,
        videoAdvancedOpen: videoSource === "external",
        videoDirty: false,
        videoRemoved: false,
        videoDraft,
        videoFileSizeLabel: formatFileSize(videoDraft.uploadFileSizeBytes),
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

  syncVideoUnloadGuard() {
    const shouldGuard = Boolean(
      this.data.saving ||
      this.data.videoUploading ||
      this.data.posterUploading ||
      (this.data.pendingVideoFileIDs || []).length
    );
    if (shouldGuard === this.videoUnloadGuardEnabled) return;
    this.videoUnloadGuardEnabled = shouldGuard;
    try {
      if (shouldGuard && wx.enableAlertBeforeUnload) {
        wx.enableAlertBeforeUnload({
          message: "视频尚未保存，离开将放弃本次视频修改。",
        });
      } else if (!shouldGuard && wx.disableAlertBeforeUnload) {
        wx.disableAlertBeforeUnload();
      }
    } catch (error) {
      logVideoIssue("unload_guard_enable", error, "VIDEO_UNLOAD_GUARD_FAILED");
    }
  },

  releaseVideoUnloadGuard() {
    this.videoUnloadGuardEnabled = false;
    try {
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    } catch (error) {
      logVideoIssue("unload_guard_disable", error, "VIDEO_UNLOAD_GUARD_FAILED");
    }
  },

  abortActiveVideoUploads() {
    [this.activeVideoUploadTask, this.activePosterUploadTask].forEach((task) => {
      if (task && typeof task.abort === "function") {
        try {
          task.abort();
        } catch (error) {
          logVideoIssue("upload_abort", error, "VIDEO_UPLOAD_ABORT_FAILED");
        }
      }
    });
    this.activeVideoUploadTask = null;
    this.activePosterUploadTask = null;
  },

  getVideoMetadata(filePath, lifecycleToken = this.getPageLifecycleToken()) {
    return new Promise((resolve, reject) => {
      if (!wx.getVideoInfo) {
        reject(new Error("当前微信版本无法读取视频信息"));
        return;
      }
      wx.getVideoInfo({
        src: filePath,
        success: (metadata) => {
          resolve(this.isPageLifecycleActive(lifecycleToken) ? metadata : null);
        },
        fail: (error) => {
          if (this.isPageLifecycleActive(lifecycleToken)) reject(error);
          else resolve(null);
        },
      });
    });
  },

  showVideoMessage(message, field = "videoUploadError") {
    this.setData({ [field]: message });
    this.showTopTips(message);
    wx.showToast({ title: message, icon: "none" });
  },

  async cleanupDetachedVideoFiles(fileIDs = [], stage = "detached_cleanup") {
    const targets = Array.from(new Set(fileIDs.filter(Boolean)));
    if (!targets.length) return normalizeCleanupOutcome({}, []);
    try {
      const outcome = normalizeCleanupOutcome(
        await cleanupUnreferencedFiles(targets),
        targets
      );
      if (outcome.failedFileIds.length) {
        logVideoIssue(
          stage,
          { code: "VIDEO_CLEANUP_PARTIAL_FAILURE" },
          "VIDEO_CLEANUP_PARTIAL_FAILURE"
        );
      }
      return outcome;
    } catch (error) {
      logVideoIssue(stage, error, "VIDEO_CLEANUP_FAILED");
      return {
        deletedFileIds: [],
        skippedFileIds: [],
        failedFileIds: targets,
      };
    }
  },

  async cleanupPendingVideoFiles(fileIDs = []) {
    const targets = Array.from(new Set(fileIDs.filter(Boolean)));
    if (!targets.length) return normalizeCleanupOutcome({}, []);
    try {
      const cleanupResult = normalizeCleanupOutcome(
        await cleanupUnreferencedFiles(targets),
        targets
      );
      if (this.pageUnloaded) return cleanupResult;
      const targetSet = new Set(targets);
      const failedSet = new Set(cleanupResult.failedFileIds);
      this.setData({
        pendingVideoFileIDs: (this.data.pendingVideoFileIDs || []).filter(
          (fileID) => !targetSet.has(fileID) || failedSet.has(fileID)
        ),
      });
      if (cleanupResult.failedFileIds.length) {
        logVideoIssue(
          "pending_cleanup",
          { code: "VIDEO_CLEANUP_PARTIAL_FAILURE" },
          "VIDEO_CLEANUP_PARTIAL_FAILURE"
        );
      }
      this.syncVideoUnloadGuard();
      return cleanupResult;
    } catch (error) {
      logVideoIssue("pending_cleanup", error, "VIDEO_CLEANUP_FAILED");
      this.syncVideoUnloadGuard();
      return {
        deletedFileIds: [],
        skippedFileIds: [],
        failedFileIds: targets,
      };
    }
  },

  onVideoAdvancedToggle() {
    if (this.data.saving) return;
    this.setData({
      videoAdvancedOpen: !this.data.videoAdvancedOpen,
    });
  },

  async onVideoSourceSelect(event) {
    const source = event.currentTarget.dataset.source;
    if (!["upload", "external"].includes(source) || source === this.data.videoSource) {
      return;
    }
    if (this.data.saving) return;
    if (source === "upload" && !this.data.videoUploadEnabled) {
      this.showVideoMessage("云视频上传暂未开启，可使用 HTTPS 外链");
      return;
    }
    if (this.data.videoUploading || this.data.posterUploading) {
      this.showVideoMessage("请等待当前上传完成");
      return;
    }

    let videoDraft = { ...this.data.videoDraft };
    const pendingFileIDs = [...(this.data.pendingVideoFileIDs || [])];
    if (source === "external" && pendingFileIDs.length) {
      const initialDraft = this.initialVideoDraft || createEmptyVideoDraft();
      videoDraft = {
        ...videoDraft,
        uploadFileID: initialDraft.uploadFileID,
        uploadPreviewUrl: initialDraft.uploadPreviewUrl,
        uploadDurationSeconds: initialDraft.uploadDurationSeconds,
        uploadFileSizeBytes: initialDraft.uploadFileSizeBytes,
        uploadPosterFileID: initialDraft.uploadPosterFileID,
        uploadPosterPreviewUrl: initialDraft.uploadPosterPreviewUrl,
      };
    }
    this.setData({
      videoSource: source,
      videoAdvancedOpen: source === "external" || this.data.videoAdvancedOpen,
      videoDirty: true,
      videoRemoved: false,
      videoDraft,
      videoFileSizeLabel: formatFileSize(videoDraft.uploadFileSizeBytes),
    });
    if (source === "external" && pendingFileIDs.length) {
      await this.cleanupPendingVideoFiles(pendingFileIDs);
    }
  },

  onExternalVideoUrlInput(event) {
    if (this.data.saving) return;
    this.setData({
      videoSource: "external",
      videoDirty: true,
      videoRemoved: false,
      videoUploadError: "",
      videoDraft: {
        ...this.data.videoDraft,
        externalUrl: event.detail.value || "",
      },
    });
  },

  onExternalPosterUrlInput(event) {
    if (this.data.saving) return;
    this.setData({
      videoDirty: true,
      videoRemoved: false,
      videoDraft: {
        ...this.data.videoDraft,
        externalPosterUrl: event.detail.value || "",
      },
    });
  },

  onExternalDurationInput(event) {
    if (this.data.saving) return;
    this.setData({
      videoDirty: true,
      videoRemoved: false,
      videoDraft: {
        ...this.data.videoDraft,
        externalDurationSeconds: event.detail.value || "",
      },
    });
  },

  chooseCaseVideo() {
    if (!this.data.isEdit) return;
    if (this.data.saving) return;
    if (!this.data.videoUploadEnabled) {
      this.showVideoMessage("云视频上传暂未开启，可使用 HTTPS 外链");
      return;
    }
    if (this.data.videoUploading || this.data.posterUploading) {
      this.showVideoMessage("请等待当前上传完成");
      return;
    }
    const lifecycleToken = this.getPageLifecycleToken();
    wx.chooseMedia({
      count: 1,
      mediaType: ["video"],
      sourceType: ["album"],
      success: async (result) => {
        if (!this.isPageLifecycleActive(lifecycleToken)) return;
        const file = getSelectedFile(result);
        if (!file) return;
        await this.handleSelectedVideo(file, lifecycleToken);
      },
    });
  },

  async handleSelectedVideo(file, lifecycleToken = this.getPageLifecycleToken()) {
    if (!this.isPageLifecycleActive(lifecycleToken) || this.data.saving) return;
    const filePath = getFilePath(file);
    if (!filePath) {
      this.showVideoMessage("无法读取所选视频，请重新选择");
      return;
    }
    let metadata;
    try {
      metadata = await this.getVideoMetadata(filePath, lifecycleToken);
    } catch (error) {
      if (!this.isPageLifecycleActive(lifecycleToken)) return;
      logVideoIssue("metadata_read", error, "VIDEO_METADATA_READ_FAILED");
      this.showVideoMessage("无法读取视频信息，请重新选择");
      return;
    }
    if (!metadata || !this.isPageLifecycleActive(lifecycleToken)) return;
    const validation = validateCaseAdminVideoSelection(
      file,
      metadata,
      this.data.videoLimits
    );
    if (!validation.valid) {
      this.showVideoMessage(validation.message);
      return;
    }
    this.pendingVideoSelection = {
      file,
      metadata: validation.data,
    };
    await this.uploadSelectedVideo(lifecycleToken);
  },

  async uploadSelectedVideo(lifecycleToken = this.getPageLifecycleToken()) {
    if (
      !this.isPageLifecycleActive(lifecycleToken) ||
      !this.pendingVideoSelection ||
      this.data.videoUploading ||
      this.data.saving
    ) return;
    const { file, metadata } = this.pendingVideoSelection;
    const filePath = getFilePath(file);
    this.setData({
      videoSource: "upload",
      videoAdvancedOpen: false,
      videoUploading: true,
      videoUploadProgress: 0,
      videoUploadError: "",
      videoRemoved: false,
    });
    this.syncVideoUnloadGuard();

    try {
      const prepared = await prepareCaseVideoUpload({
        id: this.data.id,
        kind: "video",
        fileName: getFileName(file),
      });
      if (!this.isPageLifecycleActive(lifecycleToken)) return;
      const fileID = await uploadCaseVideoMedia({
        filePath,
        cloudPath: prepared.cloudPath,
        onTask: (task) => {
          if (this.isPageLifecycleActive(lifecycleToken)) {
            this.activeVideoUploadTask = task;
          } else if (task && typeof task.abort === "function") {
            task.abort();
          }
        },
        onProgress: (progress) => {
          if (this.isPageLifecycleActive(lifecycleToken)) {
            this.setData({ videoUploadProgress: progress });
          }
        },
      });
      this.activeVideoUploadTask = null;
      if (!this.isPageLifecycleActive(lifecycleToken)) {
        await this.cleanupDetachedVideoFiles([fileID], "post_unload_cleanup");
        return;
      }

      const previousDraft = this.data.videoDraft;
      const nextDraft = {
        ...previousDraft,
        uploadFileID: fileID,
        uploadPreviewUrl: filePath,
        uploadDurationSeconds: metadata.durationSeconds,
        uploadFileSizeBytes: metadata.size,
      };
      const pendingVideoFileIDs = Array.from(
        new Set([...(this.data.pendingVideoFileIDs || []), fileID])
      );
      const keepFileIDs = new Set([
        nextDraft.uploadFileID,
        nextDraft.uploadPosterFileID,
      ].filter(Boolean));
      const supersededFileIDs = pendingVideoFileIDs.filter(
        (pendingFileID) => !keepFileIDs.has(pendingFileID)
      );
      this.setData({
        videoDirty: true,
        videoUploading: false,
        videoUploadProgress: 100,
        videoUploadError: "",
        pendingVideoFileIDs,
        videoDraft: nextDraft,
        videoFileSizeLabel: formatFileSize(metadata.size),
      });
      this.syncVideoUnloadGuard();
      if (supersededFileIDs.length) {
        await this.cleanupPendingVideoFiles(supersededFileIDs);
      }
      if (!this.isPageLifecycleActive(lifecycleToken)) return;
      wx.showToast({ title: "视频上传完成", icon: "none" });
    } catch (error) {
      this.activeVideoUploadTask = null;
      if (!this.isPageLifecycleActive(lifecycleToken)) return;
      logVideoIssue("video_upload", error, "VIDEO_UPLOAD_FAILED");
      this.setData({
        videoUploading: false,
        videoUploadError: "视频上传失败，请重试",
      });
      this.syncVideoUnloadGuard();
      this.showVideoMessage("视频上传失败，请重试");
    }
  },

  retryVideoUpload() {
    return this.uploadSelectedVideo();
  },

  chooseVideoPoster() {
    if (!this.data.videoDraft.uploadFileID || this.data.posterUploading) return;
    if (this.data.saving) return;
    if (!this.data.videoUploadEnabled) {
      this.showVideoMessage("云视频上传暂未开启", "posterUploadError");
      return;
    }
    const lifecycleToken = this.getPageLifecycleToken();
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album"],
      sizeType: ["original"],
      success: async (result) => {
        if (!this.isPageLifecycleActive(lifecycleToken)) return;
        const file = getSelectedFile(result);
        if (!file) return;
        await this.handleSelectedVideoPoster(file, lifecycleToken);
      },
    });
  },

  async handleSelectedVideoPoster(file, lifecycleToken = this.getPageLifecycleToken()) {
    if (!this.isPageLifecycleActive(lifecycleToken) || this.data.saving) return;
    const validation = validateCaseAdminVideoPosterSelection(
      file,
      this.data.videoLimits
    );
    if (!validation.valid) {
      this.showVideoMessage(validation.message, "posterUploadError");
      return;
    }
    this.pendingPosterSelection = file;
    await this.uploadSelectedVideoPoster(lifecycleToken);
  },

  async uploadSelectedVideoPoster(lifecycleToken = this.getPageLifecycleToken()) {
    if (
      !this.isPageLifecycleActive(lifecycleToken) ||
      !this.pendingPosterSelection ||
      this.data.posterUploading ||
      this.data.saving
    ) return;
    const file = this.pendingPosterSelection;
    const filePath = getFilePath(file);
    this.setData({
      posterUploading: true,
      posterUploadProgress: 0,
      posterUploadError: "",
    });
    this.syncVideoUnloadGuard();
    try {
      const prepared = await prepareCaseVideoUpload({
        id: this.data.id,
        kind: "poster",
        fileName: getFileName(file),
      });
      if (!this.isPageLifecycleActive(lifecycleToken)) return;
      const fileID = await uploadCaseVideoMedia({
        filePath,
        cloudPath: prepared.cloudPath,
        onTask: (task) => {
          if (this.isPageLifecycleActive(lifecycleToken)) {
            this.activePosterUploadTask = task;
          } else if (task && typeof task.abort === "function") {
            task.abort();
          }
        },
        onProgress: (progress) => {
          if (this.isPageLifecycleActive(lifecycleToken)) {
            this.setData({ posterUploadProgress: progress });
          }
        },
      });
      this.activePosterUploadTask = null;
      if (!this.isPageLifecycleActive(lifecycleToken)) {
        await this.cleanupDetachedVideoFiles(
          [fileID],
          "post_unload_poster_cleanup"
        );
        return;
      }

      const previousPosterFileID = this.data.videoDraft.uploadPosterFileID;
      const pendingVideoFileIDs = Array.from(
        new Set([...(this.data.pendingVideoFileIDs || []), fileID])
      );
      this.setData({
        videoDirty: true,
        videoRemoved: false,
        posterUploading: false,
        posterUploadProgress: 100,
        pendingVideoFileIDs,
        videoDraft: {
          ...this.data.videoDraft,
          uploadPosterFileID: fileID,
          uploadPosterPreviewUrl: filePath,
        },
      });
      this.syncVideoUnloadGuard();
      if (
        previousPosterFileID &&
        previousPosterFileID !== fileID &&
        pendingVideoFileIDs.includes(previousPosterFileID)
      ) {
        await this.cleanupPendingVideoFiles([previousPosterFileID]);
      }
      if (!this.isPageLifecycleActive(lifecycleToken)) return;
      wx.showToast({ title: "封面上传完成", icon: "none" });
    } catch (error) {
      this.activePosterUploadTask = null;
      if (!this.isPageLifecycleActive(lifecycleToken)) return;
      logVideoIssue("poster_upload", error, "VIDEO_POSTER_UPLOAD_FAILED");
      this.setData({
        posterUploading: false,
        posterUploadError: "封面上传失败，请重试",
      });
      this.syncVideoUnloadGuard();
      this.showVideoMessage("封面上传失败，请重试", "posterUploadError");
    }
  },

  retryVideoPosterUpload() {
    return this.uploadSelectedVideoPoster();
  },

  async removeVideoPoster() {
    if (this.data.posterUploading || this.data.saving) return;
    const posterFileID = this.data.videoDraft.uploadPosterFileID;
    this.setData({
      videoDirty: true,
      videoDraft: {
        ...this.data.videoDraft,
        uploadPosterFileID: "",
        uploadPosterPreviewUrl: "",
      },
    });
    if ((this.data.pendingVideoFileIDs || []).includes(posterFileID)) {
      await this.cleanupPendingVideoFiles([posterFileID]);
    }
  },

  async removeCaseVideo() {
    if (this.data.videoUploading || this.data.posterUploading || this.data.saving) return;
    const pendingFileIDs = [...(this.data.pendingVideoFileIDs || [])];
    this.pendingVideoSelection = null;
    this.pendingPosterSelection = null;
    this.setData({
      videoSource: "upload",
      videoAdvancedOpen: false,
      videoDirty: true,
      videoRemoved: true,
      videoUploadError: "",
      posterUploadError: "",
      videoDraft: createEmptyVideoDraft(),
      videoFileSizeLabel: "",
    });
    if (pendingFileIDs.length) {
      await this.cleanupPendingVideoFiles(pendingFileIDs);
    }
  },

  onVideoPreviewError() {
    this.setData({
      videoUploadError: "当前视频无法预览，请确认使用 H.264 + AAC 编码",
    });
  },

  async refreshVideoConflictBaseline(error, lifecycleToken) {
    let nextVersion = Number(error && error.currentVersion);
    try {
      const latestCase = await fetchCaseAdminDetail(this.data.id);
      if (!this.isPageLifecycleActive(lifecycleToken)) return false;
      const latestVersion = Number(latestCase && latestCase.version);
      if (Number.isInteger(latestVersion) && latestVersion > 0) {
        nextVersion = latestVersion;
      }
      if (latestCase) {
        this.initialVideoDraft = buildVideoDraft(latestCase);
        this.initialVideoSource = latestCase.videoFileID
          ? "upload"
          : latestCase.videoUrl
            ? "external"
            : "upload";
      }
    } catch (refreshError) {
      logVideoIssue(
        "version_conflict_refresh",
        refreshError,
        "VIDEO_VERSION_REFRESH_FAILED"
      );
    }
    if (!this.isPageLifecycleActive(lifecycleToken)) return false;
    if (!Number.isInteger(nextVersion) || nextVersion <= 0) return false;
    this.caseVersion = nextVersion;
    return true;
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
    if (this.data.saving) return;
    if (this.data.uploading || this.data.videoUploading || this.data.posterUploading) {
      this.showTopTips("请等待文件上传完成");
      wx.showToast({ title: "请等待上传完成", icon: "none" });
      return;
    }
    if (this.data.imageProcessingFailed || this.data.pendingImagePaths.length) {
      this.showTopTips("请先重试并完成图片处理");
      wx.showToast({
        title: "请先完成图片处理",
        icon: "none",
      });
      return;
    }
    const videoValidation = buildCaseAdminVideoPatch(
      {
        dirty: this.data.videoDirty,
        removed: this.data.videoRemoved,
        source: this.data.videoSource,
        draft: this.data.videoDraft,
      },
      this.data.videoLimits
    );
    if (!videoValidation.valid) {
      this.showVideoMessage(videoValidation.message);
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

    const pendingVideoFileIDsAtSave = [
      ...(this.data.pendingVideoFileIDs || []),
    ];
    const lifecycleToken = this.getPageLifecycleToken();
    this.setData({ saving: true });
    this.syncVideoUnloadGuard();

    try {
      const payload = buildCaseAdminPayload(this.data.form);
      let saveResult;
      if (this.data.isEdit) {
        saveResult = await updateCaseAdmin(this.data.id, payload, {
          videoPatch: videoValidation.patch,
          expectedVersion: this.caseVersion,
        });
        const persistedFileIDs = new Set(
          videoValidation.patch && videoValidation.patch.mode === "upload"
            ? [
                videoValidation.patch.fileID,
                videoValidation.patch.posterFileID,
              ].filter(Boolean)
            : []
        );
        const stalePendingFileIDs = (this.data.pendingVideoFileIDs || []).filter(
          (fileID) => !persistedFileIDs.has(fileID)
        );
        if (this.pageUnloaded) {
          if (stalePendingFileIDs.length) {
            await this.cleanupDetachedVideoFiles(
              stalePendingFileIDs,
              "post_save_cleanup"
            );
          }
          return;
        }
        this.setData({ pendingVideoFileIDs: stalePendingFileIDs });
        this.syncVideoUnloadGuard();
        if (stalePendingFileIDs.length) {
          await this.cleanupPendingVideoFiles(stalePendingFileIDs);
        }
        if (this.pageUnloaded) return;
        this.releaseVideoUnloadGuard();
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
      if (this.pageUnloaded) return;
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
      logVideoIssue("case_save", error, "CASE_SAVE_FAILED");
      if (this.pageUnloaded) {
        if (pendingVideoFileIDsAtSave.length) {
          await this.cleanupDetachedVideoFiles(
            pendingVideoFileIDsAtSave,
            "failed_save_cleanup"
          );
        }
        return;
      }
      if (error.code === "VERSION_CONFLICT") {
        const versionRefreshed = await this.refreshVideoConflictBaseline(
          error,
          lifecycleToken
        );
        if (this.pageUnloaded) {
          if (pendingVideoFileIDsAtSave.length) {
            await this.cleanupDetachedVideoFiles(
              pendingVideoFileIDsAtSave,
              "conflict_unload_cleanup"
            );
          }
          return;
        }
        const message = versionRefreshed
          ? "案例版本已刷新，当前修改已保留，请再次保存"
          : "案例版本刷新失败，当前修改已保留，请稍后重试";
        this.showTopTips(message);
        wx.showToast({
          title: versionRefreshed ? "已刷新，可直接重试" : "版本刷新失败",
          icon: "none",
        });
        return;
      }
      const message = error.message || "保存失败，请稍后重试";
      this.showTopTips(message);
      wx.showToast({
        title: error.code === "HOME_DISPLAY_LIMIT_REACHED"
          ? "首页展示名额已满"
          : "保存失败，请稍后重试",
        icon: "none",
      });
    } finally {
      if (!this.pageUnloaded) {
        this.setData({ saving: false });
        this.syncVideoUnloadGuard();
      }
    }
  },
});
