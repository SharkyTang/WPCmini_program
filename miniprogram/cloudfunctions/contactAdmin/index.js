const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const CONTACT_COLLECTION = "contact_settings";
const CONTACT_DOCUMENT_ID = "current";
const STORE_IMAGE_LIMIT = 4;
const PHONE_LIMIT = 2;
const PHONE_DISPLAY_MAX_LENGTH = 32;
const PHONE_DIGIT_MIN_LENGTH = 5;
const PHONE_DIGIT_MAX_LENGTH = 20;
const STORE_FILE_PREFIX = "contact-assets/store/";
const WECHAT_FILE_PREFIX = "contact-assets/wechat/";

function ok(data = {}) {
  return {
    ok: true,
    ...data,
  };
}

function fail(code, message, data = {}) {
  return {
    ok: false,
    code,
    message,
    ...data,
  };
}

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getAdminOpenids() {
  const contactAdmins = trimText(process.env.CONTACT_ADMIN_OPENIDS);
  const configuredAdmins = contactAdmins || trimText(process.env.ADMIN_OPENIDS);
  return configuredAdmins
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAdmin(openid) {
  return Boolean(openid && getAdminOpenids().includes(openid));
}

function getCloudFilePath(fileID) {
  const match = /^cloud:\/\/[^/]+\/(.+)$/.exec(trimText(fileID));
  if (!match) return "";
  const filePath = match[1];
  if (
    !filePath
    || filePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return "";
  }
  return filePath;
}

function isFileUnderPrefix(fileID, prefix) {
  const filePath = getCloudFilePath(fileID);
  return Boolean(filePath && filePath.startsWith(prefix) && filePath.length > prefix.length);
}

function isStoreImageFileId(fileID) {
  return isFileUnderPrefix(fileID, STORE_FILE_PREFIX);
}

function isWechatQrFileId(fileID) {
  return isFileUnderPrefix(fileID, WECHAT_FILE_PREFIX);
}

function normalizeUniqueFileIds(values, validator, limit) {
  if (!Array.isArray(values)) return [];
  const result = [];
  const seen = new Set();
  values.forEach((value) => {
    const fileID = trimText(
      value && typeof value === "object" ? value.fileID || value.fileId : value
    );
    if (!validator(fileID) || seen.has(fileID) || result.length >= limit) return;
    seen.add(fileID);
    result.push(fileID);
  });
  return result;
}

function normalizePhoneNumber(value) {
  const displayNumber = trimText(
    value && typeof value === "object"
      ? value.displayNumber || value.phoneNumber || value.number
      : value
  );

  if (!displayNumber) {
    return fail("INVALID_PHONE", "联系电话不能为空");
  }
  if (displayNumber.length > PHONE_DISPLAY_MAX_LENGTH) {
    return fail("INVALID_PHONE", "联系电话最多 32 个字符");
  }
  if (!/^[0-9+\-()（） ]+$/.test(displayNumber)) {
    return fail("INVALID_PHONE", "联系电话包含不支持的字符");
  }
  if (
    displayNumber.includes("+")
    && (
      displayNumber.indexOf("+") !== 0
      || displayNumber.lastIndexOf("+") !== 0
    )
  ) {
    return fail("INVALID_PHONE", "加号只能出现在联系电话开头");
  }

  const dialNumber = displayNumber
    .replace(/[ \-()（）]/g, "");
  if (!/^\+?\d+$/.test(dialNumber)) {
    return fail("INVALID_PHONE", "联系电话格式不正确");
  }
  const digitCount = dialNumber.replace("+", "").length;
  if (
    digitCount < PHONE_DIGIT_MIN_LENGTH
    || digitCount > PHONE_DIGIT_MAX_LENGTH
  ) {
    return fail("INVALID_PHONE", "联系电话需包含 5 至 20 位数字");
  }

  return ok({
    phoneNumber: {
      displayNumber,
      dialNumber,
    },
  });
}

function normalizePhoneNumbers(values, options = {}) {
  if (!Array.isArray(values)) {
    return options.strict
      ? fail("INVALID_PHONES", "联系电话必须是数组")
      : ok({ phoneNumbers: [] });
  }
  if (options.strict && values.length > PHONE_LIMIT) {
    return fail("INVALID_PHONES", "最多可设置两个联系电话");
  }

  const phoneNumbers = [];
  const seen = new Set();
  for (const value of values.slice(0, PHONE_LIMIT)) {
    const normalized = normalizePhoneNumber(value);
    if (!normalized.ok) {
      if (options.strict) return normalized;
      continue;
    }
    if (seen.has(normalized.phoneNumber.dialNumber)) {
      if (options.strict) {
        return fail("DUPLICATE_PHONE", "两个联系电话不能重复");
      }
      continue;
    }
    seen.add(normalized.phoneNumber.dialNumber);
    phoneNumbers.push(normalized.phoneNumber);
  }
  return ok({ phoneNumbers });
}

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function normalizeStoredContact(item = {}) {
  const phoneResult = normalizePhoneNumbers(item.phoneNumbers || []);
  return {
    storeImageFileIds: normalizeUniqueFileIds(
      item.storeImageFileIds || item.storeImages || [],
      isStoreImageFileId,
      STORE_IMAGE_LIMIT
    ),
    wechatQrFileId: isWechatQrFileId(
      trimText(item.wechatQrFileId || (item.wechatQr && item.wechatQr.fileID))
    )
      ? trimText(item.wechatQrFileId || item.wechatQr.fileID)
      : "",
    phoneNumbers: phoneResult.phoneNumbers || [],
    revision: normalizeRevision(item.revision),
  };
}

function validateContactConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    return fail("INVALID_CONFIG", "联系信息格式不正确");
  }

  const rawStoreImages = rawConfig.storeImageFileIds !== undefined
    ? rawConfig.storeImageFileIds
    : rawConfig.storeImages;
  if (!Array.isArray(rawStoreImages || [])) {
    return fail("INVALID_STORE_IMAGES", "门店图片必须是数组");
  }
  if ((rawStoreImages || []).length > STORE_IMAGE_LIMIT) {
    return fail("INVALID_STORE_IMAGES", "门店图片最多四张");
  }

  const storeImageFileIds = [];
  const storeImageSet = new Set();
  for (const value of rawStoreImages || []) {
    const fileID = trimText(
      value && typeof value === "object" ? value.fileID || value.fileId : value
    );
    if (!isStoreImageFileId(fileID)) {
      return fail("INVALID_STORE_IMAGE", "门店图片必须来自指定的联系素材目录");
    }
    if (storeImageSet.has(fileID)) {
      return fail("DUPLICATE_STORE_IMAGE", "门店图片不能重复");
    }
    storeImageSet.add(fileID);
    storeImageFileIds.push(fileID);
  }

  const rawWechatQr = rawConfig.wechatQrFileId !== undefined
    ? rawConfig.wechatQrFileId
    : rawConfig.wechatQr && typeof rawConfig.wechatQr === "object"
      ? rawConfig.wechatQr.fileID || rawConfig.wechatQr.fileId
      : rawConfig.wechatQrImageFileId;
  const wechatQrFileId = trimText(rawWechatQr);
  if (wechatQrFileId && !isWechatQrFileId(wechatQrFileId)) {
    return fail("INVALID_WECHAT_QR", "微信二维码必须来自指定的联系素材目录");
  }

  const phoneResult = normalizePhoneNumbers(rawConfig.phoneNumbers || [], {
    strict: true,
  });
  if (!phoneResult.ok) return phoneResult;

  return ok({
    config: {
      storeImageFileIds,
      wechatQrFileId,
      phoneNumbers: phoneResult.phoneNumbers,
    },
  });
}

