const { fetchCaseById } = require("../../utils/cloudData");
const { fetchCaseDetail } = require("../../utils/caseCatalogService");
const { formatJoined } = require("../../utils/caseData");
const {
  CUSTOMER_SERVICE_SOURCE,
  buildCustomerMessageCard,
  buildCustomerSessionFrom,
} = require("../../utils/customerServiceData");
const {
  fetchFavoriteForCase,
  toggleFavorite,
} = require("../../utils/favoriteService");
const { recordCaseView } = require("../../utils/historyService");
const { ensureProfileIdentity } = require("../../utils/userService");

function buildInfoRows(caseItem) {
  return [
    {
      label: "包装内容",
      value: formatJoined(caseItem.packageTypes),
    },
    {
      label: "适用场景",
      value: formatJoined(caseItem.scenes),
    },
    {
      label: "价位感",
      value: formatJoined(caseItem.priceLevel),
    },
    {
      label: "风格",
      value: formatJoined(caseItem.styles),
    },
    {
      label: "酒类",
      value: formatJoined(caseItem.wineType),
    },
  ];
}

function buildDetailHeading(caseItem) {
  const packageLabel = caseItem.packageTypes && caseItem.packageTypes[0];
  const wineLabel = caseItem.wineType || "白酒";
  return `${packageLabel || caseItem.title} · ${wineLabel}品牌视觉组合`;
}

function buildDetailSubtitle(caseItem) {
  return formatJoined(
    [caseItem.wineType, ...(caseItem.packageTypes || []), ...(caseItem.styles || [])].filter(Boolean),
    "酒包装设计参考"
  );
}

function buildGalleryItems(caseItem = {}) {
  const gallery = Array.isArray(caseItem.gallery) && caseItem.gallery.length
    ? caseItem.gallery
    : [{ fileID: caseItem.coverImage, url: caseItem.coverImageUrl }];
  return gallery
    .filter((item) => item && (item.url || item.displayUrl))
    .map((item, index) => ({
      ...item,
      displayUrl: item.displayUrl || item.url || "",
      thumbnailUrl: item.thumbnailUrl || item.displayUrl || item.url || "",
      renderUrl:
        index === 0
          ? item.displayUrl || item.url || ""
          : item.thumbnailUrl || item.displayUrl || item.url || "",
      downloadUrl: item.displayUrl || item.url || "",
      loaded: index === 0,
      index,
      positionLabel: `第 ${index + 1} 张`,
    }));
}

function buildCaseShare(pageData = {}) {
  const caseItem = pageData.caseItem;
  const caseId =
    caseItem && (caseItem.id || caseItem._id || caseItem.caseId);
  if (!caseItem || !caseId) {
    return {
      title: "金亿诚包装科技｜酒包装灵感库",
      path: "/pages/index/index",
      query: "",
    };
  }

  const imageUrl =
    (pageData.galleryItems &&
      pageData.galleryItems[0] &&
      pageData.galleryItems[0].displayUrl) ||
    pageData.currentImageUrl ||
    "";
  return {
    title: `${caseItem.title || "酒包装设计案例"}｜金亿诚包装科技`,
    path: `/pages/detail/index?id=${encodeURIComponent(caseId)}`,
    query: `id=${encodeURIComponent(caseId)}`,
    imageUrl,
  };
}

