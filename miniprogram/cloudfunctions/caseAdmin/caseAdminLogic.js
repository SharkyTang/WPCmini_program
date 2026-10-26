const crypto = require("node:crypto");

const CASE_COLLECTION = "wine_packaging";
const BANNER_COLLECTION = "home_banners";
const CASE_ADMIN_DEFAULT_SORT_ORDER = 9999;
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;
const SEARCH_FETCH_LIMIT = 300;
const CASE_SCAN_BATCH_SIZE = 100;
const IMAGE_URL_BATCH_SIZE = 50;
const CASE_GALLERY_MAX = 9;
const HTTPS_MEDIA_URL_MAX_LENGTH = 2048;
const VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
const VIDEO_DURATION_SECONDS_MAX = 120;
const VIDEO_POSTER_UPLOAD_BYTES = 5 * 1024 * 1024;
const VIDEO_UPLOAD_PREFIX = "wine-packaging/videos";
const CASE_BATCH_MAX = 50;
const PINNED_CASE_LIMIT = 20;
const CASE_ID_PREFIX = "case_";
const CASE_ID_PAD_LENGTH = 3;
const CASE_ID_SEQUENCE_MAX = 999999;
const HOME_DISPLAY_LIMITS = {
  banner: 5,
  popular: 4,
  latest: 6,
};
const HOME_DISPLAY_LABELS = {
  banner: "首页轮播",
  popular: "热门产品",
  latest: "最新产品",
};
const SCENE_VALUES = [
  "婚宴",
  "百日/满月",
  "生日宴",
  "寿宴",
  "乔迁宴",
  "送礼",
  "商务招待",
  "节庆礼赠",
  "企业纪念",
  "商超陈列",
  "电商展示",
];
const SCENE_LABELS = {
  婚宴: "婚宴/喜宴",
};
const CASE_ADMIN_OPTIONS = {
  wineType: ["白酒"],
  packageTypes: ["整套包装", "瓶标", "瓶子", "礼盒", "桶盒", "卡盒", "手提袋", "外箱"],
  styles: ["轻奢", "国风", "新中式", "复古", "简约", "商务", "时尚", "喜庆"],
  priceLevel: ["基础款", "品质款", "高端款", "珍藏款"],
  scenes: SCENE_VALUES,
  statuses: ["热门产品", "最新产品"],
  homeSections: [
    { value: "banner", label: "首页轮播" },
    { value: "popular", label: "热门产品" },
    { value: "latest", label: "最新产品" },
  ],
};
const MULTI_TAG_FIELDS = ["packageTypes", "styles", "scenes", "statuses", "homeSections"];
const BATCH_TAG_FIELDS = [...MULTI_TAG_FIELDS, "priceLevel"];
const BATCH_PATCH_FIELDS = [
  "wineType",
  "packageTypes",
  "styles",
  "priceLevel",
  "scenes",
  "statuses",
  "homeSections",
  "isVisible",
  "isPinned",
];
const LIST_SORT_FIELDS = ["sortOrder", "updatedAt", "createdAt", "caseId", "title"];
const WEB_UPLOAD_PREFIX = "wine-packaging/admin-web";
const CASE_IMAGE_ARRAY_FIELDS = [
  "galleryImages",
  "sourceGalleryImages",
  "galleryThumbnails",
  "galleryBanners",
];
const CASE_IMAGE_SCALAR_FIELDS = [
  "coverImage",
  "coverThumbnail",
  "coverBanner",
  "imageVariantVersion",
];
const VALID_CASE_ADMIN_ACTIONS = [
  "checkAccess",
  "getAdminConfig",
  "listCases",
  "listCasesV2",
  "listRecentCases",
  "getCase",
  "getCaseImageUrls",
  "prepareVideoUpload",
  "getVisibleImageUrls",
  "listHomepageDisplay",
  "createCase",
  "updateCase",
  "batchPatchCases",
  "moveCasesToTrash",
  "restoreCases",
  "reorderCases",
  "setHomeSectionOrder",
  "setCaseVisibility",
  "deleteCase",
  "cleanupUnreferencedFiles",
  "permanentlyDeleteCases",
  "retryPurgeCleanup",
  "listPendingPurgeJobs",
];

