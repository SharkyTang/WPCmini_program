const {
  cacheProfile,
  fetchSessionSummary,
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
const { reportPerformanceEvent } = require("../../../utils/errorTelemetry");

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
    avatarLocalPath: profile.avatarLocalPath || "",
  };
}

function comparableDraft(draft = {}) {
  return JSON.stringify({
    nickname: trimText(draft.nickname),
    avatarFileId: draft.avatarFileId || "",
    avatarLocalPath: draft.avatarLocalPath || "",
  });
}

function comparableAvatar(draft = {}) {
  return JSON.stringify({
    avatarFileId: draft.avatarFileId || "",
    avatarLocalPath: draft.avatarLocalPath || "",
  });
}

function ensureDirtyFields(page) {
  if (!page._dirtyFields) {
    page._dirtyFields = {
      nickname: false,
      avatar: false,
    };
  }
  return page._dirtyFields;
}

function isCurrentProfileSync(page, requestId) {
  return (
    page._isPageAlive !== false
    && page._activeProfileSyncId === requestId
  );
}

function isCurrentProfileSave(page, requestId) {
  return (
    page._isPageAlive !== false
    && page._activeProfileSaveId === requestId
  );
}

Page({
  data: {
    mode: "edit",
    pageTitle: "个人资料",
    pageSubtitle: "修改你的头像和名称",
    profileDraft: createDraft(),
    initialDraft: createDraft(),
    syncState: "refreshing",
    syncErrorMessage: "",
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
    const profilePageStartedAt = Date.now();
    this._isPageAlive = true;
    this._profileSyncSequence = 0;
    this._activeProfileSyncId = 0;
    this._profileSaveSequence = 0;
    this._activeProfileSaveId = 0;
    this._returnTimer = null;
    this._sessionOpenId = "";
    this._dirtyFields = {
      nickname: false,
      avatar: false,
    };
    this.profileSetupStartedAt = Date.now();
    const mode = options.mode === "setup" ? "setup" : "edit";
    const pageTitle = mode === "setup" ? "完善资料" : "个人资料";
    const identityGate = options.identityGate === "1";
    const source = identityGate ? normalizeProfileSetupSource(options.source) : "";
    const setupPresentation = getSetupPresentation(source);
    const localDraft = createDraft(getLegacyProfile());
    this.setData({
      mode,
      pageTitle,
      pageSubtitle: mode === "setup" ? setupPresentation.subtitle : "修改你的头像和名称",
      identityGate,
      profileSaved: false,
      source,
      saveButtonText: mode === "setup" ? setupPresentation.buttonText : "保存资料",
      profileDraft: localDraft,
      initialDraft: createDraft(localDraft),
      syncState: "refreshing",
      syncErrorMessage: "",
      isSaving: false,
      hasUnsavedChanges: false,
    }, () => {
      reportPerformanceEvent("page_ready_result", {
        route: "pages/profile/edit/index",
        stage: "local_form_visible",
        durationMs: Date.now() - profilePageStartedAt,
        success: true,
        action: "profile_local_first_paint",
        requestKind: "local",
        cacheState: localDraft.nickname || localDraft.avatarFileId ? "hit" : "miss",
      });
    });
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: pageTitle });
    this.loadProfile();
  },

  onUnload() {
    this._isPageAlive = false;
    this._profileSyncSequence = (this._profileSyncSequence || 0) + 1;
    this._activeProfileSyncId = 0;
    this._profileSaveSequence = (this._profileSaveSequence || 0) + 1;
    this._activeProfileSaveId = 0;
    if (this._returnTimer !== null && typeof clearTimeout === "function") {
      clearTimeout(this._returnTimer);
      this._returnTimer = null;
    }
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    if (this.data.identityGate && !this.data.profileSaved && this.data.source) {
      clearPendingLibraryAction(this.data.source);
    } else if (this.data.identityGate && !this.data.profileSaved) {
      clearPendingProfileAction();
    }
  },

  async loadProfile(options = {}) {
    if (this._isPageAlive === false) return;
    ensureDirtyFields(this);
    const requestId = (this._profileSyncSequence || 0) + 1;
    this._profileSyncSequence = requestId;
    this._activeProfileSyncId = requestId;
    this.setData({
      syncState: "refreshing",
      syncErrorMessage: "",
    });

    try {
      const summary = await fetchSessionSummary({
        forceRefresh: options.forceRefresh === true,
      });
      if (!isCurrentProfileSync(this, requestId)) return;
      if (summary && summary.openid) this._sessionOpenId = summary.openid;
      const profile = summary && summary.profile;
      const remoteDraft = createDraft(profile || {});
      const currentDraft = createDraft(this.data.profileDraft);
      const dirtyFields = ensureDirtyFields(this);
      const profileDraft = {
        nickname: dirtyFields.nickname
          ? currentDraft.nickname
          : remoteDraft.nickname,
        avatarFileId: dirtyFields.avatar
          ? currentDraft.avatarFileId
          : remoteDraft.avatarFileId,
        avatarUrl: dirtyFields.avatar
          ? currentDraft.avatarUrl
          : remoteDraft.avatarUrl,
        avatarLocalPath: dirtyFields.avatar
          ? currentDraft.avatarLocalPath
          : remoteDraft.avatarLocalPath,
      };
      dirtyFields.nickname = (
        dirtyFields.nickname
        && trimText(profileDraft.nickname) !== trimText(remoteDraft.nickname)
      );
      dirtyFields.avatar = (
        dirtyFields.avatar
        && comparableAvatar(profileDraft) !== comparableAvatar(remoteDraft)
      );
      const hasUnsavedChanges = (
        comparableDraft(profileDraft) !== comparableDraft(remoteDraft)
      );
      const keepGatePresentation = this.data.identityGate && Boolean(this.data.source);
      const completed = hasCompletedProfile(profile);
      const pageTitle = keepGatePresentation
        ? "完善资料"
        : completed
          ? "个人资料"
          : this.data.pageTitle;
      // A null remote profile is an authoritative empty baseline. Persisting the
      // empty shape prevents stale local data from flashing again next time,
      // while dirty fields above still preserve input made during this request.
      cacheProfile(profile || {});
      this.setData({
        mode: keepGatePresentation
          ? "setup"
          : completed
            ? "edit"
            : this.data.mode,
        pageTitle,
        pageSubtitle: keepGatePresentation
          ? this.data.pageSubtitle
          : completed
            ? "修改你的头像和名称"
            : this.data.pageSubtitle,
        saveButtonText: keepGatePresentation
          ? this.data.saveButtonText
          : completed
            ? "保存资料"
            : this.data.saveButtonText,
        profileDraft,
        initialDraft: remoteDraft,
        hasUnsavedChanges,
      });
      if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: pageTitle });
      this.updateUnloadAlert(hasUnsavedChanges);
      if (!isCurrentProfileSync(this, requestId)) return;
      this._activeProfileSyncId = 0;
      this.setData({
        syncState: "ready",
        syncErrorMessage: "",
      });
    } catch (error) {
      if (!isCurrentProfileSync(this, requestId)) return;
      console.error("读取个人资料失败", error);
      this._activeProfileSyncId = 0;
      this.setData({
        syncState: "error",
        syncErrorMessage: "云端资料同步失败，请检查网络后重试",
      });
    }
  },

  retryProfileSync() {
    return this.loadProfile({ forceRefresh: true });
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
    ensureDirtyFields(this).avatar = (
      comparableAvatar(profileDraft) !== comparableAvatar(this.data.initialDraft)
    );
    this.refreshUnsavedState(profileDraft);
  },

  onAvatarImageError(event) {
    const profileDraft = this.data.profileDraft || createDraft();
    if (!profileDraft.avatarUrl) return;
    const failedUrl = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.url
      : "";
    if (failedUrl && failedUrl !== profileDraft.avatarUrl) return;
    // 临时 URL 失效只切回头像占位，不清空可持久化的 fileId / 本地待上传路径。
    this.setData({
      profileDraft: {
        ...profileDraft,
        avatarUrl: "",
      },
    });
  },

  onNicknameInput(event) {
    const nickname = event && event.detail ? event.detail.value : "";
    const profileDraft = {
      ...this.data.profileDraft,
      nickname,
    };
    ensureDirtyFields(this).nickname = (
      trimText(profileDraft.nickname) !== trimText(this.data.initialDraft.nickname)
    );
    this.refreshUnsavedState(profileDraft);
  },

  refreshUnsavedState(profileDraft = this.data.profileDraft) {
    const hasUnsavedChanges = comparableDraft(profileDraft) !== comparableDraft(this.data.initialDraft);
    this.setData({ profileDraft, hasUnsavedChanges });
    this.updateUnloadAlert(hasUnsavedChanges);
  },

  updateUnloadAlert(hasUnsavedChanges) {
    if (!hasUnsavedChanges && wx.disableAlertBeforeUnload) {
      wx.disableAlertBeforeUnload();
      return;
    }
    if (hasUnsavedChanges && wx.enableAlertBeforeUnload) {
      wx.enableAlertBeforeUnload({ message: "资料尚未保存，确认离开吗？" });
    }
  },

  showTopTips(message, type = "error") {
    if (this._isPageAlive === false) return;
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
    if (this._isPageAlive === false || this.data.isSaving) return;
    if (this.data.syncState !== "ready") {
      this.showTopTips(
        this.data.syncState === "error"
          ? "请先重新同步云端资料"
          : "资料正在同步，请稍候"
      );
      return;
    }
    if (
      this.data.mode === "edit"
      && !this.data.identityGate
      && !this.data.hasUnsavedChanges
    ) return;
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

    const saveRequestId = (this._profileSaveSequence || 0) + 1;
    this._profileSaveSequence = saveRequestId;
    this._activeProfileSaveId = saveRequestId;
    // 保存以用户当前确认的草稿为准，任何迟到的刷新都不能再覆盖它。
    this._profileSyncSequence = (this._profileSyncSequence || 0) + 1;
    this._activeProfileSyncId = 0;
    this.setData({ isSaving: true });
    let avatarFileId = draft.avatarFileId;
    if (!avatarFileId) {
      try {
        avatarFileId = await uploadProfileAvatar(draft.avatarLocalPath);
      } catch (error) {
        if (!isCurrentProfileSave(this, saveRequestId)) return;
        console.error("头像上传失败", error);
        this._activeProfileSaveId = 0;
        this.setData({ isSaving: false });
        this.reportProfileSetup("profile_setup_fail", "fail");
        this.showTopTips("头像上传失败，请重新选择后再试");
        return;
      }
    }

    try {
      const savedProfile = await saveProfile({ nickname, avatarFileId });
      if (!isCurrentProfileSave(this, saveRequestId)) return;
      cacheProfile(savedProfile);
      try {
        const openid = this._sessionOpenId || await fetchOpenId();
        if (!isCurrentProfileSave(this, saveRequestId)) return;
        this._sessionOpenId = openid;
        cacheCompletedProfileIdentity(openid, savedProfile);
      } catch (identityError) {
        if (!isCurrentProfileSave(this, saveRequestId)) return;
        console.warn("资料已保存，但本次身份缓存恢复失败", identityError);
      }
      if (!isCurrentProfileSave(this, saveRequestId)) return;
      const profileDraft = createDraft(savedProfile);
      this._dirtyFields = {
        nickname: false,
        avatar: false,
      };
      this._activeProfileSaveId = 0;
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
      this._returnTimer = setTimeout(() => {
        this._returnTimer = null;
        if (this._isPageAlive !== false) this.navigateBackAfterSave();
      }, 500);
    } catch (error) {
      if (!isCurrentProfileSave(this, saveRequestId)) return;
      console.error("保存个人资料失败", error);
      this._activeProfileSaveId = 0;
      this.setData({ isSaving: false });
      this.reportProfileSetup("profile_setup_fail", "fail");
      this.showTopTips(error && error.message ? error.message : "保存失败，请重试");
    }
  },

  navigateBackAfterSave() {
    if (this._isPageAlive === false) return;
    wx.navigateBack({
      fail: (error) => {
        if (this._isPageAlive === false) return;
        console.error("资料已保存但返回失败", error);
        this.showTopTips("资料已保存，请返回继续操作");
      },
    });
  },
});
