import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(__dirname, "../miniprogram/miniprogram/utils/userService.js");
const profileServicePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/profileService.js"
);

function loadProductionHasCompletedProfile() {
  const profileModule = { exports: {} };
  const sandbox = {
    module: profileModule,
    exports: profileModule.exports,
    require(moduleName) {
      if (moduleName === "./userDataService") {
        return {
          callUserData() {
            throw new Error("profile service data access is not used in this test");
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {},
  };
  vm.runInNewContext(readFileSync(profileServicePath, "utf8"), sandbox, {
    filename: profileServicePath,
  });
  return profileModule.exports.hasCompletedProfile;
}

const productionHasCompletedProfile = loadProductionHasCompletedProfile();

function loadUserService(options = {}) {
  const app = { globalData: {} };
  const navigations = [];
  const toasts = [];
  let modalCalls = 0;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console: options.console || { error() {}, log() {}, warn() {} },
    getApp() { return app; },
    setTimeout(callback) { callback(); },
    require(moduleName) {
      if (moduleName !== "./profileService") throw new Error(`Unexpected require: ${moduleName}`);
      return {
        fetchProfileRecord: options.fetchProfile || (async () => ({ nickname: "酒友", avatarFileId: "cloud://avatar" })),
        fetchSessionSummary:
          options.fetchSessionSummary ||
          (async () => ({
            openid: "openid_1",
            profile: options.fetchProfile
              ? await options.fetchProfile()
              : { nickname: "酒友", avatarFileId: "cloud://avatar" },
            roles: {},
          })),
        hasCompletedProfile: options.hasCompletedProfile || productionHasCompletedProfile,
      };
    },
    wx: {
      cloud: {
        callFunction: options.callFunction || (async () => ({ result: { openid: "openid_1" } })),
      },
      navigateTo(payload) {
        navigations.push(payload.url);
      },
      showToast(payload) {
        toasts.push(payload.title);
      },
      showModal() {
        modalCalls += 1;
      },
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, { filename: modulePath });
  return { app, service: sandbox.module.exports, navigations, toasts, get modalCalls() { return modalCalls; } };
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

await test("completed profiles restore OpenID without the legacy identity dialog", async () => {
  const context = loadUserService();
  const identity = await context.service.ensureProfileIdentity();

  assert.equal(identity.ready, true);
  assert.equal(identity.openid, "openid_1");
  assert.equal(context.app.globalData.openid, "openid_1");
  assert.equal(context.modalCalls, 0);
  assert.deepEqual(context.navigations, []);
});

await test("completed profile identity checks reuse the verified result without another request", async () => {
  let sessionCalls = 0;
  const context = loadUserService({
    fetchSessionSummary: async () => {
      sessionCalls += 1;
      return {
        openid: "openid_1",
        profile: { nickname: "酒友", avatarFileId: "cloud://avatar" },
        roles: {},
      };
    },
  });

  const first = await context.service.ensureProfileIdentity({
    redirectToSetup: false,
  });
  const second = await context.service.ensureProfileIdentity({
    redirectToSetup: false,
  });

  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  assert.equal(sessionCalls, 1);
});

await test("a null session profile is incomplete without becoming an identity error", async () => {
  const context = loadUserService({
    fetchSessionSummary: async () => ({
      openid: "openid_1",
      profile: null,
      roles: {},
    }),
  });

  const identity = await context.service.ensureProfileIdentity({
    redirectToSetup: false,
    showError: false,
  });

  assert.equal(identity.ready, false);
  assert.equal(identity.error, undefined);
  assert.equal(identity.openid, "openid_1");
  assert.equal(identity.profile, null);
  assert.equal(context.navigations.length, 0);
  assert.equal(context.toasts.length, 0);
});

await test("a rejected session lookup remains an explicit identity error", async () => {
  const expectedError = new Error("offline");
  const context = loadUserService({
    fetchSessionSummary: async () => {
      throw expectedError;
    },
  });

  const identity = await context.service.ensureProfileIdentity({
    redirectToSetup: false,
    showError: false,
  });

  assert.equal(identity.ready, false);
  assert.equal(identity.error, expectedError);
  assert.equal(identity.openid, "");
  assert.equal(identity.profile, null);
  assert.equal(context.navigations.length, 0);
  assert.equal(context.toasts.length, 0);
});

await test("an incomplete profile opens one setup page and resumes its pending action after saving", async () => {
  const context = loadUserService({ fetchProfile: async () => null });
  let resumed = 0;

  const [first, second] = await Promise.all([
    context.service.ensureProfileIdentity({ resume: () => { resumed += 1; } }),
    context.service.ensureProfileIdentity({ resume: () => { resumed += 1; } }),
  ]);

  assert.equal(first.ready, false);
  assert.equal(second.ready, false);
  assert.deepEqual(context.navigations, ["/pages/profile/edit/index?mode=setup&identityGate=1"]);
  await context.service.resumePendingProfileAction();
  assert.equal(resumed, 1);
});

await test("profile lookup failures do not redirect users into setup", async () => {
  const context = loadUserService({ fetchProfile: async () => { throw new Error("offline"); } });
  const identity = await context.service.ensureProfileIdentity();

  assert.equal(identity.ready, false);
  assert.equal(context.navigations.length, 0);
  assert.deepEqual(context.toasts, ["暂时无法验证资料，请重试"]);
});

await test("concurrent OpenID fetches share one cloud request", async () => {
  let calls = 0;
  let resolveCall;
  const context = loadUserService({
    callFunction: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveCall = resolve;
      });
    },
  });

  const direct = context.service.fetchOpenId();
  const ensured = context.service.ensureWxIdentity();
  const secondDirect = context.service.fetchOpenId();
  await Promise.resolve();

  assert.equal(calls, 1);
  resolveCall({ result: { openid: "openid_shared" } });
  assert.deepEqual(
    await Promise.all([direct, ensured, secondDirect]),
    ["openid_shared", "openid_shared", "openid_shared"]
  );
  assert.equal(context.app.globalData.openid, "openid_shared");
});

await test("a failed OpenID request is cleared so the next attempt can retry", async () => {
  let calls = 0;
  const context = loadUserService({
    callFunction: async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return { result: { openid: "openid_retry" } };
    },
  });

  await assert.rejects(context.service.ensureWxIdentity(), /offline/);
  assert.equal(await context.service.ensureWxIdentity(), "openid_retry");
  assert.equal(calls, 2);
});

await test("dismissing setup no longer swallows the next protected click", async () => {
  const context = loadUserService({ fetchProfile: async () => null });

  const first = await context.service.ensureProfileIdentity();
  assert.equal(first.ready, false);
  assert.equal(context.navigations.length, 1);
  context.service.clearPendingProfileAction({ dismissed: true });

  const second = await context.service.ensureProfileIdentity();
  assert.equal(second.ready, false);
  assert.equal(second.dismissed, undefined);
  assert.equal(context.navigations.length, 2);
});