const ALLOWED_CASE_FIELDS = [
  "title",
  "caseId",
  "coverImage",
  "coverThumbnail",
  "coverBanner",
  "galleryImages",
  "sourceGalleryImages",
  "galleryThumbnails",
  "galleryBanners",
  "imageVariantVersion",
  "wineType",
  "packageTypes",
  "styles",
  "priceLevel",
  "scenes",
  "statuses",
  "homeSections",
  "homeSectionOrder",
  "sortOrder",
  "notes",
  "isVisible",
  "isPinned",
];

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHttpsMediaUrl(value) {
  const url = trimText(value);
  if (!url || url.length > HTTPS_MEDIA_URL_MAX_LENGTH || /\s/.test(url)) return "";
  const match = /^https:\/\/(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?(?:[/?#].*)?$/i.exec(url);
  if (!match) return "";
  const port = match[2] ? Number(match[2]) : 443;
  return port > 0 && port <= 65535 ? url : "";
}

function sanitizeOptionalHttpsMediaUrl(value, fieldLabel) {
  const rawValue = trimText(value);
  if (!rawValue) return { valid: true, value: "" };
  const normalizedValue = normalizeHttpsMediaUrl(rawValue);
  return normalizedValue
    ? { valid: true, value: normalizedValue }
    : {
      valid: false,
      code: "INVALID_VIDEO_URL",
      message: `${fieldLabel}必须是有效的 HTTPS 链接`,
    };
}

function sanitizeVideoDuration(value, options = {}) {
  const required = options.required === true;
  if (value === "" || value === null || value === undefined) {
    return required
      ? {
        valid: false,
        code: "INVALID_VIDEO_DURATION",
        message: `视频时长必须大于 0 且不超过 ${VIDEO_DURATION_SECONDS_MAX} 秒`,
      }
      : { valid: true, value: null };
  }
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0 || duration > VIDEO_DURATION_SECONDS_MAX) {
    return {
      valid: false,
      code: "INVALID_VIDEO_DURATION",
      message: `视频时长必须大于 0 且不超过 ${VIDEO_DURATION_SECONDS_MAX} 秒`,
    };
  }
  return { valid: true, value: Math.ceil(duration) };
}

function sanitizeVideoPatch(value) {
  if (value === undefined) return { valid: true, omitted: true, data: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, code: "INVALID_VIDEO_PATCH", message: "视频修改数据格式无效" };
  }
  const mode = trimText(value.mode).toLowerCase();
  if (mode === "clear") {
    return {
      valid: true,
      omitted: false,
      mode,
      data: {
        videoFileID: "",
        videoUrl: "",
        videoPosterFileID: "",
        videoPoster: "",
        videoDurationSeconds: null,
        videoFileSizeBytes: null,
      },
      fileIDs: [],
    };
  }
  if (mode === "external") {
    const urlResult = sanitizeOptionalHttpsMediaUrl(value.url, "视频地址");
    if (!urlResult.valid || !urlResult.value) {
      return urlResult.valid
        ? { valid: false, code: "VIDEO_URL_REQUIRED", message: "请填写视频 HTTPS 地址" }
        : urlResult;
    }
    const posterResult = sanitizeOptionalHttpsMediaUrl(value.posterUrl, "视频封面地址");
    if (!posterResult.valid) return posterResult;
    const durationResult = sanitizeVideoDuration(value.durationSeconds);
    if (!durationResult.valid) return durationResult;
    return {
      valid: true,
      omitted: false,
      mode,
      data: {
        videoFileID: "",
        videoUrl: urlResult.value,
        videoPosterFileID: "",
        videoPoster: posterResult.value,
        videoDurationSeconds: durationResult.value,
        videoFileSizeBytes: null,
      },
      fileIDs: [],
    };
  }
  if (mode === "upload") {
    const fileID = trimText(value.fileID);
    const posterFileID = trimText(value.posterFileID);
    if (!isCloudFileId(fileID)) {
      return { valid: false, code: "INVALID_VIDEO_FILE", message: "视频文件需要先上传到云存储" };
    }
    if (posterFileID && !isCloudFileId(posterFileID)) {
      return { valid: false, code: "INVALID_VIDEO_POSTER", message: "视频封面需要先上传到云存储" };
    }
    const durationResult = sanitizeVideoDuration(value.durationSeconds, { required: true });
    if (!durationResult.valid) return durationResult;
    return {
      valid: true,
      omitted: false,
      mode,
      data: {
        videoFileID: fileID,
        videoUrl: "",
        videoPosterFileID: posterFileID,
        videoPoster: "",
        videoDurationSeconds: durationResult.value,
        videoFileSizeBytes: null,
      },
      fileIDs: posterFileID ? [fileID, posterFileID] : [fileID],
    };
  }
  return {
    valid: false,
    code: "INVALID_VIDEO_PATCH",
    message: "视频修改模式必须是 upload、external 或 clear",
  };
}

function getSceneLabel(value) {
  const normalizedValue = trimText(value);
  return SCENE_LABELS[normalizedValue] || normalizedValue;
}

function getAdminOpenidsFromEnv(value) {
  return trimText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAdminOpenid(openid, envValue) {
  return Boolean(openid && getAdminOpenidsFromEnv(envValue).includes(openid));
}

function getRoleAdminOpenidsEnv(roleValue, fallbackValue) {
  return trimText(roleValue) || trimText(fallbackValue);
}

function isRoleAdminOpenid(openid, roleValue, fallbackValue) {
  return isAdminOpenid(openid, getRoleAdminOpenidsEnv(roleValue, fallbackValue));
}

function getEnvList(value) {
  return getAdminOpenidsFromEnv(value);
}

function parseCloudbaseContext(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function firstIdentityValue(source = {}, keys = []) {
  for (const key of keys) {
    const value = trimText(source && source[key]);
    if (value) return value;
  }
  return "";
}

/**
 * Resolve only identities asserted by the CloudBase runtime. Event payload fields
 * are intentionally never accepted here because callers can spoof them.
 */
function resolveAdminActor(context = {}, env = {}) {
  const runtimeContext = parseCloudbaseContext(env.TCB_CONTEXT_CNFG);
  const openid =
    firstIdentityValue(context, ["OPENID", "openid"]) ||
    firstIdentityValue(runtimeContext, ["OPENID", "openid"]);
  if (openid) {
    return {
      authenticated: true,
      actor: { type: "wechat_openid", id: openid },
    };
  }

  const uidKeys = [
    "UID",
    "uid",
    "UUID",
    "uuid",
    "TCB_UUID",
    "CLOUDBASE_UID",
    "CLOUDBASE_USER_ID",
    "USER_ID",
  ];
  const uid =
    firstIdentityValue(context, uidKeys) ||
    firstIdentityValue(runtimeContext, uidKeys) ||
    firstIdentityValue(env, ["TCB_UUID", "CLOUDBASE_UID", "CLOUDBASE_USER_ID"]);
  if (uid) {
    return {
      authenticated: true,
      actor: { type: "cloudbase_uid", id: uid },
    };
  }
  return { authenticated: false, actor: null };
}

function isAdminActor(actor, env = {}) {
  if (!actor || !trimText(actor.id)) return false;
  if (actor.type === "wechat_openid") {
    return isRoleAdminOpenid(
      actor.id,
      env.CASE_ADMIN_OPENIDS,
      env.ADMIN_OPENIDS
    );
  }
  if (actor.type === "cloudbase_uid") {
    return getEnvList(env.CASE_ADMIN_UIDS).includes(actor.id);
  }
  return false;
}

function isWebWriteEnabled(value) {
  return ["1", "true", "yes", "on"].includes(trimText(value).toLowerCase());
}

function parseAdminDisplayNames(value) {
  const rawValue = typeof value === "string" && value.startsWith("json:")
    ? value.slice(5)
    : value;
  const parsed = parseCloudbaseContext(rawValue);
  return Object.keys(parsed).reduce((result, uid) => {
    const normalizedUid = trimText(uid);
    const displayName = trimText(parsed[uid]);
    if (normalizedUid && displayName) result[normalizedUid] = displayName.slice(0, 40);
    return result;
  }, {});
}

function getAdminDisplayName(actor, env = {}) {
  if (!actor || !trimText(actor.id)) return "管理员";
  const configured = parseAdminDisplayNames(env.CASE_ADMIN_DISPLAY_NAMES);
  if (configured[actor.id]) return configured[actor.id];
  return actor.type === "cloudbase_uid" ? "网页管理员" : "微信管理员";
}

function normalizeValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value.values)) return value.values.filter(Boolean);
  if (typeof value === "string") return value ? [value] : [];
  return [];
}

function uniqueValues(values = []) {
  const seen = new Set();
  return values
    .map(trimText)
    .filter(Boolean)
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function valuesObject(value) {
  return {
    values: uniqueValues(normalizeValues(value)),
  };
}

function isCloudFileId(value) {
  return trimText(value).startsWith("cloud://");
}

function normalizeCloudFileIds(value = [], limit = IMAGE_URL_BATCH_SIZE) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map(trimText)
    .filter(isCloudFileId)
    .filter((fileID) => {
      if (seen.has(fileID)) return false;
      seen.add(fileID);
      return true;
    })
    .slice(0, limit);
}

function normalizeGalleryImages(value) {
  const rawImages = normalizeValues(value).map(trimText).filter(Boolean);
  if (rawImages.length > CASE_GALLERY_MAX) {
    return {
      valid: false,
      code: "TOO_MANY_IMAGES",
      message: `一个案例最多上传 ${CASE_GALLERY_MAX} 张图片`,
    };
  }
  if (rawImages.some((fileID) => !isCloudFileId(fileID))) {
    return { valid: false, code: "INVALID_GALLERY_IMAGE", message: "封面图片需要先上传到云存储" };
  }
  return { valid: true, images: uniqueValues(rawImages) };
}

function normalizeSortOrder(value) {
  if (value === "" || value === null || value === undefined) return CASE_ADMIN_DEFAULT_SORT_ORDER;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : CASE_ADMIN_DEFAULT_SORT_ORDER;
}

function hasUsableSortOrder(value) {
  if (value === "" || value === null || value === undefined) return false;
  return Number.isFinite(Number(value));
}

function normalizePage(value) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value) {
  const pageSize = Number(value);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return PAGE_SIZE_DEFAULT;
  return Math.min(Math.floor(pageSize), PAGE_SIZE_MAX);
}

