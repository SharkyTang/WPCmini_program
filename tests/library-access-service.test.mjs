import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/libraryAccessConfig.js"
);
const servicePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/libraryAccessService.js"
);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadDefaultConfig() {
  const sandbox = {
    module: { exports: {} },
    exports: {},
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(configPath, "utf8"), sandbox, {
    filename: configPath,
  });
  return sandbox.module.exports;
}

function loadLibraryAccessService(options = {}) {
  const modes = {
    favorites: "profile",
    history: "profile",
    ...(options.modes || {}),
  };
  const modals = [];
  const navigations = [];
  const reports = [];
  let profileChecks = 0;
  let wxIdentityChecks = 0;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console: options.console || { error() {}, log() {}, warn() {} },
    Date,
    encodeURIComponent,
    require(moduleName) {
      if (moduleName === "./libraryAccessConfig") {
        return {
          LIBRARY_ACCESS_MODE: {
            PROFILE: "profile",
            OPENID: "openid",
          },
          getLibraryAccessMode(kind) {
            if (!Object.prototype.hasOwnProperty.call(modes, kind)) {
              throw new RangeError(`unsupported kind: ${kind}`);
            }
            return modes[kind] === "openid" ? "openid" : "profile";
          },
        };
      }
      if (moduleName === "./userService") {
        return {
          async ensureProfileIdentity() {
            profileChecks += 1;
            if (options.profileIdentity instanceof Error) {
              throw options.profileIdentity;
            }
            if (typeof options.profileIdentity === "function") {
              return options.profileIdentity();
            }
            return options.profileIdentity || {
              ready: true,
              openid: "openid_profile",
              profile: {
                nickname: "酒友",
                avatarFileId: "cloud://avatar",
              },
            };
          },
          async ensureWxIdentity() {
            wxIdentityChecks += 1;
            if (options.wxIdentity instanceof Error) throw options.wxIdentity;
            if (typeof options.wxIdentity === "function") {
              return options.wxIdentity();
            }
            return options.wxIdentity === undefined
              ? "openid_only"
              : options.wxIdentity;
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {
      getDeviceInfo() {
        return { platform: "ios" };
      },
      getAccountInfoSync() {
        return {
          miniProgram: {
            version: "1.2.3",
            envVersion: "develop",
          },
        };
      },
      showModal(payload) {
        modals.push(payload);
        if (options.modalFail) {
          payload.fail(options.modalFail);
          return;
        }
        const response = options.modalResult || { confirm: true, cancel: false };
        payload.success(response);
      },
      navigateTo(payload) {
        navigations.push(payload.url);
        if (options.navigationError) {
          payload.fail(options.navigationError);
          return;
        }
        payload.success({});
      },
      ...(options.withReportEvent === false
        ? {}
        : {
          reportEvent(eventName, payload) {
            if (options.reportError) throw options.reportError;
            reports.push({ eventName, payload });
          },
        }),
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(servicePath, "utf8"), sandbox, {
    filename: servicePath,
  });
  return {
    service: sandbox.module.exports,
    modals,
    navigations,
    reports,
    get profileChecks() {
      return profileChecks;
    },
    get wxIdentityChecks() {
      return wxIdentityChecks;
    },
  };
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

await test("library access flags default both capabilities to the profile gate", () => {
  const config = loadDefaultConfig();
  assert.deepEqual(plain(config.LIBRARY_ACCESS_FLAGS), {
    favoritesIdentityMode: "profile",
    historyIdentityMode: "profile",
  });
  assert.equal(config.getLibraryAccessMode("favorites"), "profile");
  assert.equal(config.getLibraryAccessMode("history"), "profile");
  assert.equal(config.getLibraryAccessMode("favorites", {}), "profile");
  assert.equal(
    config.getLibraryAccessMode("history", { historyIdentityMode: "invalid" }),
    "profile"
  );
  assert.equal(
    config.getLibraryAccessMode("favorites", { favoritesIdentityMode: "openid" }),
    "openid"
  );
  assert.throws(
    () => config.getLibraryAccessMode("unknown"),
    (error) => error && error.name === "RangeError"
  );
});

await test("profile mode returns ready without showing a prompt for completed profiles", async () => {
  const context = loadLibraryAccessService();
  const result = await context.service.requestLibraryAccess({
    kind: "favorites",
    source: "detail_favorite",
    resume() {},
  });

  assert.equal(result.status, "ready");
  assert.equal(result.ready, true);
  assert.equal(result.mode, "profile");
  assert.equal(result.openid, "openid_profile");
  assert.equal(context.modals.length, 0);
  assert.equal(context.navigations.length, 0);
});

await test("all incomplete-profile entry sources show their contextual prompt and resume once", async () => {
  const scenarios = [
    {
      kind: "favorites",
      source: "detail_favorite",
      title: "收藏当前案例",
      content: "完善头像和昵称后，可保存并跨设备查看收藏。完成后将自动返回并收藏当前案例。",
    },
    {
      kind: "favorites",
      source: "profile_favorites",
      title: "查看我的收藏",
      content: "完善头像和昵称后，可保存并跨设备查看收藏。完成后将自动进入“我的收藏”。",
    },
    {
      kind: "history",
      source: "profile_history",
      title: "查看浏览记录",
      content: "完善头像和昵称后，可记录并跨设备查看最近浏览的案例。完成后将自动进入“浏览记录”。",
    },
  ];

  for (const scenario of scenarios) {
    let resumed = 0;
    const context = loadLibraryAccessService({
      profileIdentity: {
        ready: false,
        openid: "openid_new_user",
        profile: null,
      },
    });

    const result = await context.service.requestLibraryAccess({
      kind: scenario.kind,
      source: scenario.source,
      resume() {
        resumed += 1;
      },
    });

    assert.equal(result.status, "redirected");
    assert.equal(context.modals.length, 1);
    assert.equal(context.modals[0].title, scenario.title);
    assert.equal(context.modals[0].content, scenario.content);
    assert.equal(context.modals[0].confirmText, "去完善");
    assert.equal(context.modals[0].cancelText, "暂不");
    assert.deepEqual(context.navigations, [
      `/pages/profile/edit/index?mode=setup&identityGate=1&source=${scenario.source}`,
    ]);

    assert.deepEqual(
      plain(await context.service.resumePendingLibraryAction(scenario.source)),
      { resumed: true, success: true }
    );
    assert.equal(resumed, 1);
    assert.equal(
      await context.service.resumePendingLibraryAction(scenario.source),
      false
    );
    assert.equal(resumed, 1);
  }
});

await test("openid mode only checks the WeChat identity", async () => {
  const context = loadLibraryAccessService({
    modes: { favorites: "openid" },
    profileIdentity: new Error("profile should not be checked"),
    wxIdentity: "openid_fresh",
  });
  const result = await context.service.checkLibraryAccess("favorites");

  assert.equal(result.status, "ready");
  assert.equal(result.ready, true);
  assert.equal(result.mode, "openid");
  assert.equal(result.openid, "openid_fresh");
  assert.equal(context.profileChecks, 0);
  assert.equal(context.wxIdentityChecks, 1);
});

await test("cancelling the profile prompt neither navigates nor leaves a pending action", async () => {
  let resumed = 0;
  const context = loadLibraryAccessService({
    profileIdentity: {
      ready: false,
      openid: "openid_1",
      profile: null,
    },
    modalResult: { confirm: false, cancel: true },
  });
  const result = await context.service.requestLibraryAccess({
    kind: "favorites",
    source: "detail_favorite",
    resume() {
      resumed += 1;
    },
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.ready, false);
  assert.equal(context.modals.length, 1);
  assert.equal(context.navigations.length, 0);
  assert.equal(
    await context.service.resumePendingLibraryAction("detail_favorite"),
    false
  );
  assert.equal(resumed, 0);
  assert.deepEqual(
    plain(context.reports.map(({ eventName, payload }) => ({
      eventName,
      kind: payload.kind,
      source: payload.source,
      result: payload.result,
    }))),
    [
      {
        eventName: "library_gate_view",
        kind: "favorites",
        source: "detail_favorite",
        result: "profile_required",
      },
      {
        eventName: "library_gate_cancel",
        kind: "favorites",
        source: "detail_favorite",
        result: "cancel",
      },
    ]
  );
  context.reports.forEach(({ payload }) => {
    assert.equal(typeof payload.duration_bucket, "string");
    assert.equal(payload.platform, "ios");
    assert.equal(payload.version, "1.2.3");
  });
});

await test("confirmed setup navigation resumes the matching action exactly once", async () => {
  let resumed = 0;
  const context = loadLibraryAccessService({
    profileIdentity: {
      ready: false,
      openid: "openid_1",
      profile: null,
    },
  });
  const first = context.service.requestLibraryAccess({
    kind: "favorites",
    source: "detail_favorite",
    resume() {
      resumed += 1;
    },
  });
  const second = context.service.requestLibraryAccess({
    kind: "favorites",
    source: "detail_favorite",
    resume() {
      resumed += 100;
    },
  });

  assert.equal(first, second);
  const result = await first;
  assert.equal(result.status, "redirected");
  assert.equal(context.modals.length, 1);
  assert.deepEqual(context.navigations, [
    "/pages/profile/edit/index?mode=setup&identityGate=1&source=detail_favorite",
  ]);
  assert.equal(
    await context.service.resumePendingLibraryAction("profile_favorites"),
    false
  );
  assert.equal(resumed, 0);
  assert.deepEqual(
    plain(await context.service.resumePendingLibraryAction("detail_favorite")),
    { resumed: true, success: true }
  );
  assert.equal(resumed, 1);
  assert.equal(
    await context.service.resumePendingLibraryAction("detail_favorite"),
    false
  );
  assert.equal(resumed, 1);
  assert.deepEqual(
    plain(context.reports.map((item) => item.eventName)),
    [
      "library_gate_view",
      "library_gate_confirm",
      "pending_action_resume_success",
    ]
  );
});

await test("a source-scoped clear does not clear another source's pending action", async () => {
  let resumed = 0;
  const context = loadLibraryAccessService({
    profileIdentity: {
      ready: false,
      openid: "openid_1",
      profile: null,
    },
  });
  await context.service.requestLibraryAccess({
    kind: "history",
    source: "profile_history",
    resume() {
      resumed += 1;
    },
  });

  assert.equal(
    context.service.clearPendingLibraryAction("profile_favorites"),
    false
  );
  assert.deepEqual(
    plain(await context.service.resumePendingLibraryAction("profile_history")),
    { resumed: true, success: true }
  );
  assert.equal(resumed, 1);
});

await test("access, prompt, and navigation failures are distinguishable", async () => {
  const accessFailure = loadLibraryAccessService({
    profileIdentity: new Error("offline"),
  });
  const accessResult = await accessFailure.service.requestLibraryAccess({
    kind: "favorites",
    source: "profile_favorites",
    resume() {},
  });
  assert.equal(accessResult.status, "error");
  assert.equal(accessResult.stage, "access_check");
  assert.equal(accessFailure.modals.length, 0);

  const promptFailure = loadLibraryAccessService({
    profileIdentity: { ready: false, openid: "openid_1", profile: null },
    modalFail: new Error("modal failed"),
  });
  const promptResult = await promptFailure.service.requestLibraryAccess({
    kind: "favorites",
    source: "profile_favorites",
    resume() {},
  });
  assert.equal(promptResult.status, "error");
  assert.equal(promptResult.stage, "prompt");

  const navigationFailure = loadLibraryAccessService({
    profileIdentity: { ready: false, openid: "openid_1", profile: null },
    navigationError: new Error("navigation failed"),
  });
  const navigationResult = await navigationFailure.service.requestLibraryAccess({
    kind: "history",
    source: "profile_history",
    resume() {},
  });
  assert.equal(navigationResult.status, "error");
  assert.equal(navigationResult.stage, "navigation");
  assert.equal(
    await navigationFailure.service.resumePendingLibraryAction("profile_history"),
    false
  );
});

await test("a failing pending action is cleared before execution and reported once", async () => {
  const context = loadLibraryAccessService({
    profileIdentity: { ready: false, openid: "openid_1", profile: null },
  });
  await context.service.requestLibraryAccess({
    kind: "favorites",
    source: "profile_favorites",
    resume() {
      throw new Error("resume failed");
    },
  });

  assert.deepEqual(
    plain(await context.service.resumePendingLibraryAction("profile_favorites")),
    { resumed: true, success: false }
  );
  assert.equal(
    await context.service.resumePendingLibraryAction("profile_favorites"),
    false
  );
  assert.equal(
    context.reports.filter(
      (item) => item.eventName === "pending_action_resume_fail"
    ).length,
    1
  );
});

await test("a pending action that resolves false is reported as a failed resume", async () => {
  const context = loadLibraryAccessService({
    profileIdentity: { ready: false, openid: "openid_1", profile: null },
  });
  await context.service.requestLibraryAccess({
    kind: "favorites",
    source: "detail_favorite",
    resume() {
      return false;
    },
  });

  assert.deepEqual(
    plain(await context.service.resumePendingLibraryAction("detail_favorite")),
    { resumed: true, success: false }
  );
  assert.equal(
    context.reports.filter(
      (item) => item.eventName === "pending_action_resume_fail"
    ).length,
    1
  );
  assert.equal(
    await context.service.resumePendingLibraryAction("detail_favorite"),
    false
  );
});

await test("analytics are optional, non-blocking, and only receive safe fields", async () => {
  const noReporter = loadLibraryAccessService({
    withReportEvent: false,
    profileIdentity: { ready: false, openid: "secret", profile: null },
    modalResult: { confirm: false, cancel: true },
  });
  const result = await noReporter.service.requestLibraryAccess({
    kind: "favorites",
    source: "detail_favorite",
    resume() {},
  });
  assert.equal(result.status, "cancelled");
  assert.equal(
    noReporter.service.reportLibraryEvent("library_load_result", {
      kind: "favorites",
      source: "detail_favorite",
      result: "success",
      openid: "must_not_escape",
      profile: { nickname: "must_not_escape" },
    }),
    false
  );

  const reporter = loadLibraryAccessService();
  assert.equal(
    reporter.service.reportLibraryEvent("library_load_result", {
      kind: "history",
      source: "profile_history",
      result: "success",
      openid: "must_not_escape",
    }),
    true
  );
  assert.deepEqual(plain(reporter.reports.at(-1)), {
    eventName: "library_load_result",
    payload: {
      kind: "history",
      source: "profile_history",
      result: "success",
      duration_bucket: "unknown",
      platform: "ios",
      version: "1.2.3",
    },
  });

  const throwingReporter = loadLibraryAccessService({
    reportError: new Error("reporting unavailable"),
  });
  assert.equal(
    throwingReporter.service.reportLibraryEvent("library_load_result", {
      kind: "favorites",
      source: "profile_favorites",
      result: "error",
    }),
    false
  );
});

await test("copy and request sources are strictly validated", async () => {
  const context = loadLibraryAccessService();
  assert.deepEqual(
    plain(context.service.getProfileSetupCopy("detail_favorite")),
    {
      source: "detail_favorite",
      title: "收藏当前案例",
      content: "完善头像和昵称后，可保存并跨设备查看收藏。完成后将自动返回并收藏当前案例。",
      confirmText: "去完善",
      cancelText: "暂不",
      subtitle: "完善后将自动返回并收藏当前案例",
      buttonText: "完成并收藏",
    }
  );
  assert.deepEqual(
    plain(context.service.getProfileSetupCopy("profile_favorites")),
    {
      source: "profile_favorites",
      title: "查看我的收藏",
      content: "完善头像和昵称后，可保存并跨设备查看收藏。完成后将自动进入“我的收藏”。",
      confirmText: "去完善",
      cancelText: "暂不",
      subtitle: "完善后将自动进入“我的收藏”",
      buttonText: "完成并查看",
    }
  );
  assert.deepEqual(
    plain(context.service.getProfileSetupCopy("profile_history")),
    {
      source: "profile_history",
      title: "查看浏览记录",
      content: "完善头像和昵称后，可记录并跨设备查看最近浏览的案例。完成后将自动进入“浏览记录”。",
      confirmText: "去完善",
      cancelText: "暂不",
      subtitle: "完善后将自动进入“浏览记录”",
      buttonText: "完成并查看",
    }
  );
  assert.throws(
    () => context.service.getProfileSetupCopy("unknown"),
    (error) => error && error.name === "RangeError"
  );
  assert.throws(
    () => context.service.requestLibraryAccess({
      kind: "history",
      source: "detail_favorite",
      resume() {},
    }),
    (error) => error && error.name === "RangeError"
  );
});
