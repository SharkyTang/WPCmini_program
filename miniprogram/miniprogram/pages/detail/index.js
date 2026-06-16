const { fetchCaseById } = require("../../utils/cloudData");
const { formatJoined } = require("../../utils/caseData");

function buildInfoRows(caseItem) {
  return [
    {
      label: "酒类",
      value: formatJoined(caseItem.wineType),
    },
    {
      label: "包装内容",
      value: formatJoined(caseItem.packageTypes),
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
      label: "工艺",
      value: formatJoined(caseItem.crafts),
    },
    {
      label: "使用场景",
      value: formatJoined(caseItem.scenes),
    },
  ];
}

Page({
  data: {
    loading: true,
    errorMessage: "",
    caseItem: null,
    infoRows: [],
    displayTags: [],
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
      });
    } catch (error) {
      console.error("案例详情读取失败", error);
      this.setData({
        loading: false,
        errorMessage: "暂时读取不到这个案例，请返回后重试。",
      });
    }
  },

  goBack() {
    wx.navigateBack({
      fail() {
        wx.redirectTo({
          url: "/pages/index/index",
        });
      },
    });
  },
});
