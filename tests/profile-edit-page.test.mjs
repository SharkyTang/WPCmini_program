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
          resumePendingProfileAction: service.resumePendingProfileAction || (() => Promise.resolve()),
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    setTimeout(callback) { callback(); },
    wx: { showToast() {}, navigateBack() {}, ...wxMock },
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
  assert.match(
    wxss,
    /\.profile-row-nickname\s*\{[\s\S]*?grid-template-columns:\s*100rpx minmax\(0,\s*1fr\);[\s\S]*?align-items:\s*start;/
  );
  assert.match(
    wxss,
    /\.profile-row-nickname \.profile-label\s*\{[\s\S]*?height:\s*80rpx;[\s\S]*?line-height:\s*80rpx;/
  );
});

await test("setup mode uses a legacy nickname as a draft without treating it as completed", async () => {
  const page = loadEditPage({}, { getLegacyProfile: () => ({ nickname: "旧昵称", avatarUrl: "/tmp/avatar.jpg" }) });
  page.onLoad({ mode: "setup" });
  await page.loadProfile();
  assert.equal(page.data.mode, "setup");
  assert.equal(page.data.pageTitle, "完善资料");
  assert.equal(page.data.profileDraft.nickname, "旧昵称");
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
  let resumed = 0;
  let navigatedBack = false;
  const page = loadEditPage(
    { navigateBack() { navigatedBack = true; } },
    {
      uploadProfileAvatar: async (filePath) => { uploadInput = filePath; return "cloud://uploaded"; },
      saveProfile: async (profile) => { savedInput = profile; return { ...profile, avatarUrl: "https://avatar" }; },
      cacheProfile(profile) { cached = profile; },
      fetchOpenId: async () => "openid_1",
      cacheCompletedProfileIdentity(openid, profile) { cachedIdentity = { openid, profile }; },
      resumePendingProfileAction() { resumed += 1; },
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
  assert.equal(resumed, 1);
  assert.equal(navigatedBack, true);
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
