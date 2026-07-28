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
      if (moduleName === "../../utils/userService") {
        return {
          cacheCompletedProfileIdentity: options.cacheCompletedProfileIdentity || (() => {}),
          cacheOpenId: options.cacheOpenId || (() => {}),
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    wx: { navigateTo() {}, showToast() {}, ...wxMock },
  };
  vm.runInNewContext(source, sandbox, { filename: modulePath });
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

function plain(value) { return JSON.parse(JSON.stringify(value)); }

await test("profile quick actions include feedback with image icon paths", () => {
  const page = loadProfilePage();
  assert.deepEqual(plain(page.data.quickActions.map((action) => action.key)), [
    "favorites", "history", "notice", "service", "feedback",
  ]);
});

await test("unconfigured profile card opens the setup page", async () => {
  let navigatedUrl = "";
  const page = loadProfilePage({ navigateTo(options) { navigatedUrl = options.url; } });
  await page.loadProfileInfo();
  page.openProfileEditor();
  assert.equal(navigatedUrl, "/pages/profile/edit/index?mode=setup");
  assert.equal(page.data.profileInfo.nickname, "微信名称");
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
  assert.equal(cachedProfile.avatarFileId, "cloud://avatar");
  assert.equal(cachedIdentity.openid, "openid_1");
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

await test("feedback quick action navigates to feedback page", () => {
  let navigatedUrl = "";
  const page = loadProfilePage({ navigateTo(options) { navigatedUrl = options.url; } });
  page.handleQuickAction({ currentTarget: { dataset: { key: "feedback" } } });
  assert.equal(navigatedUrl, "/pages/feedback/index?source=profile");
});

await test("service quick action keeps the official customer service button", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  assert.equal(wxml.includes('open-type="contact"'), true);
  assert.equal(wxml.includes('session-from="{{customerServiceSessionFrom}}"'), true);
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