function normalizeVisibilityFilter(value) {
  return ["visible", "hidden", "pinned"].includes(value) ? value : "all";
}

function normalizeHomepageDisplaySlot(value) {
  return Object.prototype.hasOwnProperty.call(HOME_DISPLAY_LIMITS, value) ? value : "";
}

function getHomepageDisplayLimit(slot) {
  return HOME_DISPLAY_LIMITS[normalizeHomepageDisplaySlot(slot)] || 0;
}

function normalizeHomeSectionOrder(value) {
  if (value === undefined || value === null) {
    return { valid: true, value: {} };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      valid: false,
      code: "INVALID_HOME_SECTION_ORDER",
      message: "首页展示顺序格式无效",
    };
  }
  const normalized = {};
  for (const slot of Object.keys(HOME_DISPLAY_LIMITS)) {
    if (!Object.prototype.hasOwnProperty.call(value, slot)) continue;
    const order = Number(value[slot]);
    if (!Number.isInteger(order) || order <= 0 || order > HOME_DISPLAY_LIMITS[slot]) {
      return {
        valid: false,
        code: "INVALID_HOME_SECTION_ORDER",
        message: `${HOME_DISPLAY_LABELS[slot]}顺序必须在 1-${HOME_DISPLAY_LIMITS[slot]} 之间`,
      };
    }
    normalized[slot] = order;
  }
  return { valid: true, value: normalized };
}

function getHomeSectionOrder(item = {}, slot) {
  const normalizedSlot = normalizeHomepageDisplaySlot(slot);
  if (!normalizedSlot) return 0;
  const value = item && item.homeSectionOrder && item.homeSectionOrder[normalizedSlot];
  const order = Number(value);
  return Number.isInteger(order) && order > 0 ? order : 0;
}

function getActiveHomepageSlots(item = {}) {
  if (!item || item.isVisible !== true) return [];
  return uniqueValues(normalizeValues(item.homeSections))
    .map(normalizeHomepageDisplaySlot)
    .filter(Boolean);
}

function getActivatedHomepageSlots(existing, nextItem = {}) {
  const previousSlots = new Set(getActiveHomepageSlots(existing));
  return getActiveHomepageSlots(nextItem).filter((slot) => !previousSlots.has(slot));
}

function generateCaseId(now = Date.now()) {
  return `${CASE_ID_PREFIX}${now}`;
}

function getCaseIdNumber(value) {
  const text = trimText(value);
  const match = new RegExp(`^${CASE_ID_PREFIX}(\\d+)$`).exec(text);
  if (!match) return 0;
  const numberValue = Number(match[1]);
  if (
    !Number.isInteger(numberValue) ||
    numberValue <= 0 ||
    numberValue > CASE_ID_SEQUENCE_MAX
  ) {
    return 0;
  }
  return numberValue;
}

function formatSequentialCaseId(numberValue) {
  return `${CASE_ID_PREFIX}${String(numberValue).padStart(CASE_ID_PAD_LENGTH, "0")}`;
}

function generateSequentialCaseId(items = []) {
  const maxNumber = items.reduce((max, item) => {
    return Math.max(max, getCaseIdNumber(item && item.caseId));
  }, 0);
  return formatSequentialCaseId(maxNumber + 1);
}

function getCreateSortOrder(value, caseId, options = {}) {
  if (hasUsableSortOrder(value)) return normalizeSortOrder(value);
  const caseNumber = getCaseIdNumber(caseId);
  if (caseNumber) return caseNumber;
  if (hasUsableSortOrder(options.defaultSortOrder)) {
    return normalizeSortOrder(options.defaultSortOrder);
  }
  return CASE_ADMIN_DEFAULT_SORT_ORDER;
}

function pickAllowedCaseFields(input = {}) {
  return ALLOWED_CASE_FIELDS.reduce((picked, field) => {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      picked[field] = input[field];
    }
    return picked;
  }, {});
}

function buildCaseKeywords(data = {}) {
  return {
    values: uniqueValues([
      data.title,
      data.caseId,
      data.wineType,
      ...normalizeValues(data.packageTypes),
      ...normalizeValues(data.styles),
      data.priceLevel,
      ...normalizeValues(data.scenes),
      ...normalizeValues(data.statuses),
    ]),
  };
}

