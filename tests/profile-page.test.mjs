import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(__dirname, "../miniprogram/miniprogram/pages/profile/index.js");
const wxmlPath = resolve(__dirname, "../miniprogram/miniprogram/pages/profile/index.wxml");

function completed(profile = {}) {
  return Boolean(profile.nickname && String(profile.avatarFileId || "").startsWith("cloud://"));
}

function loadProfilePage(wxMock = {}, options = {}) {
  const source = readFileSync(modulePath, "utf8");
  const customerServiceModule = { exports: {} };
  vm.runInNewContext(
    readFileSync(resolve(__dirname, "../miniprogram/miniprogram/utils/customerServiceData.js"), "utf8"),
    { module: customerServiceModule, exports: customerServiceModule.exports },
    { filename: "customerServiceData.js" }
  );
  let pageConfig;
  let loadingSequence = 0;
  const nativeLoadingEvents = [];
  const sandbox = {
    Page(config) { pageConfig = config; },
    require(moduleName) {
      if (moduleName === "../../utils/profileService") {
        return {
          DEFAULT_NICKNAME: "微信名称",
          cacheProfile: options.cacheProfile || (() => {}),
          fetchSessionSummary:
            options.fetchSessionSummary ||
            (async () => ({
              openid: "openid_1",
              profile: options.fetchProfile ? await options.fetchProfile() : null,
              roles: options.roles || {
                inquiryAdmin: false,
                caseAdmin: false,
                notificationAdmin: false,
              },
            })),
          getLegacyProfile: options.getLegacyProfile || (() => ({})),
          hasCompletedProfile: options.hasCompletedProfile || completed,
        };
      }
      if (moduleName === "../../utils/customerServiceData") return customerServiceModule.exports;
      if (moduleName === "../../utils/nativePageLoading") {
        return options.nativePageLoading || {
          beginPageLoading(payload) {
            const token = { id: ++loadingSequence };
            nativeLoadingEvents.push({ type: "begin", payload, token });
            return token;
          },
          finishPageLoading(token) {
            nativeLoadingEvents.push({ type: "finish", token });
            return true;
          },
          cancelPageLoading(token) {
            nativeLoadingEvents.push({ type: "cancel", token });
            return true;
          },
        };
      }
      if (moduleName === "../../utils/userService") {
        return {
          cacheCompletedProfileIdentity: options.cacheCompletedProfileIdentity || (() => {}),
          cacheOpenId: options.cacheOpenId || (() => {}),
          resumePendingProfileAction:
            options.resumePendingProfileAction ||
            (async () => false),
        };
      }
      if (moduleName === "../../utils/libraryAccessService") {
        return {
          requestLibraryAccess:
            options.requestLibraryAccess ||
            (async () => ({ status: "redirected", ready: false })),
          resumePendingLibraryAction:
            options.resumePendingLibraryAction ||
            (async () => false),
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    wx: {
      navigateTo() {},
      showToast() {},
      nextTick(callback) { callback(); },
      ...wxMock,
    },
  };
  vm.runInNewContext(source, sandbox, { filename: modulePath });
  const pendingSetDataCallbacks = [];
  pageConfig.setData = function setData(nextData, callback) {
    this.data = { ...this.data, ...nextData };
    if (!callback) return;
    if (options.deferSetDataCallbacks) {
      pendingSetDataCallbacks.push(callback);
      return;
    }
    callback();
  };
  pageConfig.__nativeLoadingEvents = nativeLoadingEvents;
  pageConfig.__flushNextSetDataCallback = () => {
    const callback = pendingSetDataCallbacks.shift();
    if (callback) callback();
  };
  pageConfig.__flushSetDataCallbacks = () => {
    while (pendingSetDataCallbacks.length) {
      pendingSetDataCallbacks.shift()();
    }
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

function plain(value) { return JSON.parse(JSON.stringify(value)); }

await test("profile quick actions include feedback with image icon paths", () => {
  const page = loadProfilePage();
  assert.deepEqual(plain(page.data.quickActions.map((action) => action.key)), [
    "favorites", "history", "notice", "service", "feedback", "contact",
  ]);
  assert.deepEqual(plain(page.data.quickActions.map((action) => action.title)), [
    "我的收藏", "浏览记录", "消息通知", "咨询客服", "意见反馈", "联系我们",
  ]);
  assert.equal(page.data.quickActions[5].iconSrc, "/assets/profile/icon-contact.png");
});

await test("profile shares the public homepage without exposing personal data", () => {
  const page = loadProfilePage();

  assert.deepEqual(plain(page.onShareAppMessage()), {
    title: "金亿诚包装科技｜酒包装灵感库",
    path: "/pages/index/index",
  });
  assert.deepEqual(plain(page.onShareTimeline()), {
    title: "金亿诚包装科技｜酒包装灵感库",
  });
});

await test("profile exposes the privacy and data management center", () => {
  let navigatedUrl = "";
  const page = loadProfilePage({
    navigateTo(options) {
      navigatedUrl = options.url;
    },
  });

  page.openPrivacyCenter();

  assert.equal(navigatedUrl, "/pages/privacy/index");
  assert.equal(
    readFileSync(wxmlPath, "utf8").includes("隐私与数据管理"),
    true
  );
});

await test("unconfigured profile card opens the setup page", async () => {
  let navigatedUrl = "";
  const page = loadProfilePage({ navigateTo(options) { navigatedUrl = options.url; } });
  await page.loadProfileInfo();
  page.openProfileEditor();
  assert.equal(navigatedUrl, "/pages/profile/edit/index?mode=setup");
  assert.equal(page.data.profileInfo.nickname, "完善个人资料");
  assert.equal(
    page.data.profileInfo.note,
    "完善头像和昵称后，可使用收藏与浏览记录"
  );
});

await test("configured cloud profile opens the independent edit page", async () => {
  let navigatedUrl = "";
  let cachedProfile = null;
  let cachedIdentity = null;
  const page = loadProfilePage(
    { navigateTo(options) { navigatedUrl = options.url; } },
    {
      fetchProfile: async () => ({ nickname: "墨韵 ovo", avatarFileId: "cloud://avatar", avatarUrl: "https://avatar" }),
      cacheProfile(profile) { cachedProfile = profile; },
      cacheCompletedProfileIdentity(openid, profile) { cachedIdentity = { openid, profile }; },
    }
  );
  await page.loadProfileInfo();
  page.openProfileEditor();
  assert.equal(navigatedUrl, "/pages/profile/edit/index?mode=edit");
  assert.equal(page.data.profileInfo.nickname, "墨韵 ovo");
  assert.equal(page.data.profileInfo.note, "点击修改头像和名称");
  assert.equal(cachedProfile.avatarFileId, "cloud://avatar");
  assert.equal(cachedIdentity.openid, "openid_1");
});

await test("completed profiles open favorites and history without the access gate", async () => {
  const navigations = [];
  let accessRequests = 0;
  const page = loadProfilePage(
    {
      navigateTo(options) {
        navigations.push(options.url);
        if (options.success) options.success({});
        if (options.complete) options.complete({});
      },
    },
    {
      fetchProfile: async () => ({
        nickname: "墨韵 ovo",
        avatarFileId: "cloud://avatar",
        avatarUrl: "https://avatar",
      }),
      requestLibraryAccess: async () => {
        accessRequests += 1;
        return { status: "redirected", ready: false };
      },
    }
  );
  await page.loadProfileInfo();

  await page.handleQuickAction({ currentTarget: { dataset: { key: "favorites" } } });
  await page.handleQuickAction({ currentTarget: { dataset: { key: "history" } } });

  assert.deepEqual(navigations, ["/pages/favorites/index", "/pages/history/index"]);
  assert.equal(accessRequests, 0);
});

await test("incomplete profiles request access with the matching resumable library target", async () => {
  const scenarios = [
    {
      key: "favorites",
      kind: "favorites",
      source: "profile_favorites",
      url: "/pages/favorites/index",
    },
    {
      key: "history",
      kind: "history",
      source: "profile_history",
      url: "/pages/history/index",
    },
  ];

  for (const scenario of scenarios) {
    let accessOptions = null;
    let navigatedUrl = "";
    const page = loadProfilePage(
      {
        navigateTo(options) {
          navigatedUrl = options.url;
          if (options.success) options.success({});
          if (options.complete) options.complete({});
        },
      },
      {
        requestLibraryAccess: async (options) => {
          accessOptions = options;
          return { status: "redirected", ready: false };
        },
      }
    );
    await page.loadProfileInfo();

    await page.handleQuickAction({
      currentTarget: { dataset: { key: scenario.key } },
    });

    assert.equal(navigatedUrl, "");
    assert.equal(accessOptions.kind, scenario.kind);
    assert.equal(accessOptions.source, scenario.source);
    await accessOptions.resume();
    assert.equal(navigatedUrl, scenario.url);
  }
});

await test("a ready access response navigates immediately when cached profile state is stale", async () => {
  let navigatedUrl = "";
  const page = loadProfilePage(
    {
      navigateTo(options) {
        navigatedUrl = options.url;
        if (options.success) options.success({});
        if (options.complete) options.complete({});
      },
    },
    {
      requestLibraryAccess: async () => ({ status: "ready", ready: true }),
    }
  );

  await page.handleQuickAction({ currentTarget: { dataset: { key: "history" } } });

  assert.equal(navigatedUrl, "/pages/history/index");
});

await test("concurrent library quick taps create only one ready navigation", async () => {
  let resolveAccess;
  let accessRequests = 0;
  let navigationCalls = 0;
  const page = loadProfilePage(
    {
      navigateTo(options) {
        navigationCalls += 1;
        if (options.success) options.success({});
        if (options.complete) options.complete({});
      },
    },
    {
      requestLibraryAccess: async () => {
        accessRequests += 1;
        return new Promise((resolve) => {
          resolveAccess = resolve;
        });
      },
    }
  );
  const event = { currentTarget: { dataset: { key: "favorites" } } };

  const first = page.handleQuickAction(event);
  const second = page.handleQuickAction(event);
  assert.equal(accessRequests, 1);
  resolveAccess({ status: "ready", ready: true });
  await Promise.all([first, second]);

  assert.equal(navigationCalls, 1);
  assert.equal(page.quickActionPendingKey, "");
});

await test("profile onShow resumes either pending library source", async () => {
  const resumedSources = [];
  const page = loadProfilePage({}, {
    resumePendingLibraryAction: async (source) => {
      resumedSources.push(source);
      return source === "profile_history";
    },
  });

  await page.onShow();

  assert.deepEqual(resumedSources, ["profile_favorites", "profile_history"]);
});

await test("profile onShow retains the legacy gate resume path when no library action is pending", async () => {
  let legacyResumeCalls = 0;
  const page = loadProfilePage({}, {
    resumePendingLibraryAction: async () => false,
    resumePendingProfileAction: async () => {
      legacyResumeCalls += 1;
      return { resumed: true, success: true };
    },
  });

  await page.onShow();

  assert.equal(legacyResumeCalls, 1);
});

await test("completed cached profile opens the editor on the first tap during refresh", async () => {
  let navigatedUrl = "";
  let resolveProfile;
  const page = loadProfilePage(
    { navigateTo(options) { navigatedUrl = options.url; } },
    {
      getLegacyProfile: () => ({
        nickname: "墨韵 ovo",
        avatarFileId: "cloud://avatar",
        avatarUrl: "https://cached-avatar",
      }),
      fetchProfile: () => new Promise((resolve) => { resolveProfile = resolve; }),
    }
  );

  const refresh = page.loadProfileInfo();
  page.openProfileEditor();
  assert.equal(navigatedUrl, "/pages/profile/edit/index?mode=edit");
  resolveProfile(null);
  await refresh;
});

await test("an authoritative incomplete cloud profile clears a stale completed fast path", async () => {
  let accessRequests = 0;
  const cachedProfiles = [];
  const page = loadProfilePage({}, {
    getLegacyProfile: () => ({
      nickname: "旧账号",
      avatarFileId: "cloud://old-avatar",
      avatarUrl: "https://old-avatar",
    }),
    fetchProfile: async () => null,
    cacheProfile(profile) {
      cachedProfiles.push(profile);
    },
    requestLibraryAccess: async () => {
      accessRequests += 1;
      return { status: "cancelled" };
    },
  });

  await page.loadProfileInfo();
  await page.handleQuickAction({
    currentTarget: { dataset: { key: "favorites" } },
  });

  assert.equal(page.data.hasCompletedProfile, false);
  assert.equal(page.data.profileInfo.nickname, "完善个人资料");
  assert.equal(
    page.data.profileInfo.note,
    "完善头像和昵称后，可使用收藏与浏览记录"
  );
  assert.equal(page.data.profileInfo.avatarUrl, "");
  assert.equal(accessRequests, 1);
  assert.deepEqual(plain(cachedProfiles), [{}]);
});

await test("profile read failures still allow users to open the setup page", async () => {
  let navigatedUrl = "";
  const page = loadProfilePage(
    { navigateTo(options) { navigatedUrl = options.url; } },
    { fetchProfile: async () => { throw new Error("offline"); } }
  );
  await page.loadProfileInfo();
  page.openProfileEditor();
  assert.equal(page.data.profileLoadError, true);
  assert.equal(navigatedUrl, "/pages/profile/edit/index?mode=setup");
});

await test("profile card removes the legacy editor sheet", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  assert.equal(wxml.includes("profile-editor-mask"), false);
  assert.equal(wxml.includes("保存资料"), false);
  assert.equal(wxml.includes('bindtap="openProfileEditor"'), true);
});

await test("profile avatar owns the non-blocking entry loading milestone", async () => {
  const profile = {
    nickname: "本地资料",
    avatarFileId: "cloud://avatar",
    avatarUrl: "https://avatar",
  };
  const page = loadProfilePage({}, {
    getLegacyProfile: () => profile,
    fetchSessionSummary: async () => ({
      openid: "openid_1",
      profile,
      roles: {
        inquiryAdmin: false,
        caseAdmin: false,
        notificationAdmin: false,
      },
    }),
  });

  await page.loadProfileInfo();
  assert.equal(page.__nativeLoadingEvents[0].type, "begin");
  assert.deepEqual(
    plain(page.__nativeLoadingEvents[0].payload),
    {
      owner: "profile-entry",
      title: "加载中",
      mask: false,
      delayMs: 120,
      minVisibleMs: 300,
      maxVisibleMs: 3000,
    }
  );
  assert.equal(
    page.__nativeLoadingEvents.some((event) => event.type === "finish"),
    false
  );

  page.onProfileAvatarLoad({
    currentTarget: { dataset: { url: "https://stale-avatar" } },
  });
  assert.equal(
    page.__nativeLoadingEvents.some((event) => event.type === "finish"),
    false
  );

  page.onProfileAvatarLoad({
    currentTarget: { dataset: { url: "https://avatar" } },
  });
  assert.equal(page.__nativeLoadingEvents.at(-1).type, "finish");
});

await test("profile hot tab return with the same avatar does not restart entry loading", async () => {
  const profile = {
    nickname: "本地资料",
    avatarFileId: "cloud://avatar",
    avatarUrl: "https://avatar",
  };
  const page = loadProfilePage({}, {
    getLegacyProfile: () => profile,
    fetchSessionSummary: async () => ({
      openid: "openid_1",
      profile,
      roles: {
        inquiryAdmin: false,
        caseAdmin: false,
        notificationAdmin: false,
      },
    }),
  });

  page.onLoad();
  await page.loadProfileInfo();
  page.onProfileAvatarLoad({
    currentTarget: { dataset: { url: "https://avatar" } },
  });
  page.onHide();
  const beginsBeforeReturn = page.__nativeLoadingEvents.filter(
    (event) => event.type === "begin"
  ).length;

  page.onShow();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    page.__nativeLoadingEvents.filter((event) => event.type === "begin").length,
    beginsBeforeReturn
  );
});

await test("profile remembers an avatar that settles while its tab is hidden", async () => {
  const profile = {
    nickname: "本地资料",
    avatarFileId: "cloud://avatar",
    avatarUrl: "https://avatar",
  };
  const page = loadProfilePage({}, {
    getLegacyProfile: () => profile,
    fetchSessionSummary: async () => ({
      openid: "openid_1",
      profile,
      roles: {
        inquiryAdmin: false,
        caseAdmin: false,
        notificationAdmin: false,
      },
    }),
  });

  page.onLoad();
  const firstLoad = page.loadProfileInfo();
  page.onHide();
  page.onProfileAvatarLoad({
    currentTarget: { dataset: { url: "https://avatar" } },
  });
  await firstLoad;
  page.onShow();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(
    page.__nativeLoadingEvents.map((event) => event.type),
    ["begin", "cancel", "begin", "finish"]
  );
});

await test("a delayed local placeholder callback cannot finish a newer remote avatar", async () => {
  const remoteProfile = {
    nickname: "云端资料",
    avatarFileId: "cloud://remote-avatar",
    avatarUrl: "https://remote-avatar",
  };
  const page = loadProfilePage({}, {
    deferSetDataCallbacks: true,
    getLegacyProfile: () => ({}),
    fetchSessionSummary: async () => ({
      openid: "openid_1",
      profile: remoteProfile,
      roles: {
        inquiryAdmin: false,
        caseAdmin: false,
        notificationAdmin: false,
      },
    }),
  });

  await page.loadProfileInfo();
  assert.deepEqual(
    page.__nativeLoadingEvents.map((event) => event.type),
    ["begin", "cancel", "begin"]
  );
  page.__flushNextSetDataCallback();
  assert.deepEqual(
    page.__nativeLoadingEvents.map((event) => event.type),
    ["begin", "cancel", "begin"]
  );
  page.__flushSetDataCallbacks();
  page.onProfileAvatarLoad({
    currentTarget: { dataset: { url: "https://remote-avatar" } },
  });
  assert.equal(page.__nativeLoadingEvents.at(-1).type, "finish");
});

await test("profile placeholder finishes quickly and page hide cancels pending avatar loading", async () => {
  const placeholderPage = loadProfilePage();
  await placeholderPage.loadProfileInfo();
  assert.deepEqual(
    placeholderPage.__nativeLoadingEvents.map((event) => event.type),
    ["begin", "finish"]
  );
  placeholderPage.onHide();
  assert.deepEqual(
    placeholderPage.__nativeLoadingEvents.map((event) => event.type),
    ["begin", "finish", "cancel"]
  );

  let resolveSummary;
  const avatarPage = loadProfilePage({}, {
    getLegacyProfile: () => ({
      nickname: "缓存资料",
      avatarFileId: "cloud://cached-avatar",
      avatarUrl: "https://cached-avatar",
    }),
    fetchSessionSummary: () => new Promise((resolve) => {
      resolveSummary = resolve;
    }),
  });
  const refresh = avatarPage.loadProfileInfo();
  avatarPage.onHide();
  resolveSummary({
    openid: "openid_1",
    profile: {
      nickname: "云端资料",
      avatarFileId: "cloud://remote-avatar",
      avatarUrl: "https://remote-avatar",
    },
    roles: {
      inquiryAdmin: false,
      caseAdmin: false,
      notificationAdmin: false,
    },
  });
  await refresh;
  assert.deepEqual(
    avatarPage.__nativeLoadingEvents.map((event) => event.type),
    ["begin", "cancel"]
  );
});

await test("profile avatar markup settles loading on success and failure", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  assert.equal(wxml.includes('bindload="onProfileAvatarLoad"'), true);
  assert.equal(wxml.includes('binderror="onProfileAvatarError"'), true);
  assert.equal(wxml.includes('data-url="{{profileInfo.avatarUrl}}"'), true);
});

await test("feedback quick action navigates to feedback page", () => {
  let navigatedUrl = "";
  const page = loadProfilePage({ navigateTo(options) { navigatedUrl = options.url; } });
  page.handleQuickAction({ currentTarget: { dataset: { key: "feedback" } } });
  assert.equal(navigatedUrl, "/pages/feedback/index?source=profile");
});

await test("contact quick action opens the public contact page", () => {
  let navigatedUrl = "";
  const page = loadProfilePage({ navigateTo(options) { navigatedUrl = options.url; } });
  page.handleQuickAction({ currentTarget: { dataset: { key: "contact" } } });
  assert.equal(navigatedUrl, "/pages/contact/index");
});

await test("service quick action keeps the official customer service button", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  assert.equal(wxml.includes('open-type="contact"'), true);
  assert.equal(wxml.includes('session-from="{{customerServiceSessionFrom}}"'), true);
  assert.equal(readFileSync(modulePath, "utf8").includes('title: "咨询客服"'), true);
});

await test("profile shows admin entries only when access is granted", async () => {
  let navigatedUrl = "";
  const page = loadProfilePage(
    { navigateTo(options) { navigatedUrl = options.url; } },
    {
      roles: {
        inquiryAdmin: true,
        caseAdmin: true,
        notificationAdmin: true,
      },
    }
  );
  await page.loadProfileInfo();
  page.openCaseAdmin();
  assert.equal(page.data.hasCaseAdminAccess, true);
  assert.equal(page.data.hasInquiryAdminAccess, true);
  assert.equal(page.data.hasNotificationAdminAccess, true);
  assert.equal(navigatedUrl, "/pages/case-admin/index");
});
