const { fetchCaseById } = require("../../utils/cloudData");
const { formatJoined } = require("../../utils/caseData");
const {
  CUSTOMER_SERVICE_SOURCE,
  buildCustomerSessionFrom,
} = require("../../utils/customerServiceData");
const {
  fetchFavoriteForCase,
  toggleFavorite,
} = require("../../utils/favoriteService");
const { recordCaseView } = require("../../utils/historyService");

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

Page({
  data: {
    loading: true,
    errorMessage: "",
    caseItem: null,
    infoRows: [],
    displayTags: [],
    detailHeading: "",
    detailSubtitle: "",
    favorite: null,
    isFavorited: false,
    favoriteLoading: false,
    imagePreviewVisible: false,
    customerServiceSessionFrom: buildCustomerSessionFrom({
      source: CUSTOMER_SERVICE_SOURCE.DETAIL,
    }),
  },

  onLoad(options) {
    this.loadCase(options.id);
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
      const caseItem = await fetchCaseById(decodeURIComponent(id));
      this.setData({
        loading: false,
        caseItem,
        infoRows: buildInfoRows(caseItem),
        displayTags: caseItem.tags,
        detailHeading: buildDetailHeading(caseItem),
        detailSubtitle: buildDetailSubtitle(caseItem),
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
    const imageUrl = this.data.caseItem && this.data.caseItem.coverImageUrl;
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

  noop() {},

  downloadImage() {
    const imageUrl = this.data.caseItem && this.data.caseItem.coverImageUrl;
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
