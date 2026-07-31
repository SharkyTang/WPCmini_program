import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/profileService.js"
);

function loadProfileService(callUserData) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(moduleName) {
      if (moduleName === "./userDataService") return { callUserData };
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {
      getStorageSync() {
        return null;
      },
      setStorageSync() {},
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, {
    filename: modulePath,
  });
  return sandbox.module.exports;
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

await test("profile completion safely rejects missing and non-object values", () => {
  const service = loadProfileService(async () => ({}));

  assert.equal(service.hasCompletedProfile(null), false);
  assert.equal(service.hasCompletedProfile(undefined), false);
  assert.equal(service.hasCompletedProfile("profile"), false);
  assert.equal(service.hasCompletedProfile(42), false);
  assert.equal(service.hasCompletedProfile([]), false);
});

await test("profile completion still requires a nickname and cloud avatar", () => {
  const service = loadProfileService(async () => ({}));

  assert.equal(service.hasCompletedProfile({}), false);
  assert.equal(
    service.hasCompletedProfile({
      nickname: "   ",
      avatarFileId: "cloud://avatar",
    }),
    false
  );
  assert.equal(
    service.hasCompletedProfile({
      nickname: "酒友",
      avatarFileId: "https://example.com/avatar.jpg",
    }),
    false
  );
  assert.equal(
    service.hasCompletedProfile({
      nickname: "酒友",
      avatarFileId: "cloud://avatar",
    }),
    true
  );
});

await test("concurrent session summary readers share one cloud request and cache it", async () => {
  let calls = 0;
  let resolveRequest;
  const service = loadProfileService((action) => {
    assert.equal(action, "getSessionSummary");
    calls += 1;
    return new Promise((resolve) => {
      resolveRequest = resolve;
    });
  });

  const first = service.fetchSessionSummary();
  const second = service.fetchSessionSummary();
  assert.equal(calls, 1);

  resolveRequest({
    openid: "openid_1",
    profile: {
      nickname: "酒友",
      avatarFileId: "cloud://avatar",
      avatarUrl: "https://avatar",
    },
    roles: {},
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.openid, "openid_1");
  assert.equal(secondResult.openid, "openid_1");
  assert.equal(calls, 1);
  assert.equal((await service.fetchSessionSummary()).openid, "openid_1");
  assert.equal(calls, 1);
});
