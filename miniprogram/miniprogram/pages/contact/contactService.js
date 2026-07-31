const CONTACT_ADMIN_FUNCTION = "contactAdmin";

function normalizeFunctionResult(response) {
  const result = (response && response.result) || {};
  if (result.ok === false) {
    const error = new Error(result.message || "联系信息读取失败");
    error.code = result.code || "CONTACT_PUBLIC_ERROR";
    throw error;
  }
  return result;
}

function normalizeStoreImages(value) {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((image) => typeof image === "string" && image.trim())
    .map((image) => image.trim())
    .slice(0, 9);
}

function normalizeWechatQrImages(value, legacyValue) {
  const hasArrayValue = Array.isArray(value);
  if (!hasArrayValue && typeof legacyValue !== "string") return undefined;
  const source = hasArrayValue ? value : [legacyValue];
  return source
    .filter((image) => typeof image === "string" && image.trim())
    .map((image) => image.trim())
    .slice(0, 2);
}

function normalizePhoneNumbers(value) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((phone) => {
      if (typeof phone === "string") {
        const displayNumber = phone.trim();
        return {
          displayNumber,
          dialNumber: displayNumber.replace(/[^\d+]/g, ""),
        };
      }
      if (!phone || typeof phone !== "object") return null;
      const displayNumber =
        typeof phone.displayNumber === "string" ? phone.displayNumber.trim() : "";
      const dialNumber =
        typeof phone.dialNumber === "string" ? phone.dialNumber.trim() : "";
      if (!displayNumber || !dialNumber) return null;
      return { displayNumber, dialNumber };
    })
    .filter((phone) => phone && phone.displayNumber && phone.dialNumber)
    .slice(0, 2);
}

async function fetchPublicContact() {
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }

  const response = await wx.cloud.callFunction({
    name: CONTACT_ADMIN_FUNCTION,
    data: {
      action: "getPublicContact",
    },
  });
  const result = normalizeFunctionResult(response);
  const config =
    result.config || result.contact || result.settings || result.data || result;
  const storeImages = normalizeStoreImages(
    config.storeImages || config.storeImageUrls
  );
  const qrArrayValue = Array.isArray(config.wechatQrImages)
    ? config.wechatQrImages
    : config.wechatQrImageUrls;
  const legacyWechatQrImage =
    config.wechatQrImage || config.wechatQrImageUrl;
  const wechatQrImages = normalizeWechatQrImages(
    qrArrayValue,
    legacyWechatQrImage
  );
  const wechatQrImage =
    (wechatQrImages && wechatQrImages[0]) ||
    (typeof legacyWechatQrImage === "string"
      ? legacyWechatQrImage.trim()
      : "");
  const phoneNumbers = normalizePhoneNumbers(config.phoneNumbers);

  return {
    isAdmin: Boolean(result.isAdmin),
    storeImages,
    wechatQrImages,
    wechatQrImage,
    phoneNumbers,
  };
}

module.exports = {
  fetchPublicContact,
  normalizePhoneNumbers,
  normalizeStoreImages,
  normalizeWechatQrImages,
};
