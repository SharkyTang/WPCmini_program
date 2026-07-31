const CONTACT_DATA = Object.freeze({
  storeName: "金亿诚包装科技",
  address: "贵州省遵义市仁怀市国际商贸中心酒包材市场2栋1楼111-118号",
  // 仁怀国际商贸中心公开地图中心点；正式发布前需在微信真机确认门店落点。
  latitude: 27.783649,
  longitude: 106.395409,
  storeImages: Object.freeze([
    "/pages/contact/assets/store-1.jpg",
    "/pages/contact/assets/store-2.jpg",
    "/pages/contact/assets/store-3.jpg",
  ]),
  wechatQrImage: "/pages/contact/assets/boss-wechat-qr.jpg",
  phoneNumbers: Object.freeze([]),
});

module.exports = {
  CONTACT_DATA,
};
