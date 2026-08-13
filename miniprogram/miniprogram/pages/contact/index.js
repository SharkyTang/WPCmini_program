const { CONTACT_DATA } = require("./contactData");
const { fetchPublicContact } = require("./contactService");

const CONTACT_SHARE_TITLE = "联系我们｜金亿诚包装科技";
const WECHAT_QR_LOAD_TIMEOUT_MS = 15000;

function normalizeWechatQrImages(images, legacyImage) {
  const normalizedImages = Array.isArray(images)
    ? images
        .filter((image) => typeof image === "string" && image.trim())
        .map((image) => image.trim())
        .slice(0, 2)
    : [];
  if (normalizedImages.length) return normalizedImages;
  return typeof legacyImage === "string" && legacyImage.trim()
    ? [legacyImage.trim()]
    : [];
}

function clearWechatQrImageLoadTimer(page) {
  const state = page._wechatQrImageLoadState;
  if (!state || state.timeoutId === null) return;
  clearTimeout(state.timeoutId);
  state.timeoutId = null;
}

function beginContactLoading(page) {
  clearWechatQrImageLoadTimer(page);
  page._wechatQrImageLoadState = null;
  const requestId = (page._contactLoadSequence || 0) + 1;
  page._contactLoadSequence = requestId;
  page._activeContactLoadRequestId = requestId;
  if (page._contactLoadingVisible) return requestId;
  page._contactLoadingVisible = true;
  wx.showLoading({
    title: "加载中",
    mask: true,
  });
  return requestId;
}

function isCurrentContactLoad(page, requestId) {
  return page._activeContactLoadRequestId === requestId;
}

function finishContactLoading(page, requestId) {
  if (!isCurrentContactLoad(page, requestId)) return;
  clearWechatQrImageLoadTimer(page);
  page._activeContactLoadRequestId = 0;
  if (!page._contactLoadingVisible) return;
  page._contactLoadingVisible = false;
  wx.hideLoading();
}

function cancelContactLoading(page) {
  page._contactLoadSequence = (page._contactLoadSequence || 0) + 1;
  page._activeContactLoadRequestId = 0;
  clearWechatQrImageLoadTimer(page);
  page._wechatQrImageLoadState = null;
  if (!page._contactLoadingVisible) return;
  page._contactLoadingVisible = false;
  wx.hideLoading();
}

function beginWechatQrImageLoading(page, requestId, images) {
  const state = {
    requestId,
    total: images.length,
    settledIndexes: new Set(),
    failedIndexes: new Set(),
    timeoutId: null,
  };
  page._wechatQrImageLoadState = state;
  state.timeoutId = setTimeout(() => {
    completeWechatQrImageLoading(page, state);
  }, WECHAT_QR_LOAD_TIMEOUT_MS);
}

function completeWechatQrImageLoading(page, state) {
  if (
    page._wechatQrImageLoadState !== state ||
    !isCurrentContactLoad(page, state.requestId)
  ) {
    return;
  }

  clearWechatQrImageLoadTimer(page);
  const loadedImages = (page.data.wechatQrImages || []).filter(
    (_, imageIndex) =>
      state.settledIndexes.has(imageIndex) &&
      !state.failedIndexes.has(imageIndex)
  );
  page._wechatQrImageLoadState = null;
  page.setData(
    {
      wechatQrImages: loadedImages,
      wechatQrImage: loadedImages[0] || "",
      wechatQrLoading: false,
      wechatQrError: !loadedImages.length,
    },
    () => {
      finishContactLoading(page, state.requestId);
    }
  );
}

function settleWechatQrImageLoading(page, event, failed) {
  const state = page._wechatQrImageLoadState;
  const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
  const requestId = Number(dataset.requestId);
  const index = Number(dataset.index);
  if (
    !state ||
    state.requestId !== requestId ||
    !isCurrentContactLoad(page, requestId) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= state.total ||
    state.settledIndexes.has(index)
  ) {
    return;
  }

  state.settledIndexes.add(index);
  if (failed) state.failedIndexes.add(index);
  if (state.settledIndexes.size < state.total) return;
  completeWechatQrImageLoading(page, state);
}

