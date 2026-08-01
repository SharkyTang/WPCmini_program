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
          fetchProfile: service.fetchProfile || (async () => null),
          getLegacyProfile: service.getLegacyProfile || (() => ({})),
          hasCompletedProfile: service.hasCompletedProfile || ((profile) => Boolean(profile.nickname && String(profile.avatarFileId || "").startsWith("cloud://"))),
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
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    setTimeout(callback) { callback(); },
    wx: {
      showLoading() {},
      hideLoading() {},
      showToast() {},
      navigateBack() {},
      ...wxMock,
    },
  };
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, { filename: modulePath });
  pageConfig.setData = function setData(nextData) { this.data = { ...this.data, ...nextData }; };
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
  assert.match(
    wxss,
    /\.profile-row-nickname\s*\{[\s\S]*?grid-template-columns:\s*100rpx minmax\(0,\s*1fr\);[\s\S]*?align-items:\s*start;/
  );
  assert.match(
    wxss,
    /\.profile-row-nickname \.profile-label\s*\{[\s\S]*?height:\s*80rpx;[\s\S]*?line-height:\s*80rpx;/
  );
});

await test("profile reads use the native WeChat loading overlay", async () => {
  let resolveProfile;
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
      fetchProfile: () =>
        new Promise((resolvePromise) => {
          resolveProfile = resolvePromise;
        }),
    }
  );

  const loadPromise = page.loadProfile();
  assert.deepEqual(plain(loadingEvents), [
    ["show", { title: "读取资料", mask: true }],
  ]);
  resolveProfile(null);
  await loadPromise;

  assert.deepEqual(plain(loadingEvents), [
    ["show", { title: "读取资料", mask: true }],
    ["hide"],
  ]);
  assert.equal(page.data.isLoading, false);
  assert.equal(page.data.loadError, false);
});

await test("profile native loading pauses while hidden and resumes if still reading", async () => {
  let resolveProfile;
  const loadingEvents = [];
  const page = loadEditPage(
    {
      showLoading() {
        loadingEvents.push("show");
      },
      hideLoading() {
        loadingEvents.push("hide");
      },
    },
    {
      fetchProfile: () =>
        new Promise((resolvePromise) => {
          resolveProfile = resolvePromise;
        }),
    }
  );

  const loadPromise = page.loadProfile();
  page.onHide();
  page.onShow();
  assert.deepEqual(loadingEvents, ["show", "hide", "show"]);

  resolveProfile(null);
  await loadPromise;
  assert.deepEqual(loadingEvents, ["show", "hide", "show", "hide"]);
});

await test("only the latest overlapping profile read can update and close loading", async () => {
  const pendingReads = [];
  const loadingEvents = [];
  const page = loadEditPage(
    {
      showLoading() {
        loadingEvents.push("show");
      },
      hideLoading() {
        loadingEvents.push("hide");
      },
    },
    {
      fetchProfile: () =>
        new Promise((resolvePromise) => {
          pendingReads.push(resolvePromise);
        }),
    }
  );

  const olderRead = page.loadProfile();
  const latestRead = page.loadProfile();
  assert.deepEqual(loadingEvents, ["show"]);

  pendingReads[1]({
    nickname: "新资料",
    avatarFileId: "cloud://new-avatar",
    avatarUrl: "https://new-avatar",
  });
  await latestRead;
  assert.equal(page.data.profileDraft.nickname, "新资料");
  assert.deepEqual(loadingEvents, ["show", "hide"]);

  pendingReads[0]({
    nickname: "旧资料",
    avatarFileId: "cloud://old-avatar",
    avatarUrl: "https://old-avatar",
  });
  await olderRead;
  assert.equal(page.data.profileDraft.nickname, "新资料");
  assert.deepEqual(loadingEvents, ["show", "hide"]);
});

await test("profile retry and unload both close native loading safely", async () => {
  let failureAttempts = 0;
  const failureEvents = [];
  const failedPage = loadEditPage(
    {
      showLoading() {
        failureEvents.push("show");
      },
      hideLoading() {
        failureEvents.push("hide");
      },
    },
    {
      fetchProfile: async () => {
        failureAttempts += 1;
        if (failureAttempts === 1) throw new Error("offline");
        return {
          nickname: "恢复资料",
          avatarFileId: "cloud://recovered-avatar",
          avatarUrl: "https://recovered-avatar",
        };
      },
    }
  );
  await failedPage.loadProfile();
  assert.equal(failedPage.data.loadError, true);
  assert.deepEqual(failureEvents, ["show", "hide"]);
  await failedPage.loadProfile();
  assert.equal(failedPage.data.loadError, false);
  assert.equal(failedPage.data.profileDraft.nickname, "恢复资料");
  assert.deepEqual(failureEvents, ["show", "hide", "show", "hide"]);

  let resolveLateProfile;
  const unloadEvents = [];
  const unloadedPage = loadEditPage(
    {
      showLoading() {
        unloadEvents.push("show");
      },
      hideLoading() {
        unloadEvents.push("hide");
      },
    },
    {
      getLegacyProfile: () => ({ nickname: "本地资料" }),
      fetchProfile: () =>
        new Promise((resolvePromise) => {
          resolveLateProfile = resolvePromise;
        }),
    }
  );
  const lateRead = unloadedPage.loadProfile();
  unloadedPage.onUnload();
  assert.deepEqual(unloadEvents, ["show", "hide"]);
  resolveLateProfile({
    nickname: "迟到资料",
    avatarFileId: "cloud://late-avatar",
    avatarUrl: "https://late-avatar",
  });
  await lateRead;
  assert.equal(unloadedPage.data.profileDraft.nickname, "本地资料");
  assert.deepEqual(unloadEvents, ["show", "hide"]);
});

await test("setup mode uses a legacy nickname as a draft without treating it as completed", async () => {
  const page = loadEditPage({}, { getLegacyProfile: () => ({ nickname: "旧昵称", avatarUrl: "/tmp/avatar.jpg" }) });
  page.onLoad({ mode: "setup" });
  await page.loadProfile();
  assert.equal(page.data.mode, "setup");
  assert.equal(page.data.pageTitle, "完善资料");
  assert.equal(page.data.profileDraft.nickname, "旧昵称");
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
    profileDraft: { nickname: "酒友", avatarFileId: "", avatarUrl: "/tmp/avatar.png", avatarLocalPath: "/tmp/avatar.png" },
    initialDraft: { nickname: "", avatarFileId: "", avatarUrl: "", avatarLocalPath: "" },
  });
  await page.saveProfileDraft();
  assert.equal(uploadInput, "/tmp/avatar.png");
  assert.deepEqual(JSON.parse(JSON.stringify(savedInput)), { nickname: "酒友", avatarFileId: "cloud://uploaded" });
  assert.equal(cached.avatarFileId, "cloud://uploaded");
  assert.equal(cachedIdentity.openid, "openid_1");
  assert.equal(cachedIdentity.profile.avatarFileId, "cloud://uploaded");
  assert.equal(navigatedBack, true);
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
    profileDraft: { nickname: "", avatarFileId: "", avatarUrl: "", avatarLocalPath: "" },
  });

  await page.saveProfileDraft();

  assert.equal(page.data.topTips.show, true);
  assert.equal(page.data.topTips.message, "请输入昵称");
});