function isDocumentNotFound(error) {
  const code = error && (error.errCode || error.code);
  const message = error && error.message;
  return (
    code === -502005
    || code === "DATABASE_DOCUMENT_NOT_EXIST"
    || /document.*not found|does not exist/i.test(message || "")
  );
}

async function getContactDocument(database = db) {
  try {
    const response = await database
      .collection(CONTACT_COLLECTION)
      .doc(CONTACT_DOCUMENT_ID)
      .get();
    return response.data || null;
  } catch (error) {
    if (isDocumentNotFound(error)) return null;
    throw error;
  }
}

async function resolveTempFileUrls(fileIDs) {
  const uniqueFileIds = Array.from(new Set((fileIDs || []).filter(Boolean)));
  if (!uniqueFileIds.length) return {};
  const response = await cloud.getTempFileURL({
    fileList: uniqueFileIds,
  });
  return (response.fileList || []).reduce((urls, item) => {
    if (item && item.fileID && item.tempFileURL) {
      urls[item.fileID] = item.tempFileURL;
    }
    return urls;
  }, {});
}

async function buildPublicConfig(item) {
  const contact = normalizeStoredContact(item || {});
  const urls = await resolveTempFileUrls([
    ...contact.storeImageFileIds,
    contact.wechatQrFileId,
  ]);
  const storeImages = contact.storeImageFileIds
    .map((fileID) => urls[fileID])
    .filter(Boolean);
  const wechatQrImage = urls[contact.wechatQrFileId] || "";
  return {
    storeImages,
    storeImageUrls: storeImages,
    wechatQrImage,
    wechatQrImageUrl: wechatQrImage,
    phoneNumbers: contact.phoneNumbers,
    revision: contact.revision,
  };
}