Page({
  data: {
    loading: true,
    errorMessage: "",
    caseItem: null,
    infoRows: [],
    detailHeading: "",
    detailSubtitle: "",
    favorite: null,
    isFavorited: false,
    favoriteLoading: false,
    imagePreviewVisible: false,
    galleryItems: [],
    currentImageIndex: 0,
    currentImageUrl: "",
    currentDownloadUrl: "",
    customerServiceMessageCardEnabled: false,
    customerServiceMessageTitle: "",
    customerServiceMessagePath: "",
    customerServiceMessageImage: "",
    customerServiceSessionFrom: buildCustomerSessionFrom({
      source: CUSTOMER_SERVICE_SOURCE.DETAIL,
    }),
  },

  onLoad(options) {
    this.loadCase(options.id);
  },

  onShareAppMessage() {
    const share = buildCaseShare(this.data);
    const result = {
      title: share.title,
      path: share.path,
    };
    if (share.imageUrl) {
      result.imageUrl = share.imageUrl;
    }
    return result;
  },

  onShareTimeline() {
    const share = buildCaseShare(this.data);
    const result = {
      title: share.title,
      query: share.query,
    };
    if (share.imageUrl) {
      result.imageUrl = share.imageUrl;
    }
    return result;
  },

  async loadCase(id) {
    if (!id) {
      this.setData({
        loading: false,
        errorMessage: "没有找到这个案例的 ID。",
      });
      return;
    }

    this.setData({
      loading: true,
      errorMessage: "",
    });

    try {
      const decodedId = decodeURIComponent(id);
      let caseItem;
      try {
        caseItem = await fetchCaseDetail(decodedId);
      } catch (catalogError) {
        console.warn("详情聚合接口不可用，使用兼容读取", catalogError);
        caseItem = await fetchCaseById(decodedId);
      }
      const galleryItems = buildGalleryItems(caseItem);
      const customerServiceMessageCard = buildCustomerMessageCard({
        caseItem,
        imageUrl: galleryItems[0] ? galleryItems[0].displayUrl : "",
      });
      this.setData({
        loading: false,
        caseItem,
        infoRows: buildInfoRows(caseItem),
        detailHeading: buildDetailHeading(caseItem),
        detailSubtitle: buildDetailSubtitle(caseItem),
        galleryItems,
        currentImageIndex: 0,
        currentImageUrl: galleryItems[0] ? galleryItems[0].displayUrl : "",
        currentDownloadUrl: galleryItems[0] ? galleryItems[0].displayUrl : "",
        customerServiceMessageCardEnabled: customerServiceMessageCard.enabled,
        customerServiceMessageTitle: customerServiceMessageCard.title,
        customerServiceMessagePath: customerServiceMessageCard.path,
        customerServiceMessageImage: customerServiceMessageCard.imageUrl,
        customerServiceSessionFrom: buildCustomerSessionFrom({
          source: CUSTOMER_SERVICE_SOURCE.DETAIL,
          caseItem,
        }),
      });
      this.loadFavoriteState(caseItem);
      this.recordView(caseItem);
    } catch (error) {
      console.error("案例详情读取失败", error);
      this.setData({
        loading: false,
        errorMessage: "暂时读取不到这个案例，请返回后重试。",
      });
    }
  },

  async loadFavoriteState(caseItem) {
    try {
      const favorite = await fetchFavoriteForCase(caseItem);
      this.setData({
        favorite,
        isFavorited: Boolean(favorite),
      });
    } catch (error) {
      console.warn("收藏状态读取失败", error);
    }
  },

  async recordView(caseItem) {
    try {
      await recordCaseView(caseItem);
    } catch (error) {
      console.warn("浏览记录写入失败", error);
    }
  },

  async toggleFavorite() {
    if (!this.data.caseItem || this.data.favoriteLoading) return;

    this.setData({
      favoriteLoading: true,
    });

    try {
      const identity = await ensureProfileIdentity({
        resume: () => this.toggleFavorite(),
      });
      if (!identity.ready) {
        this.setData({ favoriteLoading: false });
        return;
      }

      const result = await toggleFavorite(this.data.caseItem, this.data.favorite);
      this.setData({
        favoriteLoading: false,
        favorite: result.favorite,
        isFavorited: result.isFavorited,
      });

      if (result.action === "limitReached") {
        wx.showToast({
          title: "收藏已满，可先取消一些收藏",
          icon: "none",
        });
        return;
      }

      if (result.action === "cancelled") return;

      wx.showToast({
        title: result.isFavorited ? "已收藏" : "已取消收藏",
        icon: "success",
      });
    } catch (error) {
      console.error("收藏操作失败", error);
      this.setData({
        favoriteLoading: false,
      });
      wx.showToast({
        title: "收藏操作失败",
        icon: "none",
      });
    }
  },

  previewImage() {
    const imageUrl = this.data.currentImageUrl;
    if (!imageUrl) {
      wx.showToast({
        title: "暂无图片",
        icon: "none",
      });
      return;
    }

    this.setData({
      imagePreviewVisible: true,
    });
  },

  closeImagePreview() {
    this.setData({
      imagePreviewVisible: false,
    });
  },

  onGalleryChange(event) {
    const currentImageIndex = Number(event.detail && event.detail.current) || 0;
    this.showGalleryImage(currentImageIndex);
  },

  selectGalleryImage(event) {
    const currentImageIndex = Number(event.currentTarget.dataset.index) || 0;
    this.showGalleryImage(currentImageIndex);
  },

  showGalleryImage(currentImageIndex) {
    const current = this.data.galleryItems[currentImageIndex];
    if (!current) return;
    const galleryItems = current.loaded
      ? this.data.galleryItems
      : this.data.galleryItems.map((item, index) =>
          index === currentImageIndex
            ? { ...item, renderUrl: item.displayUrl, loaded: true }
            : item
        );
    this.setData({
      galleryItems,
      currentImageIndex,
      currentImageUrl: current.displayUrl,
      currentDownloadUrl: current.displayUrl,
    });
  },

  noop() {},

  downloadImage() {
    const imageUrl = this.data.currentDownloadUrl || this.data.currentImageUrl;
    if (!imageUrl) {
      wx.showToast({
        title: "暂无图片可下载",
        icon: "none",
      });
      return;
    }

    wx.showLoading({
      title: "正在保存",
    });

    wx.downloadFile({
      url: imageUrl,
      success: (downloadResponse) => {
        if (downloadResponse.statusCode !== 200) {
          wx.hideLoading();
          wx.showToast({
            title: "图片下载失败",
            icon: "none",
          });
          return;
        }

        wx.saveImageToPhotosAlbum({
          filePath: downloadResponse.tempFilePath,
          success() {
            wx.hideLoading();
            wx.showToast({
              title: "已保存到相册",
              icon: "success",
            });
          },
          fail() {
            wx.hideLoading();
            wx.showToast({
              title: "保存失败，请检查相册权限",
              icon: "none",
            });
          },
        });
      },
      fail() {
        wx.hideLoading();
        wx.showToast({
          title: "图片下载失败",
          icon: "none",
        });
      },
    });
  },

  handleContact(event) {
    console.log("案例客服会话入口", event.detail || {});
  },

  openInquiryForm() {
    const caseItem = this.data.caseItem;
    if (!caseItem) return;

    const caseDocId = caseItem.id || caseItem._id || caseItem.caseId;
    wx.navigateTo({
      url: `/pages/inquiry/index?source=detail&id=${encodeURIComponent(caseDocId)}`,
    });
  },

  goBack() {
    wx.navigateBack({
      fail() {
        wx.switchTab({
          url: "/pages/category/index",
        });
      },
    });
  },
});