function sanitizeCasePayload(input = {}, options = {}) {
  const picked = pickAllowedCaseFields(input);
  const data = {};
  const isCreate = options.isCreate === true;

  if (isCreate || Object.prototype.hasOwnProperty.call(picked, "title")) {
    data.title = trimText(picked.title);
    if (!data.title) return { valid: false, code: "INVALID_TITLE", message: "请填写案例标题" };
  }

  const hasGalleryInput = Object.prototype.hasOwnProperty.call(picked, "galleryImages");
  const hasCoverInput = Object.prototype.hasOwnProperty.call(picked, "coverImage");
  if (isCreate || hasGalleryInput || hasCoverInput) {
    const galleryResult = normalizeGalleryImages(
      hasGalleryInput ? picked.galleryImages : [picked.coverImage]
    );
    if (!galleryResult.valid) return galleryResult;
    if (!galleryResult.images.length) {
      return { valid: false, code: "INVALID_IMAGE", message: "请上传封面图片" };
    }
    data.galleryImages = galleryResult.images;
    // 服务端以首图为准，避免客户端传入的封面与图库顺序不一致。
    data.coverImage = galleryResult.images[0];
  }
  if (Object.prototype.hasOwnProperty.call(picked, "coverThumbnail")) {
    data.coverThumbnail = trimText(picked.coverThumbnail);
    if (data.coverThumbnail && !isCloudFileId(data.coverThumbnail)) {
      return { valid: false, code: "INVALID_THUMBNAIL", message: "缩略图需要先上传到云存储" };
    }
  }
  if (Object.prototype.hasOwnProperty.call(picked, "coverBanner")) {
    data.coverBanner = trimText(picked.coverBanner);
    if (data.coverBanner && !isCloudFileId(data.coverBanner)) {
      return { valid: false, code: "INVALID_BANNER", message: "Banner 图片需要先上传到云存储" };
    }
  }
  for (const field of ["sourceGalleryImages", "galleryThumbnails", "galleryBanners"]) {
    if (Object.prototype.hasOwnProperty.call(picked, field)) {
      const normalizedImages = normalizeGalleryImages(picked[field]);
      if (!normalizedImages.valid) return normalizedImages;
      data[field] = normalizedImages.images;
    }
  }
  if (data.galleryImages && data.sourceGalleryImages && data.sourceGalleryImages.length) {
    if (data.sourceGalleryImages.length !== data.galleryImages.length) {
      return {
        valid: false,
        code: "INCOMPLETE_IMAGE_VARIANTS",
        message: "原图与展示图数量不一致，请重新处理图片",
      };
    }
  }
  if (data.galleryImages && data.galleryThumbnails && data.galleryThumbnails.length) {
    if (data.galleryThumbnails.length !== data.galleryImages.length) {
      return {
        valid: false,
        code: "INCOMPLETE_IMAGE_VARIANTS",
        message: "缩略图与展示图数量不一致，请重新处理图片",
      };
    }
    const aliasedThumbnail = data.galleryThumbnails.some((fileID, index) => {
      return (
        fileID === data.galleryImages[index] ||
        (data.sourceGalleryImages && fileID === data.sourceGalleryImages[index])
      );
    });
    if (aliasedThumbnail) {
      return {
        valid: false,
        code: "INVALID_IMAGE_VARIANTS",
        message: "原图不能作为缩略图，请重新处理图片",
      };
    }
    data.coverThumbnail = data.galleryThumbnails[0];
  }
  if (data.galleryImages && data.galleryBanners && data.galleryBanners.length) {
    if (data.galleryBanners.length !== data.galleryImages.length) {
      return {
        valid: false,
        code: "INCOMPLETE_IMAGE_VARIANTS",
        message: "Banner 与展示图数量不一致，请重新处理图片",
      };
    }
    data.coverBanner = data.galleryBanners[0];
  }
  if (Object.prototype.hasOwnProperty.call(picked, "imageVariantVersion")) {
    const version = Number(picked.imageVariantVersion);
    data.imageVariantVersion = Number.isInteger(version) && version >= 0 ? version : 0;
  }

  if (isCreate || Object.prototype.hasOwnProperty.call(picked, "packageTypes")) {
    data.packageTypes = valuesObject(picked.packageTypes);
    const mayStayIncomplete =
      options.allowIncompleteHidden === true &&
      picked.isVisible !== true;
    if (!data.packageTypes.values.length && !mayStayIncomplete) {
      return { valid: false, code: "INVALID_PACKAGE_TYPES", message: "请选择包装内容" };
    }
  }

  if (Object.prototype.hasOwnProperty.call(picked, "caseId")) {
    data.caseId = trimText(picked.caseId);
  }
  if (isCreate && !data.caseId) {
    data.caseId = trimText(options.defaultCaseId) || generateCaseId(options.now);
  }
  if (isCreate && !data.caseId) {
    data.caseId = generateCaseId();
  }

  if (isCreate || Object.prototype.hasOwnProperty.call(picked, "wineType")) {
    data.wineType = trimText(picked.wineType) || "白酒";
  }
  if (Object.prototype.hasOwnProperty.call(picked, "styles")) {
    data.styles = valuesObject(picked.styles);
  } else if (isCreate) {
    data.styles = { values: [] };
  }
  if (Object.prototype.hasOwnProperty.call(picked, "priceLevel")) {
    data.priceLevel = trimText(picked.priceLevel);
  } else if (isCreate) {
    data.priceLevel = "";
  }
  if (Object.prototype.hasOwnProperty.call(picked, "scenes")) {
    data.scenes = valuesObject(picked.scenes);
  } else if (isCreate) {
    data.scenes = { values: [] };
  }
  if (Object.prototype.hasOwnProperty.call(picked, "statuses")) {
    data.statuses = valuesObject(picked.statuses);
  } else if (isCreate) {
    data.statuses = { values: [] };
  }
  if (Object.prototype.hasOwnProperty.call(picked, "homeSections")) {
    data.homeSections = valuesObject(picked.homeSections);
  } else if (isCreate) {
    data.homeSections = { values: [] };
  }
  if (Object.prototype.hasOwnProperty.call(picked, "homeSectionOrder")) {
    const orderResult = normalizeHomeSectionOrder(picked.homeSectionOrder);
    if (!orderResult.valid) return orderResult;
    data.homeSectionOrder = orderResult.value;
  } else if (isCreate) {
    data.homeSectionOrder = {};
  }
  if (Object.prototype.hasOwnProperty.call(picked, "sortOrder") || isCreate) {
    data.sortOrder = isCreate
      ? getCreateSortOrder(picked.sortOrder, data.caseId, options)
      : normalizeSortOrder(picked.sortOrder);
  }
  if (Object.prototype.hasOwnProperty.call(picked, "notes") || isCreate) {
    data.notes = trimText(picked.notes);
  }
  if (Object.prototype.hasOwnProperty.call(picked, "isVisible") || isCreate) {
    data.isVisible = picked.isVisible === true;
  }
  if (Object.prototype.hasOwnProperty.call(picked, "isPinned") || isCreate) {
    data.isPinned = picked.isPinned === true;
  }

  data.keywords = buildCaseKeywords(data);
  return { valid: true, data };
}