async function buildDraftItem(item) {
  const contact = normalizeStoredContact(item || {});
  const urls = await resolveTempFileUrls([
    ...contact.storeImageFileIds,
    contact.wechatQrFileId,
  ]);
  const storeImages = contact.storeImageFileIds.map((fileID) => ({
    fileID,
    url: urls[fileID] || "",
  }));
  const wechatQr = contact.wechatQrFileId
    ? {
        fileID: contact.wechatQrFileId,
        url: urls[contact.wechatQrFileId] || "",
      }
    : {
        fileID: "",
        url: "",
      };

  return {
    storeImages,
    storeImageFileIds: contact.storeImageFileIds,
    storeImageUrls: storeImages.map((item) => item.url),
    wechatQr,
    wechatQrFileId: wechatQr.fileID,
    wechatQrImageUrl: wechatQr.url,
    phoneNumbers: contact.phoneNumbers,
    revision: contact.revision,
  };
}

function getReferencedFileIdSet(item) {
  const contact = normalizeStoredContact(item || {});
  return new Set([
    ...contact.storeImageFileIds,
    contact.wechatQrFileId,
  ].filter(Boolean));
}

function normalizeCleanupCandidates(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map(trimText).filter((fileID) => (
    isStoreImageFileId(fileID) || isWechatQrFileId(fileID)
  ))));
}

async function deleteUnreferencedContactFiles(fileIDs) {
  const deletedFileIds = [];
  for (const fileID of normalizeCleanupCandidates(fileIDs)) {
    const latest = await getContactDocument();
    if (getReferencedFileIdSet(latest).has(fileID)) continue;
    try {
      await cloud.deleteFile({
        fileList: [fileID],
      });
      deletedFileIds.push(fileID);
    } catch (error) {
      console.warn("contact asset delete failed", error);
    }
  }
  return deletedFileIds;
}

async function getPublicContact(admin) {
  const item = await getContactDocument();
  const config = await buildPublicConfig(item);
  return ok({
    config,
    isAdmin: admin,
  });
}

async function getContactDraft() {
  const item = await getContactDocument();
  const draft = await buildDraftItem(item);
  return ok({
    item: draft,
    ...draft,
  });
}

