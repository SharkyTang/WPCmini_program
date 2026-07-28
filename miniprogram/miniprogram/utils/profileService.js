const { callUserData } = require("./userDataService");

const PROFILE_STORAGE_KEY = "wineProfileInfo";
const DEFAULT_NICKNAME = "微信名称";
let sessionSummaryCache = null;
let sessionSummaryPromise = null;

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
  const stored = wx.getStorageSync ? wx.getStorageSync(PROFILE_STORAGE_KEY) : null;
  return normalizeStoredProfile(stored);
}

function cacheProfile(profile = {}) {
  if (!wx.setStorageSync) return;
  const normalized = normalizeStoredProfile(profile);
  wx.setStorageSync(PROFILE_STORAGE_KEY, normalized);
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
  const avatarUrl = avatarFileId ? await getTemporaryAvatarUrl(avatarFileId) : "";
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

async function fetchProfile() {
  const profile = await fetchProfileRecord();
  if (!profile) return null;
  return hydrateProfile(profile);
}

function normalizeRoles(roles = {}) {
  return {
    inquiryAdmin: roles.inquiryAdmin === true,
    caseAdmin: roles.caseAdmin === true,
    notificationAdmin: roles.notificationAdmin === true,
  };
}

async function fetchSessionSummary(options = {}) {
  if (!options.forceRefresh && sessionSummaryCache) {
    return sessionSummaryCache;
  }
  if (!sessionSummaryPromise || options.forceRefresh) {
    sessionSummaryPromise = callUserData("getSessionSummary")
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
        sessionSummaryCache = {
          openid: trimText(result.openid),
          profile,
          roles: normalizeRoles(result.roles),
        };
        return sessionSummaryCache;
      })
      .finally(() => {
        sessionSummaryPromise = null;
      });
  }
  return sessionSummaryPromise;
}

function clearSessionSummaryCache() {
  sessionSummaryCache = null;
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

function hasCompletedProfile(profile = {}) {
  return Boolean(trimText(profile.nickname) && isCloudFileId(profile.avatarFileId));
}

module.exports = {
  DEFAULT_NICKNAME,
  PROFILE_STORAGE_KEY,
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
