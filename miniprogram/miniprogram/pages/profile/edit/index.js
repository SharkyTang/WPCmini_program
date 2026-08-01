const {
  cacheProfile,
  fetchProfile,
  getLegacyProfile,
  hasCompletedProfile,
  saveProfile,
  uploadProfileAvatar,
} = require("../../../utils/profileService");
const {
  cacheCompletedProfileIdentity,
  clearPendingProfileAction,
  fetchOpenId,
} = require("../../../utils/userService");
const {
  clearPendingLibraryAction,
  getProfileSetupCopy,
  reportLibraryEvent,
} = require("../../../utils/libraryAccessService");

const PROFILE_SETUP_SOURCES = new Set([
  "detail_favorite",
  "profile_favorites",
  "profile_history",
]);

function normalizeProfileSetupSource(value) {
  return PROFILE_SETUP_SOURCES.has(value) ? value : "";
}

function getSetupPresentation(source) {
  if (!source) {
    return {
      subtitle: "使用微信头像和名称，方便记录你的收藏",
      buttonText: "完成资料",
    };
  }
  const copy = getProfileSetupCopy(source);
  return {
    subtitle: copy.subtitle,
    buttonText: copy.buttonText,
  };
}

function getLibraryKind(source) {
  return source === "profile_history" ? "history" : "favorites";
}

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createDraft(profile = {}) {
  return {
    nickname: trimText(profile.nickname),
    avatarFileId: profile.avatarFileId || "",
    avatarUrl: profile.avatarUrl || "",
    avatarLocalPath: "",
  };
}

function comparableDraft(draft = {}) {
  return JSON.stringify({
    nickname: trimText(draft.nickname),
    avatarFileId: draft.avatarFileId || "",
    avatarLocalPath: draft.avatarLocalPath || "",
  });
}

function showProfileLoading(page) {
  if (!page._activeProfileLoadRequestId || page._profileLoadingVisible) return;
  page._profileLoadingVisible = true;
  wx.showLoading({
    title: "读取资料",
    mask: true,
  });
}

function beginProfileLoading(page) {
  const requestId = (page._profileLoadSequence || 0) + 1;
  page._profileLoadSequence = requestId;
  page._activeProfileLoadRequestId = requestId;
  showProfileLoading(page);
  return requestId;
}

function isCurrentProfileLoad(page, requestId) {
  return page._activeProfileLoadRequestId === requestId;
}

function hideProfileLoading(page) {
  if (!page._profileLoadingVisible) return;
  page._profileLoadingVisible = false;
  wx.hideLoading();
}

function finishProfileLoading(page, requestId) {
  if (!isCurrentProfileLoad(page, requestId)) return;
  page._activeProfileLoadRequestId = 0;
  page.setData({ isLoading: false });
  hideProfileLoading(page);
}

function cancelProfileLoading(page) {
  page._profileLoadSequence = (page._profileLoadSequence || 0) + 1;
  page._activeProfileLoadRequestId = 0;
  hideProfileLoading(page);
}