function getExpectedRevision(event) {
  const value = event.expectedRevision !== undefined
    ? event.expectedRevision
    : event.revision;
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : null;
}

function createRevisionConflict(currentRevision) {
  const error = new Error("联系信息已被其他管理员更新，请刷新后重试");
  error.contactCode = "REVISION_CONFLICT";
  error.currentRevision = currentRevision;
  return error;
}

async function saveContact(event, openid) {
  const validation = validateContactConfig(event.contact || event.config);
  if (!validation.ok) return validation;
  const expectedRevision = getExpectedRevision(event);
  if (expectedRevision === null) {
    return fail("INVALID_REVISION", "缺少有效的联系信息版本号");
  }

  let previousContact = null;
  let savedContact = null;
  let conflictCurrentRevision = null;
  try {
    await db.runTransaction(async (transaction) => {
      const document = transaction
        .collection(CONTACT_COLLECTION)
        .doc(CONTACT_DOCUMENT_ID);
      let existing = null;
      try {
        const response = await document.get();
        existing = response.data || null;
      } catch (error) {
        if (!isDocumentNotFound(error)) throw error;
      }

      previousContact = normalizeStoredContact(existing || {});
      if (previousContact.revision !== expectedRevision) {
        conflictCurrentRevision = previousContact.revision;
        throw createRevisionConflict(previousContact.revision);
      }

      savedContact = {
        ...validation.config,
        revision: expectedRevision + 1,
        updatedAt: db.serverDate(),
        updatedByOpenid: openid,
      };
      await document.set({
        data: savedContact,
      });
    });
  } catch (error) {
    if (
      conflictCurrentRevision !== null
      || (error && error.contactCode === "REVISION_CONFLICT")
    ) {
      const currentRevision = conflictCurrentRevision !== null
        ? conflictCurrentRevision
        : error.currentRevision;
      return fail(
        "REVISION_CONFLICT",
        "联系信息已被其他管理员更新，请刷新后重试",
        {
          currentRevision,
        }
      );
    }
    throw error;
  }

  const currentFileIds = getReferencedFileIdSet(savedContact);
  const replacedFileIds = Array.from(getReferencedFileIdSet(previousContact))
    .filter((fileID) => !currentFileIds.has(fileID));
  const deletedFileIds = await deleteUnreferencedContactFiles(replacedFileIds);

  return ok({
    revision: savedContact.revision,
    config: {
      storeImageFileIds: savedContact.storeImageFileIds,
      wechatQrFileId: savedContact.wechatQrFileId,
      phoneNumbers: savedContact.phoneNumbers,
      revision: savedContact.revision,
    },
    deletedFileIds,
  });
}

async function cleanupUnreferencedFiles(event) {
  const fileIDs = normalizeCleanupCandidates(event.fileIDs || event.fileIds || []);
  if (!fileIDs.length) {
    return ok({
      deletedFileIds: [],
    });
  }
  const deletedFileIds = await deleteUnreferencedContactFiles(fileIDs);
  return ok({
    deletedFileIds,
  });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const action = trimText(event.action);
  const admin = isAdmin(OPENID);

  try {
    if (action === "getPublicContact") {
      return await getPublicContact(admin);
    }
    if (action === "checkAccess") {
      return ok({
        isAdmin: admin,
      });
    }
    if (!admin) {
      return fail("FORBIDDEN", "无权限管理联系信息");
    }
    if (action === "getContactDraft") {
      return await getContactDraft();
    }
    if (action === "saveContact") {
      return await saveContact(event, OPENID);
    }
    if (action === "cleanupUnreferencedFiles") {
      return await cleanupUnreferencedFiles(event);
    }
    return fail("UNKNOWN_ACTION", "未知联系信息管理操作");
  } catch (error) {
    console.error("contactAdmin error", error);
    return fail("SERVER_ERROR", error.message || "联系信息服务异常");
  }
};
