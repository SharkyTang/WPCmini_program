const {
  cacheProfile,
  fetchProfile,
  getLegacyProfile,
  hasCompletedProfile,
  saveProfile,
  uploadProfileAvatar,
} = require("../../../utils/profileService");

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
  },

  onLoad(options = {}) {
    const mode = options.mode === "setup" ? "setup" : "edit";
    const pageTitle = mode === "setup" ? "完善资料" : "个人资料";
    this.setData({
      mode,
      pageTitle,
      pageSubtitle: mode === "setup" ? "使用微信头像和名称，方便记录你的收藏" : "修改你的头像和名称",
    });
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: pageTitle });
    this.loadProfile();
  },

  onUnload() {
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
  },

  async loadProfile() {
    const legacyProfile = getLegacyProfile();
    const legacyDraft = createDraft({
      nickname: legacyProfile.nickname,
      avatarUrl: legacyProfile.avatarUrl,
      avatarFileId: legacyProfile.avatarFileId,
    });
    this.setData({
      profileDraft: legacyDraft,
      initialDraft: createDraft(legacyDraft),
      isLoading: true,
      loadError: false,
      hasUnsavedChanges: false,
    });

    try {
      const profile = await fetchProfile();
      if (profile && hasCompletedProfile(profile)) {
        const profileDraft = createDraft(profile);
        cacheProfile(profile);
        this.setData({
          mode: "edit",
          pageTitle: "个人资料",
          pageSubtitle: "修改你的头像和名称",
          profileDraft,
          initialDraft: createDraft(profileDraft),
        });
        if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: "个人资料" });
      }
    } catch (error) {
      console.error("读取个人资料失败", error);
      this.setData({ loadError: true });
    } finally {
      this.setData({ isLoading: false });
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

  async saveProfileDraft() {
    if (this.data.isSaving) return;
    const draft = this.data.profileDraft;
    const nickname = trimText(draft.nickname);
    if (!nickname) {
      wx.showToast({ title: "请输入昵称", icon: "none" });
      return;
    }
    if (nickname.length > 14) {
      wx.showToast({ title: "昵称最多 14 个字符", icon: "none" });
      return;
    }
    if (!draft.avatarFileId && !draft.avatarLocalPath) {
      wx.showToast({ title: "请先选择头像", icon: "none" });
      return;
    }

    this.setData({ isSaving: true });
    try {
      const avatarFileId = draft.avatarFileId || await uploadProfileAvatar(draft.avatarLocalPath);
      const savedProfile = await saveProfile({ nickname, avatarFileId });
      cacheProfile(savedProfile);
      const profileDraft = createDraft(savedProfile);
      this.setData({
        profileDraft,
        initialDraft: createDraft(profileDraft),
        hasUnsavedChanges: false,
        isSaving: false,
      });
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      wx.showToast({ title: "已保存", icon: "success" });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (error) {
      console.error("保存个人资料失败", error);
      this.setData({ isSaving: false });
      wx.showToast({
        title: error && error.message ? error.message : "保存失败，请重试",
        icon: "none",
      });
    }
  },
});
