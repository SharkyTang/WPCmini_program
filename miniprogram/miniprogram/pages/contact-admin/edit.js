const {
  CONTACT_STORE_IMAGE_MAX,
  CONTACT_WECHAT_QR_MAX,
  QR_IMAGE_MAX_BYTES,
  STORE_IMAGE_MAX_BYTES,
  buildContactAssetCloudPath,
  extractMediaFiles,
  normalizeContactAdminDraft,
  validatePhoneNumbers,
} = require("./utils/contactAdminData");
const {
  checkContactAdminAccess,
  cleanupContactFiles,
  fetchContactAdminDraft,
  prepareContactImageForUpload = async ({ filePath }) => filePath,
  saveContactAdmin,
  uploadContactImage,
} = require("./utils/contactAdminService");

const UPLOAD_CONCURRENCY = 2;
let pendingImageSequence = 0;

function createPendingImage(filePath, kind, byteSize = 0) {
  pendingImageSequence += 1;
  return {
    key: `${kind}-pending-${Date.now()}-${pendingImageSequence}`,
    fileID: "",
    url: filePath,
    localPath: filePath,
    byteSize: Number(byteSize) || 0,
    isPending: true,
  };
}

function getErrorMessage(error, fallback) {
  if (error && error.code === "FORBIDDEN") {
    return "当前微信身份没有联系信息管理权限";
  }
  if (error && error.code === "CONFLICT") {
    return "联系信息已被其他管理员更新，请重新进入后再修改";
  }
  return (error && error.message) || fallback;
}

