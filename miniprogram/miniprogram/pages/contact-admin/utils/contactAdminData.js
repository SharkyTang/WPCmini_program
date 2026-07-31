const CONTACT_STORE_IMAGE_MAX = 4;
const CONTACT_PHONE_MAX = 2;
const CONTACT_PHONE_TEXT_MAX_LENGTH = 32;
const CONTACT_PHONE_DIGITS_MIN = 5;
const CONTACT_PHONE_DIGITS_MAX = 20;
const STORE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const QR_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isCloudFileId(value) {
  return trimText(value).indexOf("cloud://") === 0;
}

function buildDialPhoneNumber(value) {
  const text = trimText(value);
  const prefix = text.indexOf("+") === 0 ? "+" : "";
  return `${prefix}${text.replace(/\D/g, "")}`;
}

function validatePhoneNumbers(values = []) {
  const source = Array.isArray(values) ? values.slice(0, CONTACT_PHONE_MAX) : [];
  while (source.length < CONTACT_PHONE_MAX) source.push("");

  const phoneNumbers = source.map(trimText);
  const nonEmptyPhones = phoneNumbers.filter(Boolean);
  const dialNumbers = [];

  for (let index = 0; index < nonEmptyPhones.length; index += 1) {
    const phone = nonEmptyPhones[index];
    if (phone.length > CONTACT_PHONE_TEXT_MAX_LENGTH) {
      return {
        valid: false,
        message: `联系电话最多 ${CONTACT_PHONE_TEXT_MAX_LENGTH} 个字符`,
      };
    }
    if (!/^[+\d\s\-()（）]+$/.test(phone) || phone.slice(1).includes("+")) {
      return {
        valid: false,
        message: "联系电话只能包含数字、空格、+、- 和括号，+ 只能放在开头",
      };
    }
    const dialNumber = buildDialPhoneNumber(phone);
    const digitCount = dialNumber.replace(/\D/g, "").length;
    if (
      digitCount < CONTACT_PHONE_DIGITS_MIN ||
      digitCount > CONTACT_PHONE_DIGITS_MAX
    ) {
      return {
        valid: false,
        message: `联系电话需包含 ${CONTACT_PHONE_DIGITS_MIN}-${CONTACT_PHONE_DIGITS_MAX} 位数字`,
      };
    }
    if (dialNumbers.includes(dialNumber)) {
      return {
        valid: false,
        message: "两个联系电话不能重复",
      };
    }
    dialNumbers.push(dialNumber);
  }

  return {
    valid: true,
    phoneNumbers: nonEmptyPhones,
    dialNumbers,
  };
}

function normalizeRemoteImage(fileID, url, index, kind) {
  const safeFileID = trimText(fileID);
  if (!safeFileID) return null;
  return {
    key: `${kind}-remote-${index}`,
    fileID: safeFileID,
    url: trimText(url) || safeFileID,
    localPath: "",
    isPending: false,
  };
}

function normalizePhoneDisplay(value) {
  if (typeof value === "string") return trimText(value);
  if (!value || typeof value !== "object") return "";
  return trimText(
    value.displayNumber || value.phoneNumber || value.number
  );
}

function normalizeContactAdminDraft(result = {}) {
  const item = result.item || result.contact || result.settings || result.draft || {};
  const imageItems = Array.isArray(item.storeImages) ? item.storeImages : [];
  const fileIDs = Array.isArray(item.storeImageFileIds)
    ? item.storeImageFileIds
    : imageItems.map((image) => image && image.fileID);
  const imageUrls = Array.isArray(item.storeImageUrls)
    ? item.storeImageUrls
    : imageItems.map((image) => image && (image.url || image.tempFileURL));
  const storeImages = fileIDs
    .slice(0, CONTACT_STORE_IMAGE_MAX)
    .map((fileID, index) =>
      normalizeRemoteImage(fileID, imageUrls[index], index, "store")
    )
    .filter(Boolean);

  const qrSource = item.wechatQr || {};
  const wechatQrFileId =
    item.wechatQrFileId || item.wechatQrFileID || qrSource.fileID || "";
  const wechatQrUrl =
    item.wechatQrUrl ||
    item.wechatQrImageUrl ||
    qrSource.url ||
    qrSource.tempFileURL ||
    "";

  const phoneNumbers = Array.isArray(item.phoneNumbers)
    ? item.phoneNumbers
        .slice(0, CONTACT_PHONE_MAX)
        .map(normalizePhoneDisplay)
    : [];
  while (phoneNumbers.length < CONTACT_PHONE_MAX) phoneNumbers.push("");

  return {
    storeImages,
    wechatQr: normalizeRemoteImage(
      wechatQrFileId,
      wechatQrUrl,
      0,
      "wechat"
    ),
    phoneNumbers,
    revision:
      item.revision === undefined || item.revision === null
        ? 0
        : item.revision,
  };
}

function extensionFromPath(filePath) {
  const cleanPath = trimText(filePath).split("?")[0].toLowerCase();
  const match = /\.([a-z0-9]+)$/.exec(cleanPath);
  const extension = match && match[1];
  return ["jpg", "jpeg", "png", "webp"].includes(extension)
    ? extension
    : "jpg";
}

function buildContactAssetCloudPath(kind, filePath, nonce = "") {
  const folder = kind === "wechat" ? "wechat" : "store";
  const suffix = trimText(nonce).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  const uniquePart = suffix || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `contact-assets/${folder}/${uniquePart}.${extensionFromPath(filePath)}`;
}

function extractMediaFiles(result = {}, maxCount, maxBytes) {
  return (Array.isArray(result.tempFiles) ? result.tempFiles : [])
    .map((file) => ({
      filePath: trimText(file && (file.tempFilePath || file.path)),
      size: Number(file && file.size) || 0,
    }))
    .filter((file) => file.filePath)
    .slice(0, maxCount)
    .map((file) => ({
      ...file,
      oversized: file.size > maxBytes,
    }));
}

module.exports = {
  CONTACT_PHONE_MAX,
  CONTACT_PHONE_TEXT_MAX_LENGTH,
  CONTACT_STORE_IMAGE_MAX,
  QR_IMAGE_MAX_BYTES,
  STORE_IMAGE_MAX_BYTES,
  buildContactAssetCloudPath,
  buildDialPhoneNumber,
  extractMediaFiles,
  isCloudFileId,
  normalizeContactAdminDraft,
  validatePhoneNumbers,
};