function buildCaseSearchText(item = {}) {
  const scenes = normalizeValues(item.scenes);
  return [
    item.title,
    item.caseId,
    item.wineType,
    item.priceLevel,
    item.notes,
    ...normalizeValues(item.packageTypes),
    ...normalizeValues(item.styles),
    ...scenes,
    ...scenes.map((scene) => getSceneLabel(scene)),
    ...normalizeValues(item.statuses),
    ...normalizeValues(item.keywords),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterCaseItems(items = [], options = {}) {
  const visibility = normalizeVisibilityFilter(options.visibility);
  const keyword = trimText(options.keyword).toLowerCase();
  return items.filter((item) => {
    if (visibility === "visible" && item.isVisible === false) return false;
    if (visibility === "hidden" && item.isVisible !== false) return false;
    if (visibility === "pinned" && item.isPinned !== true) return false;
    return !keyword || buildCaseSearchText(item).includes(keyword);
  });
}

function normalizeFilterValues(value) {
  return uniqueValues(normalizeValues(value));
}

function normalizeListCaseFilters(value = {}) {
  const filters = value && typeof value === "object" ? value : {};
  const trashValue = filters.trash === "all"
    ? "all"
    : filters.trash === true || filters.trash === "trash" || filters.visibility === "trashed";
  return {
    keyword: trimText(filters.keyword),
    wineType: normalizeFilterValues(filters.wineType),
    packageTypes: normalizeFilterValues(filters.packageTypes),
    styles: normalizeFilterValues(filters.styles),
    priceLevel: normalizeFilterValues(filters.priceLevel || filters.priceLevels),
    scenes: normalizeFilterValues(filters.scenes),
    statuses: normalizeFilterValues(filters.statuses || filters.operationTags),
    homeSections: normalizeFilterValues(filters.homeSections || filters.homeSection),
    visibility: normalizeVisibilityFilter(filters.visibility),
    isPinned: typeof filters.isPinned === "boolean"
      ? filters.isPinned
      : filters.isPinned === "pinned"
        ? true
        : filters.isPinned === "unpinned"
          ? false
          : null,
    trash: trashValue,
  };
}

function hasAnyValue(itemValue, selectedValues) {
  if (!selectedValues.length) return true;
  const itemValues = new Set(normalizeValues(itemValue));
  return selectedValues.some((value) => itemValues.has(value));
}

function filterCaseItemsV2(items = [], inputFilters = {}) {
  const filters = normalizeListCaseFilters(inputFilters);
  const keyword = filters.keyword.toLowerCase();
  return items.filter((item) => {
    const isTrashed = Boolean(item && item.deletedAt);
    if (filters.trash === true && !isTrashed) return false;
    if (filters.trash === false && isTrashed) return false;
    if (filters.visibility === "visible" && item.isVisible !== true) return false;
    if (filters.visibility === "hidden" && item.isVisible === true) return false;
    if (filters.visibility === "pinned" && item.isPinned !== true) return false;
    if (filters.isPinned !== null && (item.isPinned === true) !== filters.isPinned) return false;
    if (!hasAnyValue(item.wineType, filters.wineType)) return false;
    if (!hasAnyValue(item.packageTypes, filters.packageTypes)) return false;
    if (!hasAnyValue(item.styles, filters.styles)) return false;
    if (!hasAnyValue(item.priceLevel, filters.priceLevel)) return false;
    if (!hasAnyValue(item.scenes, filters.scenes)) return false;
    if (!hasAnyValue(item.statuses, filters.statuses)) return false;
    if (!hasAnyValue(item.homeSections, filters.homeSections)) return false;
    return !keyword || buildCaseSearchText(item).includes(keyword);
  });
}

function normalizeListSort(value = {}) {
  const sort = value && typeof value === "object" ? value : {};
  return {
    field: LIST_SORT_FIELDS.includes(sort.field) ? sort.field : "sortOrder",
    direction: sort.direction === "desc" ? "desc" : "asc",
  };
}

function comparableValue(value, field) {
  if (field === "sortOrder") return normalizeSortOrder(value);
  if (field === "createdAt" || field === "updatedAt") {
    if (value instanceof Date) return value.getTime();
    if (value && typeof value.getTime === "function") return value.getTime();
    const timestamp = new Date(value || 0).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  return trimText(value).toLocaleLowerCase("zh-CN");
}

function compareCaseItems(left = {}, right = {}, sortInput = {}) {
  const sort = normalizeListSort(sortInput);
  const leftValue = comparableValue(left[sort.field], sort.field);
  const rightValue = comparableValue(right[sort.field], sort.field);
  let difference = 0;
  if (typeof leftValue === "number" && typeof rightValue === "number") {
    difference = leftValue - rightValue;
  } else {
    difference = String(leftValue).localeCompare(String(rightValue), "zh-CN");
  }
  if (difference !== 0) return sort.direction === "desc" ? -difference : difference;
  const caseIdDifference = trimText(left.caseId).localeCompare(trimText(right.caseId), "zh-CN");
  if (caseIdDifference !== 0) return caseIdDifference;
  return trimText(left._id || left.id).localeCompare(trimText(right._id || right.id), "zh-CN");
}

function sortCaseItemsV2(items = [], sort = {}) {
  return items.slice().sort((left, right) => compareCaseItems(left, right, sort));
}

function paginateCaseItems(items = [], pageValue, pageSizeValue) {
  const page = normalizePage(pageValue);
  const pageSize = normalizePageSize(pageSizeValue);
  const total = items.length;
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    total,
    totalPages: total ? Math.ceil(total / pageSize) : 0,
    hasMore: start + pageSize < total,
  };
}

function normalizeCaseIds(value, limit = CASE_BATCH_MAX) {
  const source = Array.isArray(value) ? value : [];
  const ids = uniqueValues(source);
  if (!ids.length) {
    return { valid: false, code: "INVALID_IDS", message: "请选择案例", ids: [] };
  }
  if (source.length !== ids.length) {
    return { valid: false, code: "DUPLICATE_IDS", message: "案例列表不能包含重复项", ids };
  }
  if (ids.length > limit) {
    return {
      valid: false,
      code: "BATCH_LIMIT_EXCEEDED",
      message: `一次最多操作 ${limit} 个案例`,
      ids,
    };
  }
  return { valid: true, ids };
}

function normalizeTagMode(value) {
  return ["append", "remove", "replace"].includes(value) ? value : "append";
}

function mergeTagValues(existingValue, requestedValue, mode) {
  const existing = uniqueValues(normalizeValues(existingValue));
  const requested = uniqueValues(normalizeValues(requestedValue));
  if (mode === "replace") return requested;
  if (mode === "remove") {
    const removed = new Set(requested);
    return existing.filter((value) => !removed.has(value));
  }
  return uniqueValues([...existing, ...requested]);
}

function buildBatchCasePatch(existing = {}, input = {}) {
  const patch = input.patch && typeof input.patch === "object" ? input.patch : {};
  const tags = input.tags && typeof input.tags === "object" ? input.tags : {};
  const unsupported = Object.keys(patch).filter((field) => !BATCH_PATCH_FIELDS.includes(field));
  const unsupportedTags = Object.keys(tags).filter((field) => !BATCH_TAG_FIELDS.includes(field));
  if (unsupported.length || unsupportedTags.length) {
    return {
      valid: false,
      code: "INVALID_BATCH_PATCH",
      message: "批量修改包含不支持的字段",
    };
  }

  const next = {};
  for (const field of BATCH_PATCH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    if (MULTI_TAG_FIELDS.includes(field)) {
      next[field] = valuesObject(patch[field]);
    } else if (field === "isVisible" || field === "isPinned") {
      next[field] = patch[field] === true;
    } else {
      next[field] = trimText(patch[field]);
    }
  }

  const tagMode = normalizeTagMode(input.tagMode);
  for (const field of MULTI_TAG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(tags, field)) continue;
    next[field] = valuesObject(mergeTagValues(existing[field], tags[field], tagMode));
  }
  if (Object.prototype.hasOwnProperty.call(tags, "priceLevel")) {
    const requested = uniqueValues(normalizeValues(tags.priceLevel));
    if (requested.length > 1) {
      return {
        valid: false,
        code: "INVALID_BATCH_PATCH",
        message: "价位每次只能选择一个值",
      };
    }
    const current = trimText(existing.priceLevel);
    const value = trimText(requested[0]);
    if (tagMode === "replace") {
      next.priceLevel = value;
    } else if (tagMode === "remove") {
      next.priceLevel = value && current === value ? "" : current;
    } else {
      next.priceLevel = current || value;
    }
  }

  const merged = { ...existing, ...next };
  if (Object.prototype.hasOwnProperty.call(next, "homeSections")) {
    const activeSlots = new Set(normalizeValues(next.homeSections));
    next.homeSectionOrder = Object.keys(existing.homeSectionOrder || {}).reduce(
      (orders, slot) => {
        if (activeSlots.has(slot)) orders[slot] = existing.homeSectionOrder[slot];
        return orders;
      },
      {}
    );
    merged.homeSectionOrder = next.homeSectionOrder;
  }
  if (merged.isVisible === true && !normalizeValues(merged.packageTypes).length) {
    return {
      valid: false,
      code: "CASE_NOT_READY",
      message: "案例缺少包装标签，补充后才能上架",
    };
  }
  next.keywords = buildCaseKeywords(merged);
  return { valid: true, data: next, tagMode };
}

function getRecordVersion(item = {}) {
  const value = Number(item && item.version);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function validateExpectedVersion(item, expectedVersion, options = {}) {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === "") {
    return options.required === true
      ? {
        valid: false,
        code: "EXPECTED_VERSION_REQUIRED",
        message: "缺少案例版本，请刷新后重试",
        currentVersion: getRecordVersion(item),
      }
      : { valid: true, currentVersion: getRecordVersion(item) };
  }
  const expected = Number(expectedVersion);
  const currentVersion = getRecordVersion(item);
  if (!Number.isInteger(expected) || expected <= 0) {
    return {
      valid: false,
      code: "INVALID_VERSION",
      message: "案例版本无效",
      currentVersion,
    };
  }
  if (expected !== currentVersion) {
    return {
      valid: false,
      code: "VERSION_CONFLICT",
      message: "案例已被其他管理员修改，请刷新后重试",
      currentVersion,
    };
  }
  return { valid: true, currentVersion };
}

function normalizeClientMutationId(value) {
  const id = trimText(value);
  if (!id) return { valid: true, value: "" };
  if (id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(id)) {
    return {
      valid: false,
      code: "INVALID_MUTATION_ID",
      message: "任务编号格式无效",
      value: "",
    };
  }
  return { valid: true, value: id };
}

function getCloudFilePath(fileID) {
  const value = trimText(fileID);
  if (!isCloudFileId(value)) return "";
  const withoutScheme = value.slice("cloud://".length);
  const slashIndex = withoutScheme.indexOf("/");
  return slashIndex === -1 ? "" : withoutScheme.slice(slashIndex + 1);
}

function getCloudFileEnvironment(fileID) {
  const value = trimText(fileID);
  if (!isCloudFileId(value)) return "";
  const withoutScheme = value.slice("cloud://".length);
  const slashIndex = withoutScheme.indexOf("/");
  return slashIndex > 0 ? withoutScheme.slice(0, slashIndex) : "";
}

function isCloudFileFromEnvironment(fileID, environmentId) {
  const expected = trimText(environmentId);
  const authority = getCloudFileEnvironment(fileID);
  return Boolean(
    expected
    && authority
    && (authority === expected || authority.startsWith(`${expected}.`))
  );
}

function getVideoUploadActorSegment(actor) {
  if (!actor || !trimText(actor.type) || !trimText(actor.id)) return "";
  return crypto
    .createHash("sha256")
    .update(`actor:${actor.type}:${actor.id}`)
    .digest("hex")
    .slice(0, 24);
}

function getVideoUploadCaseSegment(caseDocumentId) {
  const id = trimText(caseDocumentId);
  if (!id) return "";
  return crypto
    .createHash("sha256")
    .update(`case:${id}`)
    .digest("hex")
    .slice(0, 24);
}

function getVideoUploadExtension(kind, fileName) {
  const normalizedKind = trimText(kind).toLowerCase();
  const normalizedName = trimText(fileName).toLowerCase();
  if (normalizedKind === "video") return normalizedName.endsWith(".mp4") ? ".mp4" : "";
  if (normalizedKind !== "poster") return "";
  const match = /\.(jpe?g|png|webp)$/.exec(normalizedName);
  return match ? `.${match[1]}` : "";
}

function buildPreparedVideoUpload(input = {}) {
  const actorSegment = getVideoUploadActorSegment(input.actor);
  const caseSegment = getVideoUploadCaseSegment(input.caseDocumentId);
  const kind = trimText(input.kind).toLowerCase();
  const extension = getVideoUploadExtension(kind, input.fileName);
  const uploadId = trimText(input.uploadId).toLowerCase();
  if (!actorSegment || !caseSegment || !["video", "poster"].includes(kind)) {
    return { valid: false, code: "INVALID_VIDEO_UPLOAD", message: "视频上传参数无效" };
  }
  if (!extension) {
    return kind === "video"
      ? { valid: false, code: "INVALID_VIDEO_FORMAT", message: "仅支持 MP4 视频" }
      : { valid: false, code: "INVALID_VIDEO_POSTER_FORMAT", message: "封面仅支持 JPEG、PNG 或 WebP" };
  }
  if (!/^[a-f0-9]{32}$/.test(uploadId)) {
    return { valid: false, code: "INVALID_VIDEO_UPLOAD", message: "视频上传任务编号无效" };
  }
  const leaf = kind === "video"
    ? `${uploadId}.mp4`
    : `posters/${uploadId}${extension}`;
  return {
    valid: true,
    uploadId,
    kind,
    extension,
    cloudPath: `${VIDEO_UPLOAD_PREFIX}/${actorSegment}/${caseSegment}/${leaf}`,
  };
}

function getPreparedVideoUploadId(fileID) {
  const path = getCloudFilePath(fileID);
  const match = new RegExp(
    `^${VIDEO_UPLOAD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-f0-9]{24}/[a-f0-9]{24}/(?:posters/)?([a-f0-9]{32})\\.(?:mp4|jpe?g|png|webp)$`,
    "i"
  ).exec(path);
  return match ? match[1].toLowerCase() : "";
}

function isPreparedVideoUploadFile(fileID, actor, caseDocumentId, kind) {
  const uploadId = getPreparedVideoUploadId(fileID);
  if (!uploadId) return false;
  const expected = buildPreparedVideoUpload({
    actor,
    caseDocumentId,
    kind,
    fileName: getCloudFilePath(fileID),
    uploadId,
  });
  return expected.valid && getCloudFilePath(fileID) === expected.cloudPath;
}

function isVideoUploadFileForActor(fileID, actor) {
  const path = getCloudFilePath(fileID);
  const actorSegment = getVideoUploadActorSegment(actor);
  if (!actorSegment) return false;
  const pattern = new RegExp(
    `^${VIDEO_UPLOAD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${actorSegment}/[a-f0-9]{24}/(?:[a-f0-9]{32}\\.mp4|posters/[a-f0-9]{32}\\.(?:jpe?g|png|webp))$`,
    "i"
  );
  return pattern.test(path);
}

function getCaseVideoFileIds(item = {}) {
  return Array.from(new Set([
    trimText(item.videoFileID),
    trimText(item.videoPosterFileID),
  ].filter(isCloudFileId)));
}

function hasCaseVideoChanges(existing = {}, patch = {}) {
  const fields = [
    "videoFileID",
    "videoUrl",
    "videoPosterFileID",
    "videoPoster",
    "videoDurationSeconds",
    "videoFileSizeBytes",
  ];
  return fields.some((field) => {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) return false;
    if (field === "videoDurationSeconds" || field === "videoFileSizeBytes") {
      return Number(existing[field] || 0) !== Number(patch[field] || 0);
    }
    return trimText(existing[field]) !== trimText(patch[field]);
  });
}

