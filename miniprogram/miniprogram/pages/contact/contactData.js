const DEFAULT_WECHAT_QR_IMAGE = "/pages/contact/assets/boss-wechat-qr.jpg";

const CONTACT_DATA = Object.freeze({
  storeName: "金亿诚包装科技",
  address: "贵州省遵义市仁怀市国际商贸中心酒包材市场2栋1楼111-118号",
  // 仁怀国际商贸中心公开地图中心点；正式发布前需在微信真机确认门店落点。
  latitude: 27.783649,
  longitude: 106.395409,
  // 门店实景只展示管理员保存到云端的最新图片，避免云端数据返回前闪现旧内置图。
  storeImages: Object.freeze([]),
  wechatQrImages: Object.freeze([DEFAULT_WECHAT_QR_IMAGE]),
  // 保留单张别名，兼容已发布版本与旧分享/预览逻辑。
  wechatQrImage: DEFAULT_WECHAT_QR_IMAGE,
  phoneNumbers: Object.freeze([]),
});

module.exports = {
  CONTACT_DATA,
};