Page({
  data: {
    ...CONTACT_DATA,
    activeStoreImageIndex: 0,
    storeImagesLoading: true,
    storeImagesError: false,
    wechatQrLoading: true,
    wechatQrError: false,
    wechatQrRequestId: 0,
    isAdmin: false,
  },

  onShow() {
    this.loadPublicContact();
  },

  onHide() {
    cancelContactLoading(this);
  },

  onUnload() {
    cancelContactLoading(this);
  },

  async loadPublicContact() {
    const requestId = beginContactLoading(this);
    // 每次读取前清空已渲染图片，等云端新图真正加载完成后再关闭原生 loading。
    this.setData({
      storeImages: [],
      wechatQrImages: [],
      wechatQrImage: "",
      wechatQrRequestId: requestId,
      activeStoreImageIndex: 0,
      storeImagesLoading: true,
      storeImagesError: false,
      wechatQrLoading: true,
      wechatQrError: false,
    });

    try {
      const contact = await fetchPublicContact();
      if (!isCurrentContactLoad(this, requestId)) return;
      const storeImages = Array.isArray(contact.storeImages)
        ? contact.storeImages
        : [];
      const wechatQrImages = normalizeWechatQrImages(
        contact.wechatQrImages,
        contact.wechatQrImage
      );
      if (wechatQrImages.length) {
        beginWechatQrImageLoading(this, requestId, wechatQrImages);
      }
      const patch = {
        isAdmin: contact.isAdmin,
        storeImages,
        wechatQrImages,
        wechatQrImage: wechatQrImages[0] || "",
        activeStoreImageIndex: 0,
        storeImagesLoading: false,
        storeImagesError: false,
        wechatQrLoading: Boolean(wechatQrImages.length),
        wechatQrError: false,
      };
      if (Array.isArray(contact.phoneNumbers)) {
        patch.phoneNumbers = contact.phoneNumbers;
      }
      this.setData(patch, () => {
        if (!wechatQrImages.length) {
          finishContactLoading(this, requestId);
        }
      });
    } catch (error) {
      if (!isCurrentContactLoad(this, requestId)) return;
      clearWechatQrImageLoadTimer(this);
      this._wechatQrImageLoadState = null;
      this.setData(
        {
          storeImages: [],
          wechatQrImages: [],
          wechatQrImage: "",
          activeStoreImageIndex: 0,
          storeImagesLoading: false,
          storeImagesError: true,
          wechatQrLoading: false,
          wechatQrError: true,
          isAdmin: false,
        },
        () => {
          finishContactLoading(this, requestId);
        }
      );
    }
  },

  onWechatQrImageLoad(event) {
    settleWechatQrImageLoading(this, event, false);
  },

  onWechatQrImageError(event) {
    settleWechatQrImageLoading(this, event, true);
  },

  openContactAdmin() {
    if (!this.data.isAdmin) return;
    wx.navigateTo({
      url: "/pages/contact-admin/edit",
    });
  },

  onStoreImageChange(event) {
    const activeStoreImageIndex = Number(
      event && event.detail && event.detail.current
    );
    if (!Number.isInteger(activeStoreImageIndex) || activeStoreImageIndex < 0) {
      return;
    }
    this.setData({
      activeStoreImageIndex,
    });
  },

  previewStoreImage(event) {
    if (!Array.isArray(this.data.storeImages) || !this.data.storeImages.length) {
      return;
    }
    const index = Number(event && event.currentTarget && event.currentTarget.dataset.index);
    const safeIndex =
      Number.isInteger(index) && index >= 0 && index < this.data.storeImages.length
        ? index
        : 0;
    wx.previewImage({
      current: this.data.storeImages[safeIndex],
      urls: this.data.storeImages,
    });
  },

  previewWechatQr(event) {
    const urls = Array.isArray(this.data.wechatQrImages)
      ? this.data.wechatQrImages.filter(Boolean).slice(0, 2)
      : [];
    if (!urls.length && this.data.wechatQrImage) {
      urls.push(this.data.wechatQrImage);
    }
    if (!urls.length) return;
    const index = Number(
      event && event.currentTarget && event.currentTarget.dataset.index
    );
    const safeIndex =
      Number.isInteger(index) && index >= 0 && index < urls.length ? index : 0;
    wx.previewImage({
      current: urls[safeIndex],
      urls,
    });
  },

  openStoreLocation() {
    wx.openLocation({
      latitude: this.data.latitude,
      longitude: this.data.longitude,
      name: this.data.storeName,
      address: this.data.address,
      scale: 18,
      fail: () => this.copyAddressAfterMapFailure(),
    });
  },

  copyAddressAfterMapFailure() {
    wx.setClipboardData({
      data: this.data.address,
      success() {
        wx.showToast({
          title: "地图打开失败，地址已复制",
          icon: "none",
        });
      },
      fail() {
        wx.showToast({
          title: "暂时无法打开地图",
          icon: "none",
        });
      },
    });
  },

  callPhone(event) {
    const index = Number(
      event && event.currentTarget && event.currentTarget.dataset.index
    );
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.data.phoneNumbers.length
    ) {
      return;
    }
    const phoneNumber = this.data.phoneNumbers[index].dialNumber;
    if (!phoneNumber) return;
    wx.makePhoneCall({
      phoneNumber,
      fail(error) {
        const message = String((error && error.errMsg) || "").toLowerCase();
        if (message.includes("cancel")) return;
        wx.showToast({
          title: "暂时无法拨打电话",
          icon: "none",
        });
      },
    });
  },

  onShareAppMessage() {
    const share = {
      title: CONTACT_SHARE_TITLE,
      path: "/pages/contact/index",
    };
    if (this.data.storeImages[0]) {
      share.imageUrl = this.data.storeImages[0];
    }
    return share;
  },

  onShareTimeline() {
    const share = {
      title: CONTACT_SHARE_TITLE,
    };
    if (this.data.storeImages[0]) {
      share.imageUrl = this.data.storeImages[0];
    }
    return share;
  },
});