function isSupportedSourceFileName(path) {
  return /\.(?:jpe?g|png|webp)$/i.test(trimText(path));
}

function isWebAdminUploadFile(fileID, uid) {
  const path = getCloudFilePath(fileID);
  const normalizedUid = trimText(uid);
  if (!path || !normalizedUid || path.includes("..")) return false;
  const parts = path.split("/").filter(Boolean);
  if (
    parts.length < 5 ||
    parts[0] !== "wine-packaging" ||
    parts[1] !== "admin-web" ||
    ![normalizedUid, encodeURIComponent(normalizedUid)].includes(parts[2])
  ) {
    return false;
  }
  return Boolean(parts[3] && parts.slice(4).join("/") && isSupportedSourceFileName(path));
}

function validateWebSourceFiles(fileIDs, actor) {
  if (!actor || actor.type !== "cloudbase_uid") return { valid: true };
  const sources = normalizeValues(fileIDs);
  if (!sources.length || sources.some((fileID) => !isWebAdminUploadFile(fileID, actor.id))) {
    return {
      valid: false,
      code: "INVALID_UPLOAD_PATH",
      message: "图片必须来自当前管理员的后台上传目录，且格式为 JPEG、PNG 或 WebP",
    };
  }
  return { valid: true };
}

function buildExpectedVariantPaths(sourceFileID) {
  const digest = crypto
    .createHash("sha256")
    .update(trimText(sourceFileID))
    .digest("hex")
    .slice(0, 32);
  return {
    displayPath: `wine-packaging/variants/v2/${digest}/display.jpg`,
    thumbnailPath: `wine-packaging/variants/v2/${digest}/thumbnail.jpg`,
    bannerPath: `wine-packaging/variants/v2/${digest}/banner.jpg`,
  };
}

