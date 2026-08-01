const { CONTACT_DATA } = require("./contactData");
const { fetchPublicContact } = require("./contactService");

const CONTACT_SHARE_TITLE = "联系我们｜金亿诚包装科技";

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

Page({
  data: {
    ...CONTACT_DATA,
    activeStoreImageIndex: 0,
    storeImagesLoading: true,
    storeImagesError: false,
    wechatQrLoading: true,
    wechatQrError: false,
    isAdmin: false,
  },

  onShow() {
    this.loadPublicContact();
  },

  async loadPublicContact() {
    const requestId = (this._publicContactRequestId || 0) + 1;
    this._publicContactRequestId = requestId;
    // 每次读取前先清空已渲染的图片，避免管理员更新后短暂显示旧内容。
    this.setData({
      storeImages: [],
      wechatQrImages: [],
      wechatQrImage: "",
      activeStoreImageIndex: 0,
      storeImagesLoading: true,
      storeImagesError: false,
      wechatQrLoading: true,
      wechatQrError: false,
    });

    try {
      const contact = await fetchPublicContact();
      if (requestId !== this._publicContactRequestId) return;
      const storeImages = Array.isArray(contact.storeImages)
        ? contact.storeImages
        : [];
      const wechatQrImages = normalizeWechatQrImages(
        contact.wechatQrImages,
        contact.wechatQrImage
      );
      const patch = {
        isAdmin: contact.isAdmin,
        storeImages,
        wechatQrImages,
        wechatQrImage: wechatQrImages[0] || "",
        activeStoreImageIndex: 0,
        storeImagesLoading: false,
        storeImagesError: false,
        wechatQrLoading: false,
        wechatQrError: false,
      };
      if (Array.isArray(contact.phoneNumbers)) {
        patch.phoneNumbers = contact.phoneNumbers;
      }
      this.setData(patch);
    } catch (error) {
      if (requestId !== this._publicContactRequestId) return;
      this.setData({
        storeImages: [],
        wechatQrImages: [],
        wechatQrImage: "",
        activeStoreImageIndex: 0,
        storeImagesLoading: false,
        storeImagesError: true,
        wechatQrLoading: false,
        wechatQrError: true,
        isAdmin: false,
      });
    }
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
