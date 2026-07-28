import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(__dirname, "../miniprogram/miniprogram/utils/userService.js");

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
        hasCompletedProfile: options.hasCompletedProfile || ((profile) => Boolean(profile && profile.nickname && profile.avatarFileId)),
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
