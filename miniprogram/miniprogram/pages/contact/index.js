const { CONTACT_DATA } = require("./contactData");
const { fetchPublicContact } = require("./contactService");

const CONTACT_SHARE_TITLE = "联系我们｜金亿诚包装科技";

Page({
  data: {
    ...CONTACT_DATA,
    activeStoreImageIndex: 0,
    isAdmin: false,
  },

  onShow() {
    this.loadPublicContact();
  },

  async loadPublicContact() {
    try {
      const contact = await fetchPublicContact();
      const patch = {
        isAdmin: contact.isAdmin,
      };
      if (Array.isArray(contact.storeImages) && contact.storeImages.length) {
        patch.storeImages = contact.storeImages;
        patch.activeStoreImageIndex = 0;
      }
      if (
        Array.isArray(contact.wechatQrImages) &&
        contact.wechatQrImages.length
      ) {
        patch.wechatQrImages = contact.wechatQrImages;
        patch.wechatQrImage = contact.wechatQrImages[0];
      } else if (contact.wechatQrImage) {
        patch.wechatQrImages = [contact.wechatQrImage];
        patch.wechatQrImage = contact.wechatQrImage;
      }
      if (Array.isArray(contact.phoneNumbers)) {
        patch.phoneNumbers = contact.phoneNumbers;
      }
      this.setData(patch);
    } catch (error) {
      this.setData({
        ...CONTACT_DATA,
        activeStoreImageIndex: 0,
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
    return {
      title: CONTACT_SHARE_TITLE,
      path: "/pages/contact/index",
      imageUrl: this.data.storeImages[0],
    };
  },

  onShareTimeline() {
    return {
      title: CONTACT_SHARE_TITLE,
      imageUrl: this.data.storeImages[0],
    };
  },
});