Page({
  data: {
    mode: "edit",
    pageTitle: "个人资料",
    pageSubtitle: "修改你的头像和名称",
    profileDraft: createDraft(),
    initialDraft: createDraft(),
    isLoading: true,
    loadError: false,
    isSaving: false,
    hasUnsavedChanges: false,
    identityGate: false,
    profileSaved: false,
    source: "",
    saveButtonText: "保存资料",
    topTips: {
      show: false,
      message: "",
      type: "error",
    },
  },

  onLoad(options = {}) {
    this._profileLoadSequence = 0;
    this._activeProfileLoadRequestId = 0;
    this._profileLoadingVisible = false;
    this.profileSetupStartedAt = Date.now();
    const mode = options.mode === "setup" ? "setup" : "edit";
    const pageTitle = mode === "setup" ? "完善资料" : "个人资料";
    const identityGate = options.identityGate === "1";
    const source = identityGate ? normalizeProfileSetupSource(options.source) : "";
    const setupPresentation = getSetupPresentation(source);
    this.setData({
      mode,
      pageTitle,
      pageSubtitle: mode === "setup" ? setupPresentation.subtitle : "修改你的头像和名称",
      identityGate,
      profileSaved: false,
      source,
      saveButtonText: mode === "setup" ? setupPresentation.buttonText : "保存资料",
    });
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: pageTitle });
    this.loadProfile();
  },

  onShow() {
    showProfileLoading(this);
  },

  onHide() {
    hideProfileLoading(this);
  },

  onUnload() {
    cancelProfileLoading(this);
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    if (this.data.identityGate && !this.data.profileSaved && this.data.source) {
      clearPendingLibraryAction(this.data.source);
    } else if (this.data.identityGate && !this.data.profileSaved) {
      clearPendingProfileAction();
    }
  },

  async loadProfile() {
    const requestId = beginProfileLoading(this);
    this.setData({
      isLoading: true,
      loadError: false,
      hasUnsavedChanges: false,
    });

    try {
      const legacyProfile = getLegacyProfile();
      const legacyDraft = createDraft({
        nickname: legacyProfile.nickname,
        avatarUrl: legacyProfile.avatarUrl,
        avatarFileId: legacyProfile.avatarFileId,
      });
      if (!isCurrentProfileLoad(this, requestId)) return;
      this.setData({
        profileDraft: legacyDraft,
        initialDraft: createDraft(legacyDraft),
      });
      const profile = await fetchProfile();
      if (!isCurrentProfileLoad(this, requestId)) return;
      if (profile && hasCompletedProfile(profile)) {
        const profileDraft = createDraft(profile);
        const keepGatePresentation = this.data.identityGate && Boolean(this.data.source);
        const pageTitle = keepGatePresentation ? "完善资料" : "个人资料";
        cacheProfile(profile);
        this.setData({
          mode: keepGatePresentation ? "setup" : "edit",
          pageTitle,
          pageSubtitle: keepGatePresentation
            ? this.data.pageSubtitle
            : "修改你的头像和名称",
          saveButtonText: keepGatePresentation
            ? this.data.saveButtonText
            : "保存资料",
          profileDraft,
          initialDraft: createDraft(profileDraft),
        });
        if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: pageTitle });
      }
    } catch (error) {
      if (!isCurrentProfileLoad(this, requestId)) return;
      console.error("读取个人资料失败", error);
      this.setData({ loadError: true });
    } finally {
      finishProfileLoading(this, requestId);
    }
  },

  onChooseWechatAvatar(event) {
    const avatarUrl = event && event.detail && event.detail.avatarUrl;
    if (!avatarUrl) return;
    const profileDraft = {
      ...this.data.profileDraft,
      avatarUrl,
      avatarFileId: "",
      avatarLocalPath: avatarUrl,
    };
    this.setData({ profileDraft });
    this.refreshUnsavedState();
  },

  onNicknameInput(event) {
    const nickname = event && event.detail ? event.detail.value : "";
    this.setData({
      profileDraft: {
        ...this.data.profileDraft,
        nickname,
      },
    });
    this.refreshUnsavedState();
  },

  refreshUnsavedState() {
    const hasUnsavedChanges = comparableDraft(this.data.profileDraft) !== comparableDraft(this.data.initialDraft);
    this.setData({ hasUnsavedChanges });
    if (!hasUnsavedChanges && wx.disableAlertBeforeUnload) {
      wx.disableAlertBeforeUnload();
      return;
    }
    if (hasUnsavedChanges && wx.enableAlertBeforeUnload) {
      wx.enableAlertBeforeUnload({ message: "资料尚未保存，确认离开吗？" });
    }
  },

  showTopTips(message, type = "error") {
    this.setData({
      topTips: {
        show: true,
        message,
        type,
      },
    });
  },

  hideTopTips() {
    this.setData({
      "topTips.show": false,
    });
  },

  reportProfileSetup(eventName, result) {
    if (!this.data.identityGate || !this.data.source) return;
    reportLibraryEvent(eventName, {
      kind: getLibraryKind(this.data.source),
      source: this.data.source,
      result,
      durationMs: Date.now() - (this.profileSetupStartedAt || Date.now()),
    });
  },

  async saveProfileDraft() {
    if (this.data.isSaving) return;
    const draft = this.data.profileDraft;
    const nickname = trimText(draft.nickname);
    if (!nickname) {
      this.showTopTips("请输入昵称");
      return;
    }
    if (nickname.length > 14) {
      this.showTopTips("昵称最多 14 个字符");
      return;
    }
    if (!draft.avatarFileId && !draft.avatarLocalPath) {
      this.showTopTips("请先选择头像");
      return;
    }

    this.setData({ isSaving: true });
    let avatarFileId = draft.avatarFileId;
    if (!avatarFileId) {
      try {
        avatarFileId = await uploadProfileAvatar(draft.avatarLocalPath);
      } catch (error) {
        console.error("头像上传失败", error);
        this.setData({ isSaving: false });
        this.reportProfileSetup("profile_setup_fail", "fail");
        this.showTopTips("头像上传失败，请重新选择后再试");
        return;
      }
    }

    try {
      const savedProfile = await saveProfile({ nickname, avatarFileId });
      cacheProfile(savedProfile);
      try {
        const openid = await fetchOpenId();
        cacheCompletedProfileIdentity(openid, savedProfile);
      } catch (identityError) {
        console.warn("资料已保存，但本次身份缓存恢复失败", identityError);
      }
      const profileDraft = createDraft(savedProfile);
      this.setData({
        profileDraft,
        initialDraft: createDraft(profileDraft),
        hasUnsavedChanges: false,
        isSaving: false,
        profileSaved: true,
      });
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      this.reportProfileSetup("profile_setup_success", "success");
      if (this.data.identityGate) {
        this.navigateBackAfterSave();
        return;
      }
      wx.showToast({ title: "已保存", icon: "success" });
      setTimeout(() => this.navigateBackAfterSave(), 500);
    } catch (error) {
      console.error("保存个人资料失败", error);
      this.setData({ isSaving: false });
      this.reportProfileSetup("profile_setup_fail", "fail");
      this.showTopTips(error && error.message ? error.message : "保存失败，请重试");
    }
  },

  navigateBackAfterSave() {
    wx.navigateBack({
      fail: (error) => {
        console.error("资料已保存但返回失败", error);
        this.showTopTips("资料已保存，请返回继续操作");
      },
    });
  },
});