function imageArrayValue(value) {
  return normalizeValues(value).map(trimText).filter(Boolean);
}

function sameOrderedValues(left, right) {
  const leftValues = imageArrayValue(left);
  const rightValues = imageArrayValue(right);
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
}

function hasCaseImageChanges(existing = {}, patch = {}) {
  for (const field of CASE_IMAGE_ARRAY_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(patch, field) &&
      !sameOrderedValues(existing[field], patch[field])
    ) {
      return true;
    }
  }
  for (const field of CASE_IMAGE_SCALAR_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    if (field === "imageVariantVersion") {
      if (Number(existing[field] || 0) !== Number(patch[field] || 0)) return true;
    } else if (trimText(existing[field]) !== trimText(patch[field])) {
      return true;
    }
  }
  return false;
}

function imageTupleKey(source, display, thumbnail, banner) {
  return JSON.stringify([source, display, thumbnail, banner]);
}

/**
 * A Web caller may only introduce deterministic variants generated from a
 * source in its own upload directory. Exact tuples already stored on the case
 * remain trusted so metadata-only edits and reordering migrated legacy images
 * do not break.
 */
function validateWebImageVariants(item = {}, actor, options = {}) {
  if (!actor || actor.type !== "cloudbase_uid") {
    return { valid: true, introducedVariants: false };
  }
  const displays = imageArrayValue(item.galleryImages);
  const sources = imageArrayValue(item.sourceGalleryImages);
  const thumbnails = imageArrayValue(item.galleryThumbnails);
  const banners = imageArrayValue(item.galleryBanners);
  if (
    !displays.length ||
    sources.length !== displays.length ||
    thumbnails.length !== displays.length ||
    banners.length !== displays.length
  ) {
    return {
      valid: false,
      code: "INVALID_IMAGE_VARIANTS",
      message: "电脑后台修改图片时必须提供完整的原图、展示图、缩略图和 Banner 变体",
    };
  }
  if (
    trimText(item.coverImage) !== displays[0] ||
    trimText(item.coverThumbnail) !== thumbnails[0] ||
    trimText(item.coverBanner) !== banners[0]
  ) {
    return {
      valid: false,
      code: "INVALID_IMAGE_VARIANTS",
      message: "封面必须与图片列表第一项的变体一致",
    };
  }

  const existing = options.existing || {};
  const existingSources = imageArrayValue(existing.sourceGalleryImages);
  const existingDisplays = imageArrayValue(existing.galleryImages);
  const existingThumbnails = imageArrayValue(existing.galleryThumbnails);
  const existingBanners = imageArrayValue(existing.galleryBanners);
  const trustedExistingTuples = new Set();
  const existingLength = Math.min(
    existingSources.length,
    existingDisplays.length,
    existingThumbnails.length,
    existingBanners.length
  );
  for (let index = 0; index < existingLength; index += 1) {
    trustedExistingTuples.add(imageTupleKey(
      existingSources[index],
      existingDisplays[index],
      existingThumbnails[index],
      existingBanners[index]
    ));
  }

  let introducedVariants = false;
  for (let index = 0; index < displays.length; index += 1) {
    const tupleKey = imageTupleKey(
      sources[index],
      displays[index],
      thumbnails[index],
      banners[index]
    );
    if (trustedExistingTuples.has(tupleKey)) continue;
    introducedVariants = true;
    if (!isWebAdminUploadFile(sources[index], actor.id)) {
      return {
        valid: false,
        code: "INVALID_UPLOAD_PATH",
        message: "新增图片必须来自当前管理员的后台上传目录",
      };
    }
    const expected = buildExpectedVariantPaths(sources[index]);
    if (
      getCloudFilePath(displays[index]) !== expected.displayPath ||
      getCloudFilePath(thumbnails[index]) !== expected.thumbnailPath ||
      getCloudFilePath(banners[index]) !== expected.bannerPath
    ) {
      return {
        valid: false,
        code: "INVALID_IMAGE_VARIANTS",
        message: "图片变体与原图不匹配，请重新处理后再保存",
      };
    }
  }
  return { valid: true, introducedVariants };
}

function validateHomepageOrders(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, code: "INVALID_HOME_ORDERS", message: "首页编排格式无效" };
  }
  const orders = {};
  for (const slot of Object.keys(HOME_DISPLAY_LIMITS)) {
    const ids = Array.isArray(value[slot]) ? value[slot] : [];
    const normalized = uniqueValues(ids);
    if (normalized.length !== ids.length) {
      return {
        valid: false,
        code: "DUPLICATE_HOME_CASE",
        message: `${HOME_DISPLAY_LABELS[slot]}包含重复案例`,
      };
    }
    if (normalized.length > HOME_DISPLAY_LIMITS[slot]) {
      return {
        valid: false,
        code: "HOME_DISPLAY_LIMIT_REACHED",
        slot,
        limit: HOME_DISPLAY_LIMITS[slot],
        message: `${HOME_DISPLAY_LABELS[slot]}最多展示 ${HOME_DISPLAY_LIMITS[slot]} 个`,
      };
    }
    orders[slot] = normalized;
  }
  return { valid: true, orders };
}

function sortBySortOrder(items = [], direction = "asc") {
  const multiplier = direction === "desc" ? -1 : 1;
  return items.slice().sort((left, right) => {
    const difference = normalizeSortOrder(left && left.sortOrder) - normalizeSortOrder(right && right.sortOrder);
    return difference === 0 ? 0 : difference * multiplier;
  });
}

function buildHomepageDisplayItem(item = {}, options = {}) {
  const slot = normalizeHomepageDisplaySlot(options.slot);
  const source = options.source === "banner" ? "banner" : "case";
  const image =
    source === "banner"
      ? trimText(item.optimizedImage || item.image)
      : trimText(item.coverBanner || item.coverImage);
  return {
    id: item._id || item.caseId || image,
    caseId: trimText(item.caseId),
    title: trimText(item.title) || (source === "banner" ? "未命名轮播图" : "未命名案例"),
    coverImage: image,
    image,
    sortOrder: normalizeSortOrder(item.sortOrder),
    isVisible: item.isVisible !== false,
    source,
    sourceLabel: source === "banner" ? "独立轮播图" : "案例",
    displaySlot: slot,
    displayLabel: HOME_DISPLAY_LABELS[slot] || "首页展示",
    homeSections: normalizeValues(item.homeSections),
    homeSectionOrder: normalizeHomeSectionOrder(item.homeSectionOrder).value,
    packageTypes: normalizeValues(item.packageTypes),
    styles: normalizeValues(item.styles),
    priceLevel: trimText(item.priceLevel),
  };
}

