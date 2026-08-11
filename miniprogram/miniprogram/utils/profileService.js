const { callUserData } = require("./userDataService");

const PROFILE_STORAGE_KEY = "wineProfileInfo";
const DEFAULT_NICKNAME = "微信名称";
const SESSION_SUMMARY_TTL_MS = 60 * 1000;
let sessionSummaryCache = null;
let sessionSummaryCachedAt = 0;
let sessionSummaryPromise = null;
let sessionSummaryGeneration = 0;

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isCloudFileId(value) {
  return typeof value === "string" && value.indexOf("cloud://") === 0;
}

function normalizeStoredProfile(profile = {}) {
  const source = profile && typeof profile === "object" ? profile : {};
  return {
    nickname: trimText(source.nickname),
    avatarFileId: isCloudFileId(source.avatarFileId) ? source.avatarFileId : "",
    avatarUrl: typeof source.avatarUrl === "string" ? source.avatarUrl : "",
  };
}

function getLegacyProfile() {
  try {
    const stored = wx.getStorageSync ? wx.getStorageSync(PROFILE_STORAGE_KEY) : null;
    return normalizeStoredProfile(stored);
  } catch (error) {
    return normalizeStoredProfile();
  }
}

function cacheProfile(profile = {}) {
  if (!wx.setStorageSync) return;
  const normalized = normalizeStoredProfile(profile);
  try {
    wx.setStorageSync(PROFILE_STORAGE_KEY, normalized);
  } catch (error) {
    // Local persistence is a best-effort optimization; cloud profile remains authoritative.
  }
}

async function getTemporaryAvatarUrl(avatarFileId) {
  if (!isCloudFileId(avatarFileId)) return "";
  if (!wx.cloud || !wx.cloud.getTempFileURL) {
    throw new Error("当前基础库不支持头像读取");
  }

  const response = await wx.cloud.getTempFileURL({
    fileList: [avatarFileId],
  });
  const file = response && response.fileList && response.fileList[0];
  return (file && file.tempFileURL) || "";
}

async function hydrateProfile(profile = {}) {
  const nickname = trimText(profile.nickname);
  const avatarFileId = isCloudFileId(profile.avatarFileId) ? profile.avatarFileId : "";
  let avatarUrl = typeof profile.avatarUrl === "string" ? profile.avatarUrl : "";
  if (avatarFileId && !avatarUrl) {
    try {
      avatarUrl = await getTemporaryAvatarUrl(avatarFileId);
    } catch (error) {
      // 头像临时链接不是资料本身。链接换取失败时保留昵称和 fileId，
      // 避免把一次 CDN/基础库故障放大成整页资料读取或保存失败。
      console.warn("读取头像临时链接失败", error);
      avatarUrl = "";
    }
  }
  return {
    nickname,
    avatarFileId,
    avatarUrl,
  };
}

async function fetchProfileRecord() {
  const result = await callUserData("getProfile");
  return result.profile ? normalizeStoredProfile(result.profile) : null;
}

async function fetchProfile(options = {}) {
  const summary = await fetchSessionSummary(options);
  return summary.profile;
}

function normalizeRoles(roles = {}) {
  return {
    inquiryAdmin: roles.inquiryAdmin === true,
    caseAdmin: roles.caseAdmin === true,
    notificationAdmin: roles.notificationAdmin === true,
  };
}

async function fetchSessionSummary(options = {}) {
  const now = Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs)
    ? Math.max(0, options.maxAgeMs)
    : SESSION_SUMMARY_TTL_MS;
  const cacheIsFresh = (
    sessionSummaryCache
    && now - sessionSummaryCachedAt < maxAgeMs
  );

  if (!options.forceRefresh && cacheIsFresh) {
    return sessionSummaryCache;
  }
  // forceRefresh 只跳过已完成的缓存，不绕过进行中的请求，避免多个页面
  // 同时 onShow / 下拉刷新时重复调用同一个云函数。
  if (sessionSummaryPromise) return sessionSummaryPromise;

  const requestGeneration = sessionSummaryGeneration;
  const requestPromise = callUserData("getSessionSummary")
    .then((result) => {
      const rawProfile = result.profile
        ? normalizeStoredProfile(result.profile)
        : null;
      const profile = rawProfile
        ? {
          ...rawProfile,
          avatarUrl: result.profile.avatarUrl || rawProfile.avatarUrl || "",
        }
        : null;
      const summary = {
        openid: trimText(result.openid),
        profile,
        roles: normalizeRoles(result.roles),
      };
      if (requestGeneration === sessionSummaryGeneration) {
        sessionSummaryCache = summary;
        sessionSummaryCachedAt = Date.now();
      }
      return summary;
    })
    .finally(() => {
      if (sessionSummaryPromise === requestPromise) {
        sessionSummaryPromise = null;
      }
    });
  sessionSummaryPromise = requestPromise;
  return requestPromise;
}

function clearSessionSummaryCache() {
  sessionSummaryGeneration += 1;
  sessionSummaryCache = null;
  sessionSummaryCachedAt = 0;
  sessionSummaryPromise = null;
}

async function uploadProfileAvatar(filePath) {
  if (!wx.cloud || !wx.cloud.uploadFile) {
    throw new Error("当前基础库不支持头像上传");
  }
  if (!filePath) throw new Error("请先选择头像");

  const suffixMatch = filePath.match(/(\.[a-zA-Z0-9]{1,8})(?:\?.*)?$/);
  const suffix = suffixMatch ? suffixMatch[1].toLowerCase() : ".jpg";
  const random = Math.random().toString(36).slice(2, 10);
  const response = await wx.cloud.uploadFile({
    cloudPath: `profile-avatars/avatar-${Date.now()}-${random}${suffix}`,
    filePath,
  });

  if (!response || !isCloudFileId(response.fileID)) {
    throw new Error("头像上传失败，请重试");
  }
  return response.fileID;
}

async function saveProfile(profile = {}) {
  const result = await callUserData("saveProfile", {
    profile: {
      nickname: trimText(profile.nickname),
      avatarFileId: profile.avatarFileId,
    },
  });
  clearSessionSummaryCache();
  return hydrateProfile(result.profile || profile);
}

function hasCompletedProfile(profile) {
  const source = profile && typeof profile === "object" ? profile : {};
  return Boolean(trimText(source.nickname) && isCloudFileId(source.avatarFileId));
}

module.exports = {
  DEFAULT_NICKNAME,
  PROFILE_STORAGE_KEY,
  SESSION_SUMMARY_TTL_MS,
  cacheProfile,
  clearSessionSummaryCache,
  fetchProfile,
  fetchProfileRecord,
  fetchSessionSummary,
  getLegacyProfile,
  getTemporaryAvatarUrl,
  hasCompletedProfile,
  hydrateProfile,
  isCloudFileId,
  saveProfile,
  uploadProfileAvatar,
};
