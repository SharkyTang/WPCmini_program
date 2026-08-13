import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(__dirname, "../miniprogram/miniprogram/pages/profile/edit/index.js");
const wxmlPath = resolve(__dirname, "../miniprogram/miniprogram/pages/profile/edit/index.wxml");
const jsonPath = resolve(__dirname, "../miniprogram/miniprogram/pages/profile/edit/index.json");

function loadEditPage(wxMock = {}, service = {}) {
  let pageConfig;
  const sandbox = {
    Page(config) { pageConfig = config; },
    require(moduleName) {
      if (moduleName === "../../../utils/profileService") {
        return {
          cacheProfile: service.cacheProfile || (() => {}),
          fetchSessionSummary:
            service.fetchSessionSummary
            || (async () => ({
              openid: "openid_1",
              profile: service.fetchProfile ? await service.fetchProfile() : null,
              roles: {},
            })),
          getLegacyProfile: service.getLegacyProfile || (() => ({})),
          hasCompletedProfile:
            service.hasCompletedProfile ||
            ((profile) => Boolean(
              profile
              && profile.nickname
              && String(profile.avatarFileId || "").startsWith("cloud://")
            )),
          saveProfile: service.saveProfile || (async (profile) => ({ ...profile, avatarUrl: "https://avatar" })),
          uploadProfileAvatar: service.uploadProfileAvatar || (async () => "cloud://uploaded"),
        };
      }
      if (moduleName === "../../../utils/userService") {
        return {
          cacheCompletedProfileIdentity: service.cacheCompletedProfileIdentity || (() => {}),
          clearPendingProfileAction: service.clearPendingProfileAction || (() => {}),
          fetchOpenId: service.fetchOpenId || (async () => "openid_1"),
        };
      }
      if (moduleName === "../../../utils/libraryAccessService") {
        return {
          clearPendingLibraryAction: service.clearPendingLibraryAction || (() => {}),
          getProfileSetupCopy:
            service.getProfileSetupCopy ||
            ((source) => {
              const copies = {
                detail_favorite: {
                  source,
                  subtitle: "完善后将自动返回并收藏当前案例",
                  buttonText: "完成并收藏",
                },
                profile_favorites: {
                  source,
                  subtitle: "完善后将自动进入“我的收藏”",
                  buttonText: "完成并查看",
                },
                profile_history: {
                  source,
                  subtitle: "完善后将自动进入“浏览记录”",
                  buttonText: "完成并查看",
                },
              };
              if (!copies[source]) throw new RangeError("invalid source");
              return copies[source];
            }),
          reportLibraryEvent: service.reportLibraryEvent || (() => false),
        };
      }
      if (moduleName === "../../../utils/errorTelemetry") {
        return {
          reportPerformanceEvent: service.reportPerformanceEvent || (() => false),
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    setTimeout: service.setTimeout || ((callback) => { callback(); return 1; }),
    clearTimeout: service.clearTimeout || (() => {}),
    wx: {
      showLoading() {},
      hideLoading() {},
      showToast() {},
      navigateBack() {},
      ...wxMock,
    },
  };
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, { filename: modulePath });
  pageConfig.setData = function setData(nextData, callback) {
    this.data = { ...this.data, ...nextData };
    if (callback) callback();
  };
  return pageConfig;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function flushAsync() {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

await test("setup page exposes the native avatar chooser and nickname input", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const wxss = readFileSync(resolve(__dirname, "../miniprogram/miniprogram/pages/profile/edit/index.wxss"), "utf8");
  const pageJson = JSON.parse(readFileSync(jsonPath, "utf8"));
  assert.equal(wxml.includes("profile-header"), true);
  assert.equal(wxml.includes("profile-card-shell"), true);
  assert.equal(wxml.includes("avatar-floating"), true);
  assert.equal(wxml.includes("profile-arrow"), false);
  assert.equal(wxml.includes('open-type="chooseAvatar"'), true);
  assert.equal(wxml.includes('bindchooseavatar="onChooseWechatAvatar"'), true);
  assert.equal(wxml.includes('type="nickname"'), true);
  assert.equal(wxml.includes("从相册选择"), false);
  assert.equal(pageJson.usingComponents["mp-toptips"], "weui-miniprogram/toptips/toptips");
  assert.equal(wxml.includes("<mp-toptips"), true);
  assert.equal(wxml.includes("nickname-count"), true);
  assert.equal(wxml.includes("正在读取资料"), false);
  assert.equal(wxml.includes("isLoading"), false);
  assert.equal(wxml.includes("loadError"), false);
  assert.equal(wxml.includes('bindtap="retryProfileSync"'), true);
  assert.equal(wxml.includes('binderror="onAvatarImageError"'), true);
  assert.match(
    wxss,
    /\.profile-row-nickname\s*\{[\s\S]*?grid-template-columns:\s*100rpx minmax\(0,\s*1fr\);[\s\S]*?align-items:\s*start;/
  );
  assert.match(
    wxss,
    /\.profile-row-nickname \.profile-label\s*\{[\s\S]*?height:\s*80rpx;[\s\S]*?line-height:\s*80rpx;/
  );
});

await test("profile reports the local form milestone without another request", async () => {
  const reports = [];
  const page = loadEditPage({}, {
    getLegacyProfile: () => ({ nickname: "本地资料", avatarFileId: "cloud://local" }),
    fetchSessionSummary: async () => ({
      openid: "openid_1",
      profile: { nickname: "云端资料", avatarFileId: "cloud://remote" },
      roles: {},
    }),
    reportPerformanceEvent(name, payload) {
      reports.push({ name, payload });
      return true;
    },
  });

  page.onLoad({ mode: "edit" });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].name, "page_ready_result");
  assert.equal(reports[0].payload.stage, "local_form_visible");
  assert.equal(reports[0].payload.cacheState, "hit");
  await flushAsync();
});

await test("profile shows the local draft immediately without a mask and merges untouched remote fields", async () => {
  let resolveSummary;
  const loadingEvents = [];
  const page = loadEditPage(
    {
      showLoading(options) {
        loadingEvents.push(["show", options]);
      },
      hideLoading() {
        loadingEvents.push(["hide"]);
      },
    },
    {
      getLegacyProfile: () => ({
        nickname: "本地昵称",
        avatarFileId: "cloud://local-avatar",
        avatarUrl: "https://local-avatar",
      }),
      fetchSessionSummary: () =>
        new Promise((resolvePromise) => {
          resolveSummary = resolvePromise;
        }),
    }
  );

  page.onLoad({ mode: "edit" });
  assert.equal(page.data.profileDraft.nickname, "本地昵称");
  assert.equal(page.data.syncState, "refreshing");
  assert.deepEqual(plain(loadingEvents), []);

  page.onNicknameInput({ detail: { value: "正在输入的新昵称" } });
  resolveSummary({
    openid: "openid_1",
    profile: {
      nickname: "云端昵称",
      avatarFileId: "cloud://remote-avatar",
      avatarUrl: "https://remote-avatar",
    },
    roles: {},
  });
  await flushAsync();

  assert.equal(page.data.syncState, "ready");
  assert.equal(page.data.profileDraft.nickname, "正在输入的新昵称");
  assert.equal(page.data.profileDraft.avatarFileId, "cloud://remote-avatar");
  assert.equal(page.data.hasUnsavedChanges, true);
});

await test("a locally selected avatar survives refresh while an untouched nickname updates", async () => {
  let resolveSummary;
  const page = loadEditPage({}, {
    getLegacyProfile: () => ({
      nickname: "本地昵称",
      avatarFileId: "cloud://local-avatar",
      avatarUrl: "https://local-avatar",
    }),
    fetchSessionSummary: () => new Promise((resolvePromise) => {
      resolveSummary = resolvePromise;
    }),
  });

  page.onLoad({ mode: "edit" });
  page.onChooseWechatAvatar({ detail: { avatarUrl: "/tmp/new-avatar.png" } });
  resolveSummary({
    openid: "openid_1",
    profile: {
      nickname: "云端昵称",
      avatarFileId: "cloud://remote-avatar",
      avatarUrl: "https://remote-avatar",
    },
    roles: {},
  });
  await flushAsync();

  assert.equal(page.data.profileDraft.nickname, "云端昵称");
  assert.equal(page.data.profileDraft.avatarLocalPath, "/tmp/new-avatar.png");
  assert.equal(page.data.profileDraft.avatarFileId, "");
  assert.equal(page.data.hasUnsavedChanges, true);
});

await test("nickname and avatar edits both survive a late remote profile merge", async () => {
  let resolveSummary;
  const page = loadEditPage({}, {
    getLegacyProfile: () => ({
      nickname: "本地昵称",
      avatarFileId: "cloud://local-avatar",
      avatarUrl: "https://local-avatar",
    }),
    fetchSessionSummary: () => new Promise((resolvePromise) => {
      resolveSummary = resolvePromise;
    }),
  });

  page.onLoad({ mode: "edit" });
  page.onNicknameInput({ detail: { value: "用户新昵称" } });
  page.onChooseWechatAvatar({ detail: { avatarUrl: "/tmp/user-new-avatar.png" } });
  resolveSummary({
    openid: "openid_1",
    profile: {
      nickname: "云端昵称",
      avatarFileId: "cloud://remote-avatar",
      avatarUrl: "https://remote-avatar",
    },
    roles: {},
  });
  await flushAsync();

  assert.equal(page.data.profileDraft.nickname, "用户新昵称");
  assert.equal(page.data.profileDraft.avatarLocalPath, "/tmp/user-new-avatar.png");
  assert.equal(page.data.profileDraft.avatarFileId, "");
  assert.deepEqual(plain(page._dirtyFields), { nickname: true, avatar: true });
  assert.equal(page.data.hasUnsavedChanges, true);
});

await test("restoring nickname and avatar to their baseline clears both dirty flags", () => {
  const page = loadEditPage();
  const baseline = {
    nickname: "原昵称",
    avatarFileId: "",
    avatarUrl: "/tmp/original-avatar.png",
    avatarLocalPath: "/tmp/original-avatar.png",
  };
  page.setData({
    profileDraft: { ...baseline },
    initialDraft: { ...baseline },
    hasUnsavedChanges: false,
  });

  page.onNicknameInput({ detail: { value: "临时昵称" } });
  page.onChooseWechatAvatar({ detail: { avatarUrl: "/tmp/temporary-avatar.png" } });
  assert.deepEqual(plain(page._dirtyFields), { nickname: true, avatar: true });

  page.onNicknameInput({ detail: { value: "原昵称" } });
  page.onChooseWechatAvatar({ detail: { avatarUrl: "/tmp/original-avatar.png" } });
  assert.deepEqual(plain(page._dirtyFields), { nickname: false, avatar: false });
  assert.equal(page.data.hasUnsavedChanges, false);
});

await test("avatar image errors keep the persistent avatar identity intact", () => {
  const page = loadEditPage();
  page.setData({
    profileDraft: {
      nickname: "酒友",
      avatarFileId: "cloud://avatar",
      avatarUrl: "https://expired-avatar",
      avatarLocalPath: "",
    },
  });

  page.onAvatarImageError();

  assert.equal(page.data.profileDraft.avatarUrl, "");
  assert.equal(page.data.profileDraft.avatarFileId, "cloud://avatar");
});

await test("only the latest overlapping profile sync can update the draft", async () => {
  const pendingReads = [];
  const page = loadEditPage(
    {},
    {
      fetchSessionSummary: () =>
        new Promise((resolvePromise) => {
          pendingReads.push(resolvePromise);
        }),
    }
  );

  const olderRead = page.loadProfile();
  const latestRead = page.loadProfile();

  pendingReads[1]({
    openid: "openid_1",
    profile: {
      nickname: "新资料",
      avatarFileId: "cloud://new-avatar",
      avatarUrl: "https://new-avatar",
    },
    roles: {},
  });
  await latestRead;
  assert.equal(page.data.profileDraft.nickname, "新资料");
  assert.equal(page.data.syncState, "ready");

  pendingReads[0]({
    openid: "openid_1",
    profile: {
      nickname: "旧资料",
      avatarFileId: "cloud://old-avatar",
      avatarUrl: "https://old-avatar",
    },
    roles: {},
  });
  await olderRead;
  assert.equal(page.data.profileDraft.nickname, "新资料");
});

await test("saving invalidates a profile sync that finishes after the save", async () => {
  let resolveLateSummary;
  const page = loadEditPage({}, {
    fetchSessionSummary: () => new Promise((resolvePromise) => {
      resolveLateSummary = resolvePromise;
    }),
    saveProfile: async (profile) => ({
      ...profile,
      avatarUrl: "https://saved-avatar",
    }),
  });

  const lateSync = page.loadProfile();
  page.setData({
    syncState: "ready",
    profileDraft: {
      nickname: "已保存昵称",
      avatarFileId: "cloud://saved-avatar",
      avatarUrl: "https://saved-avatar",
      avatarLocalPath: "",
    },
    initialDraft: {
      nickname: "旧昵称",
      avatarFileId: "cloud://old-avatar",
      avatarUrl: "https://old-avatar",
      avatarLocalPath: "",
    },
    hasUnsavedChanges: true,
  });

  await page.saveProfileDraft();
  resolveLateSummary({
    openid: "openid_1",
    profile: {
      nickname: "迟到的云端昵称",
      avatarFileId: "cloud://late-avatar",
      avatarUrl: "https://late-avatar",
    },
    roles: {},
  });
  await lateSync;

  assert.equal(page.data.profileDraft.nickname, "已保存昵称");
  assert.equal(page.data.profileDraft.avatarFileId, "cloud://saved-avatar");
  assert.equal(page.data.initialDraft.nickname, "已保存昵称");
  assert.equal(page.data.hasUnsavedChanges, false);
});

await test("sync failure keeps the draft, disables saving, and can be retried", async () => {
  let failureAttempts = 0;
  let saveCalls = 0;
  const failedPage = loadEditPage(
    {},
    {
      fetchSessionSummary: async () => {
        failureAttempts += 1;
        if (failureAttempts === 1) throw new Error("offline");
        return {
          openid: "openid_1",
          profile: {
            nickname: "恢复资料",
            avatarFileId: "cloud://recovered-avatar",
            avatarUrl: "https://recovered-avatar",
          },
          roles: {},
        };
      },
      saveProfile: async (profile) => {
        saveCalls += 1;
        return profile;
      },
    }
  );
  failedPage.setData({
    profileDraft: {
      nickname: "保留的本地资料",
      avatarFileId: "cloud://local-avatar",
      avatarUrl: "https://local-avatar",
      avatarLocalPath: "",
    },
    initialDraft: {
      nickname: "保留的本地资料",
      avatarFileId: "cloud://local-avatar",
      avatarUrl: "https://local-avatar",
      avatarLocalPath: "",
    },
  });
  await failedPage.loadProfile();
  assert.equal(failedPage.data.syncState, "error");
  assert.equal(failedPage.data.profileDraft.nickname, "保留的本地资料");
  await failedPage.saveProfileDraft();
  assert.equal(saveCalls, 0);
  assert.equal(failedPage.data.topTips.message, "请先重新同步云端资料");

  await failedPage.retryProfileSync();
  assert.equal(failedPage.data.syncState, "ready");
  assert.equal(failedPage.data.profileDraft.nickname, "恢复资料");
});

await test("unload invalidates a late profile sync without changing the visible draft", async () => {
  let resolveLateProfile;
  const unloadedPage = loadEditPage(
    {},
    {
      getLegacyProfile: () => ({ nickname: "本地资料" }),
      fetchSessionSummary: () =>
        new Promise((resolvePromise) => {
          resolveLateProfile = resolvePromise;
        }),
    }
  );
  unloadedPage.onLoad({ mode: "edit" });
  unloadedPage.onUnload();
  resolveLateProfile({
    openid: "openid_1",
    profile: {
      nickname: "迟到资料",
      avatarFileId: "cloud://late-avatar",
      avatarUrl: "https://late-avatar",
    },
    roles: {},
  });
  await flushAsync();
  assert.equal(unloadedPage.data.profileDraft.nickname, "本地资料");
});

await test("setup mode shows a legacy draft immediately then accepts an empty remote baseline", async () => {
  const page = loadEditPage({}, { getLegacyProfile: () => ({ nickname: "旧昵称", avatarUrl: "/tmp/avatar.jpg" }) });
  page.onLoad({ mode: "setup" });
  assert.equal(page.data.profileDraft.nickname, "旧昵称");
  await page.loadProfile();
  assert.equal(page.data.mode, "setup");
  assert.equal(page.data.pageTitle, "完善资料");
  assert.equal(page.data.profileDraft.nickname, "");
});

await test("identity gate uses the exact copy for every whitelisted source", async () => {
  const sourceCopies = {
    detail_favorite: {
      subtitle: "完善后将自动返回并收藏当前案例",
      buttonText: "完成并收藏",
    },
    profile_favorites: {
      subtitle: "完善后将自动进入“我的收藏”",
      buttonText: "完成并查看",
    },
    profile_history: {
      subtitle: "完善后将自动进入“浏览记录”",
      buttonText: "完成并查看",
    },
  };
  for (const [source, copy] of Object.entries(sourceCopies)) {
    const page = loadEditPage();
    page.onLoad({
      mode: "setup",
      identityGate: "1",
      source,
    });
    await page.loadProfile();
    assert.equal(page.data.source, source);
    assert.equal(page.data.pageSubtitle, copy.subtitle);
    assert.equal(page.data.saveButtonText, copy.buttonText);
  }

  const unknownPage = loadEditPage();
  unknownPage.onLoad({
    mode: "setup",
    identityGate: "1",
    source: "untrusted_source",
  });
  await unknownPage.loadProfile();
  assert.equal(unknownPage.data.source, "");
  assert.equal(unknownPage.data.pageSubtitle, "使用微信头像和名称，方便记录你的收藏");
});

await test("identity gate copy survives a completed profile refresh", async () => {
  const page = loadEditPage({}, {
    fetchProfile: async () => ({
      nickname: "酒友",
      avatarFileId: "cloud://avatar",
      avatarUrl: "https://avatar",
    }),
  });

  page.onLoad({
    mode: "setup",
    identityGate: "1",
    source: "detail_favorite",
  });
  await page.loadProfile();

  assert.equal(page.data.pageTitle, "完善资料");
  assert.equal(page.data.pageSubtitle, "完善后将自动返回并收藏当前案例");
  assert.equal(page.data.saveButtonText, "完成并收藏");
});

await test("choosing a WeChat avatar keeps it local until saving", () => {
  const page = loadEditPage();
  page.onChooseWechatAvatar({ detail: { avatarUrl: "/tmp/wechat-avatar.png" } });
  assert.equal(page.data.profileDraft.avatarLocalPath, "/tmp/wechat-avatar.png");
  assert.equal(page.data.profileDraft.avatarFileId, "");
  assert.equal(page.data.hasUnsavedChanges, true);
});

await test("saving uploads a selected avatar and persists profile data", async () => {
  let uploadInput = "";
  let savedInput = null;
  let cached = null;
  let cachedIdentity = null;
  let navigatedBack = false;
  const page = loadEditPage(
    { navigateBack() { navigatedBack = true; } },
    {
      uploadProfileAvatar: async (filePath) => { uploadInput = filePath; return "cloud://uploaded"; },
      saveProfile: async (profile) => { savedInput = profile; return { ...profile, avatarUrl: "https://avatar" }; },
      cacheProfile(profile) { cached = profile; },
      fetchOpenId: async () => "openid_1",
      cacheCompletedProfileIdentity(openid, profile) { cachedIdentity = { openid, profile }; },
    }
  );
  page.setData({
    syncState: "ready",
    profileDraft: { nickname: "酒友", avatarFileId: "", avatarUrl: "/tmp/avatar.png", avatarLocalPath: "/tmp/avatar.png" },
    initialDraft: { nickname: "", avatarFileId: "", avatarUrl: "", avatarLocalPath: "" },
    hasUnsavedChanges: true,
  });
  await page.saveProfileDraft();
  assert.equal(uploadInput, "/tmp/avatar.png");
  assert.deepEqual(JSON.parse(JSON.stringify(savedInput)), { nickname: "酒友", avatarFileId: "cloud://uploaded" });
  assert.equal(cached.avatarFileId, "cloud://uploaded");
  assert.equal(cachedIdentity.openid, "openid_1");
  assert.equal(cachedIdentity.profile.avatarFileId, "cloud://uploaded");
  assert.equal(navigatedBack, true);
});

await test("a save finishing after unload cannot mutate the page or navigate", async () => {
  let resolveSave;
  let navigateBackCalls = 0;
  const page = loadEditPage(
    {
      navigateBack() { navigateBackCalls += 1; },
    },
    {
      saveProfile: () => new Promise((resolvePromise) => {
        resolveSave = resolvePromise;
      }),
    }
  );
  page.setData({
    syncState: "ready",
    hasUnsavedChanges: true,
    profileDraft: {
      nickname: "酒友",
      avatarFileId: "cloud://avatar",
      avatarUrl: "https://avatar",
      avatarLocalPath: "",
    },
  });

  const savePromise = page.saveProfileDraft();
  page.onUnload();
  resolveSave({
    nickname: "酒友",
    avatarFileId: "cloud://avatar",
    avatarUrl: "https://avatar",
  });
  await savePromise;

  assert.equal(page.data.profileSaved, false);
  assert.equal(navigateBackCalls, 0);
});

await test("unload cancels the delayed return after a successful normal save", async () => {
  let returnCallback;
  let clearedTimer = null;
  let navigateBackCalls = 0;
  const page = loadEditPage(
    {
      navigateBack() { navigateBackCalls += 1; },
    },
    {
      setTimeout(callback) {
        returnCallback = callback;
        return 77;
      },
      clearTimeout(timerId) {
        clearedTimer = timerId;
      },
    }
  );
  page.setData({
    syncState: "ready",
    hasUnsavedChanges: true,
    profileDraft: {
      nickname: "酒友",
      avatarFileId: "cloud://avatar",
      avatarUrl: "https://avatar",
      avatarLocalPath: "",
    },
  });

  await page.saveProfileDraft();
  assert.equal(navigateBackCalls, 0);
  page.onUnload();
  assert.equal(clearedTimer, 77);
  returnCallback();
  assert.equal(navigateBackCalls, 0);
});

await test("identity gate saves without a success toast and leaves resume to the source page", async () => {
  let toastCalls = 0;
  let navigateBackCalls = 0;
  let clearCalls = 0;
  const reportedEvents = [];
  const page = loadEditPage(
    {
      showToast() { toastCalls += 1; },
      navigateBack() { navigateBackCalls += 1; },
    },
    {
      clearPendingLibraryAction() { clearCalls += 1; },
      reportLibraryEvent(eventName, payload) {
        reportedEvents.push({ eventName, payload });
        return true;
      },
    }
  );
  page.setData({
    syncState: "ready",
    identityGate: true,
    source: "profile_favorites",
    profileDraft: {
      nickname: "酒友",
      avatarFileId: "cloud://avatar",
      avatarUrl: "https://avatar",
      avatarLocalPath: "",
    },
  });

  await page.saveProfileDraft();
  page.onUnload();

  assert.equal(page.data.profileSaved, true);
  assert.equal(toastCalls, 0);
  assert.equal(navigateBackCalls, 1);
  assert.equal(clearCalls, 0);
  assert.equal(reportedEvents.length, 1);
  assert.equal(reportedEvents[0].eventName, "profile_setup_success");
  assert.equal(reportedEvents[0].payload.kind, "favorites");
  assert.equal(reportedEvents[0].payload.source, "profile_favorites");
  assert.equal(reportedEvents[0].payload.result, "success");
  assert.equal(reportedEvents[0].payload.durationMs >= 0, true);
});

await test("leaving an unsaved identity gate clears the pending library action", () => {
  let clearCalls = 0;
  let clearedSource = "";
  const page = loadEditPage({}, {
    clearPendingLibraryAction(source) {
      clearCalls += 1;
      clearedSource = source;
    },
  });
  page.setData({
    identityGate: true,
    profileSaved: false,
    source: "profile_favorites",
  });

  page.onUnload();

  assert.equal(clearCalls, 1);
  assert.equal(clearedSource, "profile_favorites");
});

await test("leaving an unsaved legacy identity gate clears the legacy pending action", () => {
  let legacyClearCalls = 0;
  const page = loadEditPage({}, {
    clearPendingProfileAction() {
      legacyClearCalls += 1;
    },
  });
  page.setData({
    identityGate: true,
    profileSaved: false,
    source: "",
  });

  page.onUnload();

  assert.equal(legacyClearCalls, 1);
});

await test("navigateBack failures keep the saved page open with recovery guidance", async () => {
  const page = loadEditPage({
    navigateBack(options) {
      options.fail(new Error("navigation failed"));
    },
  });
  page.setData({
    syncState: "ready",
    identityGate: true,
    source: "profile_history",
    profileDraft: {
      nickname: "酒友",
      avatarFileId: "cloud://avatar",
      avatarUrl: "https://avatar",
      avatarLocalPath: "",
    },
  });

  await page.saveProfileDraft();

  assert.equal(page.data.profileSaved, true);
  assert.equal(page.data.topTips.show, true);
  assert.equal(page.data.topTips.message, "资料已保存，请返回继续操作");
});

await test("identity gate reports profile save failures without clearing its pending action", async () => {
  const reportedEvents = [];
  let clearCalls = 0;
  const page = loadEditPage({}, {
    saveProfile: async () => {
      throw new Error("save failed");
    },
    clearPendingLibraryAction() { clearCalls += 1; },
    reportLibraryEvent(eventName, payload) {
      reportedEvents.push({ eventName, payload });
      return true;
    },
  });
  page.setData({
    syncState: "ready",
    identityGate: true,
    source: "profile_history",
    profileDraft: {
      nickname: "酒友",
      avatarFileId: "cloud://avatar",
      avatarUrl: "https://avatar",
      avatarLocalPath: "",
    },
  });

  await page.saveProfileDraft();

  assert.equal(page.data.profileSaved, false);
  assert.equal(page.data.topTips.message, "save failed");
  assert.equal(clearCalls, 0);
  assert.equal(reportedEvents.length, 1);
  assert.equal(reportedEvents[0].eventName, "profile_setup_fail");
  assert.equal(reportedEvents[0].payload.kind, "history");
  assert.equal(reportedEvents[0].payload.source, "profile_history");
  assert.equal(reportedEvents[0].payload.result, "fail");
  assert.equal(reportedEvents[0].payload.durationMs >= 0, true);
});

await test("profile validation uses top tips instead of a toast", async () => {
  const page = loadEditPage();
  page.setData({
    syncState: "ready",
    mode: "setup",
    profileDraft: { nickname: "", avatarFileId: "", avatarUrl: "", avatarLocalPath: "" },
  });

  await page.saveProfileDraft();

  assert.equal(page.data.topTips.show, true);
  assert.equal(page.data.topTips.message, "请输入昵称");
});