function sortHomepageDisplayItems(items = [], slot, fallbackDirection = "asc") {
  return items.slice().sort((left, right) => {
    const leftHomeOrder = getHomeSectionOrder(left, slot);
    const rightHomeOrder = getHomeSectionOrder(right, slot);
    if (leftHomeOrder && rightHomeOrder && leftHomeOrder !== rightHomeOrder) {
      return leftHomeOrder - rightHomeOrder;
    }
    if (leftHomeOrder && !rightHomeOrder) return -1;
    if (!leftHomeOrder && rightHomeOrder) return 1;
    const multiplier = fallbackDirection === "desc" ? -1 : 1;
    const sortDifference = normalizeSortOrder(left.sortOrder) - normalizeSortOrder(right.sortOrder);
    if (sortDifference !== 0) return sortDifference * multiplier;
    return trimText(left.id).localeCompare(trimText(right.id), "zh-CN");
  });
}

function buildHomepageDisplaySearchText(item = {}) {
  return [
    item.title,
    item.caseId,
    item.displayLabel,
    item.sourceLabel,
    ...normalizeValues(item.packageTypes),
    ...normalizeValues(item.styles),
    item.priceLevel,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterHomepageDisplayItems(items = [], keyword = "") {
  const normalizedKeyword = trimText(keyword).toLowerCase();
  if (!normalizedKeyword) return items.slice();
  return items.filter((item) => buildHomepageDisplaySearchText(item).includes(normalizedKeyword));
}

function buildHomepageDisplayItems(cases = [], banners = [], options = {}) {
  const slot = normalizeHomepageDisplaySlot(options.slot);
  const limit = getHomepageDisplayLimit(slot);
  if (!slot || !limit) return [];

  const visibleCases = cases.filter((item) => item && item.isVisible === true);
  let items;

  if (slot === "banner") {
    const visibleBanners = banners
      .filter((item) => item && item.isVisible === true)
      .map((item) => buildHomepageDisplayItem(item, { slot, source: "banner" }));
    const caseBanners = visibleCases
      .filter((item) => normalizeValues(item.homeSections).includes(slot))
      .map((item) => buildHomepageDisplayItem(item, { slot, source: "case" }));
    const seen = new Set();
    items = sortHomepageDisplayItems(
      visibleBanners.concat(caseBanners),
      slot,
      "asc"
    ).filter((item) => {
      const key = item.caseId || item.image || item.id;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } else {
    const direction = slot === "latest" ? "desc" : "asc";
    items = sortHomepageDisplayItems(
      visibleCases
        .filter((item) => normalizeValues(item.homeSections).includes(slot))
        .map((item) => buildHomepageDisplayItem(item, { slot, source: "case" })),
      slot,
      direction
    );
  }

  const limitedItems = options.applyLimit === false ? items : items.slice(0, limit);
  const displayedItems = limitedItems.map((item, index) => {
    const displayOrder = index + 1;
    return {
      ...item,
      displayOrder,
      displayOrderLabel: `第 ${displayOrder} ${slot === "banner" ? "张" : "个"}`,
    };
  });
  return filterHomepageDisplayItems(displayedItems, options.keyword);
}

function validateHomepageDisplayCapacity(cases = [], banners = [], candidate = {}, options = {}) {
  const excludedId = trimText(options.excludedId);
  const candidateId = trimText(candidate._id || candidate.id);
  const slots = uniqueValues(
    options.slots === undefined ? getActiveHomepageSlots(candidate) : normalizeValues(options.slots)
  )
    .map(normalizeHomepageDisplaySlot)
    .filter(Boolean);
  if (!slots.length) return { valid: true };

  const nextCases = cases
    .filter((item) => {
      const itemId = trimText(item && (item._id || item.id));
      return !excludedId || itemId !== excludedId;
    })
    .concat(candidate && candidate.isVisible === true
      ? [{ ...candidate, _id: candidateId || excludedId || candidate._id }]
      : []);

  for (const slot of slots) {
    const limit = getHomepageDisplayLimit(slot);
    const items = buildHomepageDisplayItems(nextCases, banners, {
      slot,
      applyLimit: false,
    });
    if (items.length > limit) {
      const label = HOME_DISPLAY_LABELS[slot];
      const unit = slot === "banner" ? "张" : "个";
      return {
        valid: false,
        code: "HOME_DISPLAY_LIMIT_REACHED",
        slot,
        limit,
        message: `${label}最多展示 ${limit} ${unit}，请先取消其他案例${slot === "banner" ? "或轮播图" : ""}的${label}显示`,
      };
    }
  }

  return { valid: true };
}

module.exports = {
  ALLOWED_CASE_FIELDS,
  BANNER_COLLECTION,
  BATCH_PATCH_FIELDS,
  BATCH_TAG_FIELDS,
  CASE_ADMIN_OPTIONS,
  CASE_ADMIN_DEFAULT_SORT_ORDER,
  CASE_BATCH_MAX,
  CASE_COLLECTION,
  CASE_GALLERY_MAX,
  CASE_SCAN_BATCH_SIZE,
  IMAGE_URL_BATCH_SIZE,
  HOME_DISPLAY_LABELS,
  HOME_DISPLAY_LIMITS,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PINNED_CASE_LIMIT,
  SEARCH_FETCH_LIMIT,
  VIDEO_DURATION_SECONDS_MAX,
  VIDEO_POSTER_UPLOAD_BYTES,
  VIDEO_UPLOAD_BYTES,
  VIDEO_UPLOAD_PREFIX,
  WEB_UPLOAD_PREFIX,
  VALID_CASE_ADMIN_ACTIONS,
  buildBatchCasePatch,
  buildCaseKeywords,
  buildCaseSearchText,
  buildExpectedVariantPaths,
  buildPreparedVideoUpload,
  buildHomepageDisplayItems,
  buildHomepageDisplaySearchText,
  compareCaseItems,
  filterCaseItems,
  filterCaseItemsV2,
  filterHomepageDisplayItems,
  generateCaseId,
  generateSequentialCaseId,
  getCloudFilePath,
  getCloudFileEnvironment,
  getCaseVideoFileIds,
  getPreparedVideoUploadId,
  getEnvList,
  getHomeSectionOrder,
  getActivatedHomepageSlots,
  getActiveHomepageSlots,
  getAdminOpenidsFromEnv,
  getRoleAdminOpenidsEnv,
  getAdminDisplayName,
  getSceneLabel,
  getCaseIdNumber,
  getRecordVersion,
  hasCaseImageChanges,
  hasCaseVideoChanges,
  isAdminActor,
  isAdminOpenid,
  isRoleAdminOpenid,
  isCloudFileId,
  isCloudFileFromEnvironment,
  isPreparedVideoUploadFile,
  isVideoUploadFileForActor,
  isSupportedSourceFileName,
  isWebAdminUploadFile,
  isWebWriteEnabled,
  normalizeCaseIds,
  normalizeClientMutationId,
  normalizeCloudFileIds,
  normalizeGalleryImages,
  normalizeHomeSectionOrder,
  normalizeHttpsMediaUrl,
  normalizeListCaseFilters,
  normalizeListSort,
  normalizePage,
  normalizePageSize,
  normalizeHomepageDisplaySlot,
  normalizeVisibilityFilter,
  paginateCaseItems,
  parseCloudbaseContext,
  parseAdminDisplayNames,
  pickAllowedCaseFields,
  resolveAdminActor,
  sanitizeCasePayload,
  sanitizeVideoDuration,
  sanitizeVideoPatch,
  sortCaseItemsV2,
  trimText,
  validateExpectedVersion,
  validateHomepageDisplayCapacity,
  validateHomepageOrders,
  validateWebImageVariants,
  validateWebSourceFiles,
};