async function mapSettledWithConcurrency(
  items = [],
  concurrency = UPLOAD_CONCURRENCY,
  mapper
) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await mapper(items[index], index),
        };
      } catch (reason) {
        results[index] = {
          status: "rejected",
          reason,
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

Page({
  data: {
    loading: true,
    accessChecked: false,
    isAdmin: false,
    saving: false,
    errorMessage: "",
    inlineMessage: "",
    galleryMax: CONTACT_STORE_IMAGE_MAX,
    wechatQrMax: CONTACT_WECHAT_QR_MAX,
    storeImages: [],
    wechatQrs: [],
    phoneNumbers: ["", ""],
    revision: 0,
  },

  onLoad() {
    return this.loadDraft();
  },

  async loadDraft() {
    if (this.data.loading && this.data.accessChecked) return;
    this.setData({
      loading: true,
      accessChecked: false,
      isAdmin: false,
      errorMessage: "",
      inlineMessage: "",
    });
    try {
      const isAdmin = await checkContactAdminAccess();
      if (!isAdmin) {
        this.setData({
          loading: false,
          accessChecked: true,
          isAdmin: false,
        });
        return;
      }
      const result = await fetchContactAdminDraft();
      const draft = normalizeContactAdminDraft(result);
      this.setData({
        loading: false,
        accessChecked: true,
        isAdmin: true,
        storeImages: draft.storeImages,
        wechatQrs: draft.wechatQrs,
        phoneNumbers: draft.phoneNumbers,
        revision: draft.revision,
      });
    } catch (error) {
      console.warn("读取联系信息管理配置失败", error);
      this.setData({
        loading: false,
        accessChecked: true,
        isAdmin: false,
        errorMessage: getErrorMessage(error, "联系信息读取失败，请稍后重试"),
      });
    }
  },

  retryLoad() {
    return this.loadDraft();
  },

  canEdit() {
    if (
      !this.data.accessChecked ||
      !this.data.isAdmin ||
      this.data.loading
    ) {
      wx.showToast({
        title: "当前微信身份无管理权限",
        icon: "none",
      });
      return false;
    }
    return !this.data.saving;
  },

  chooseStoreImages() {
    if (!this.canEdit()) return;
    const remaining = CONTACT_STORE_IMAGE_MAX - this.data.storeImages.length;
    if (remaining <= 0) {
      wx.showToast({
        title: `最多上传 ${CONTACT_STORE_IMAGE_MAX} 张门店图片`,
        icon: "none",
      });
      return;
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      sizeType: ["compressed"],
      success: (result) => {
        const files = extractMediaFiles(
          result,
          remaining,
          STORE_IMAGE_MAX_BYTES
        );
        const accepted = files.filter((file) => !file.oversized);
        if (files.some((file) => file.oversized)) {
          wx.showToast({
            title: "单张门店图片不能超过 5MB",
            icon: "none",
          });
        }
        if (!accepted.length) return;
        this.setData({
          storeImages: this.data.storeImages.concat(
            accepted.map((file) =>
              createPendingImage(file.filePath, "store", file.size)
            )
          ),
          inlineMessage: "",
        });
      },
    });
  },

  chooseWechatQr() {
    if (!this.canEdit()) return;
    const remaining = CONTACT_WECHAT_QR_MAX - this.data.wechatQrs.length;
    if (remaining <= 0) {
      wx.showToast({
        title: `最多上传 ${CONTACT_WECHAT_QR_MAX} 张二维码`,
        icon: "none",
      });
      return;
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      sizeType: ["original"],
      success: (result) => {
        const files = extractMediaFiles(
          result,
          remaining,
          QR_IMAGE_MAX_BYTES
        );
        const accepted = files.filter((file) => !file.oversized);
        if (files.some((file) => file.oversized)) {
          wx.showToast({
            title: "单张二维码图片不能超过 10MB",
            icon: "none",
          });
        }
        if (!accepted.length) return;
        this.setData({
          wechatQrs: this.data.wechatQrs.concat(
            accepted.map((file) =>
              createPendingImage(file.filePath, "wechat", file.size)
            )
          ),
          inlineMessage: "",
        });
      },
    });
  },

  previewStoreImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    const urls = this.data.storeImages.map((image) => image.url).filter(Boolean);
    if (!urls.length) return;
    wx.previewImage({
      current: urls[index] || urls[0],
      urls,
    });
  },

  previewWechatQr(event) {
    const index = Number(event.currentTarget.dataset.index);
    const urls = this.data.wechatQrs.map((image) => image.url).filter(Boolean);
    if (!urls.length) return;
    wx.previewImage({
      current: urls[index] || urls[0],
      urls,
    });
  },

  moveStoreImage(event) {
    if (!this.canEdit()) return;
    const index = Number(event.currentTarget.dataset.index);
    const direction = event.currentTarget.dataset.direction;
    const nextIndex = direction === "left" ? index - 1 : index + 1;
    const storeImages = [...this.data.storeImages];
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      nextIndex < 0 ||
      index >= storeImages.length ||
      nextIndex >= storeImages.length
    ) {
      return;
    }
    [storeImages[index], storeImages[nextIndex]] = [
      storeImages[nextIndex],
      storeImages[index],
    ];
    this.setData({
      storeImages,
      inlineMessage: "",
    });
  },

  removeStoreImage(event) {
    if (!this.canEdit()) return;
    const index = Number(event.currentTarget.dataset.index);
    const storeImages = [...this.data.storeImages];
    if (!Number.isInteger(index) || index < 0 || index >= storeImages.length) {
      return;
    }
    storeImages.splice(index, 1);
    this.setData({
      storeImages,
      inlineMessage: "",
    });
  },

  removeWechatQr(event) {
    if (!this.canEdit()) return;
    const index = Number(event.currentTarget.dataset.index);
    const wechatQrs = [...this.data.wechatQrs];
    if (!Number.isInteger(index) || index < 0 || index >= wechatQrs.length) {
      return;
    }
    wechatQrs.splice(index, 1);
    this.setData({
      wechatQrs,
      inlineMessage: "",
    });
  },

  onPhoneInput(event) {
    if (!this.data.isAdmin || this.data.saving) return;
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index > 1) return;
    const phoneNumbers = [...this.data.phoneNumbers];
    phoneNumbers[index] = event.detail.value || "";
    this.setData({
      phoneNumbers,
      inlineMessage: "",
    });
  },

  async saveContact() {
    if (this.data.saving) return;
    if (!this.canEdit()) return;

    const phoneValidation = validatePhoneNumbers(this.data.phoneNumbers);
    if (!phoneValidation.valid) {
      this.setData({
        inlineMessage: phoneValidation.message,
      });
      wx.showToast({
        title: phoneValidation.message,
        icon: "none",
      });
      return;
    }

    this.setData({
      saving: true,
      inlineMessage: "",
    });

    const uploadedFileIDs = [];
    try {
      const stillAdmin = await checkContactAdminAccess();
      if (!stillAdmin) {
        const forbiddenError = new Error("当前微信身份没有联系信息管理权限");
        forbiddenError.code = "FORBIDDEN";
        throw forbiddenError;
      }

      const uploadTasks = [];
      this.data.storeImages.forEach((image) => {
        if (image.isPending) {
          uploadTasks.push({
            key: image.key,
            kind: "store",
            filePath: image.localPath,
            byteSize: image.byteSize,
          });
        }
      });
      this.data.wechatQrs.forEach((image) => {
        if (image.isPending) {
          uploadTasks.push({
            key: image.key,
            kind: "wechat",
            filePath: image.localPath,
            byteSize: image.byteSize,
          });
        }
      });

      const uploadResults = await mapSettledWithConcurrency(
        uploadTasks,
        UPLOAD_CONCURRENCY,
        async (task, index) => {
          const uploadFilePath = await prepareContactImageForUpload({
            filePath: task.filePath,
            kind: task.kind,
            byteSize: task.byteSize,
          });
          const fileID = await uploadContactImage({
            filePath: uploadFilePath,
            cloudPath: buildContactAssetCloudPath(
              task.kind,
              uploadFilePath,
              `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`
            ),
          });
          return {
            key: task.key,
            fileID,
          };
        }
      );

      const uploadedByKey = {};
      let uploadError = null;
      uploadResults.forEach((result) => {
        if (result.status === "fulfilled" && result.value) {
          uploadedByKey[result.value.key] = result.value.fileID;
          uploadedFileIDs.push(result.value.fileID);
          return;
        }
        if (!uploadError) {
          uploadError =
            result.status === "rejected"
              ? result.reason
              : new Error("部分联系图片上传失败");
        }
      });
      if (uploadError) throw uploadError;

      const storeImageFileIds = this.data.storeImages
        .map((image) =>
          image.isPending ? uploadedByKey[image.key] : image.fileID
        )
        .filter(Boolean);
      const wechatQrFileIds = this.data.wechatQrs
        .map((image) =>
          image.isPending ? uploadedByKey[image.key] : image.fileID
        )
        .filter(Boolean);

      await saveContactAdmin(
        {
          storeImageFileIds,
          wechatQrFileIds,
          // 旧云函数仍可安全保存第一张，新云函数使用上面的数组。
          wechatQrFileId: wechatQrFileIds[0] || "",
          phoneNumbers: phoneValidation.phoneNumbers,
        },
        this.data.revision,
        CONTACT_STORE_IMAGE_MAX
      );

      this.setData({
        saving: false,
      });
      wx.showToast({
        title: "联系信息已保存",
        icon: "success",
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 500);
    } catch (error) {
      console.warn("保存联系信息失败", error);
      if (uploadedFileIDs.length) {
        try {
          await cleanupContactFiles(uploadedFileIDs);
        } catch (cleanupError) {
          console.warn("本轮联系图片清理失败", cleanupError);
        }
      }
      const errorMessage = getErrorMessage(error, "保存失败，请稍后重试");
      this.setData({
        saving: false,
        isAdmin: error && error.code === "FORBIDDEN" ? false : this.data.isAdmin,
        inlineMessage: errorMessage,
      });
      wx.showToast({
        title: errorMessage,
        icon: "none",
      });
    }
  },
});
