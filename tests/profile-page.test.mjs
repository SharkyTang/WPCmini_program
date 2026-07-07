import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/profile/index.js"
);
const wxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/profile/index.wxml"
);

function loadProfilePage(wxMock = {}, options = {}) {
  const source = readFileSync(modulePath, "utf8");
  const customerServiceModule = { exports: {} };
  vm.runInNewContext(
    readFileSync(
      resolve(__dirname, "../miniprogram/miniprogram/utils/customerServiceData.js"),
      "utf8"
    ),
    { module: customerServiceModule, exports: customerServiceModule.exports },
    { filename: "customerServiceData.js" }
  );
  let pageConfig;
  const sandbox = {
    Page(config) {
      pageConfig = config;
    },
    require(moduleName) {
      if (moduleName === "../../utils/customerServiceData") {
        return customerServiceModule.exports;
      }
      if (moduleName === "../../utils/inquiryAdminService") {
        return {
          checkInquiryAdminAccess:
            options.checkInquiryAdminAccess || (async () => false),
        };
      }
      if (moduleName === "../../utils/caseAdminService") {
        return {
          checkCaseAdminAccess:
            options.checkCaseAdminAccess || (async () => false),
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    wx: {
      navigateTo() {},
      showToast() {},
      ...wxMock,
    },
  };

  vm.runInNewContext(source, sandbox, { filename: modulePath });
  pageConfig.setData = function setData(nextData) {
    this.data = {
      ...this.data,
      ...nextData,
    };
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

await test("profile quick actions include feedback with image icon paths", () => {
  const page = loadProfilePage();
  const actions = page.data.quickActions;

  assert.deepEqual(plain(actions.map((action) => action.key)), [
    "favorites",
    "history",
    "notice",
    "service",
    "feedback",
  ]);
  assert.deepEqual(plain(actions.map((action) => action.iconSrc)), [
    "/assets/profile/icon-favorite.png",
    "/assets/profile/icon-history.png",
    "/assets/profile/icon-notice.png",
    "/assets/profile/icon-service.png",
    "/assets/profile/icon-feedback.png",
  ]);
});

await test("feedback quick action navigates to feedback page", () => {
  let navigatedUrl = "";

  const page = loadProfilePage({
    navigateTo(options) {
      navigatedUrl = options.url;
    },
  });

  page.handleQuickAction({ currentTarget: { dataset: { key: "feedback" } } });

  assert.equal(navigatedUrl, "/pages/feedback/index?source=profile");
});

await test("profile inquiry button navigates to inquiry page", () => {
  let navigatedUrl = "";
  const wxml = readFileSync(wxmlPath, "utf8");

  const page = loadProfilePage({
    navigateTo(options) {
      navigatedUrl = options.url;
    },
  });

  page.openInquiryForm();

  assert.equal(wxml.includes('bindtap="openInquiryForm"'), true);
  assert.equal(wxml.includes("提交定制需求"), true);
  assert.equal(navigatedUrl, "/pages/inquiry/index?source=profile");
});

await test("service quick action uses official customer service button", () => {
  const wxml = readFileSync(wxmlPath, "utf8");

  assert.equal(wxml.includes('open-type="contact"'), true);
  assert.equal(wxml.includes('session-from="{{customerServiceSessionFrom}}"'), true);
  assert.equal(wxml.includes('bindcontact="handleContact"'), true);
});

await test("notice quick action navigates to notifications page", () => {
  let navigatedUrl = "";

  const page = loadProfilePage({
    navigateTo(options) {
      navigatedUrl = options.url;
    },
  });

  page.handleQuickAction({ currentTarget: { dataset: { key: "notice" } } });

  assert.equal(navigatedUrl, "/pages/notifications/index");
});

await test("profile card opens editor with current profile draft", () => {
  const page = loadProfilePage({
    getStorageSync() {
      return {
        nickname: "墨韵 ovo",
        avatarUrl: "/tmp/avatar.png",
      };
    },
  });

  page.onLoad();
  page.openProfileEditor();

  assert.equal(page.data.isProfileEditorVisible, true);
  assert.deepEqual(plain(page.data.profileDraft), {
    nickname: "墨韵 ovo",
    avatarUrl: "/tmp/avatar.png",
  });
});

await test("profile editor sheet does not use native avatar or nickname controls", () => {
  const wxml = readFileSync(wxmlPath, "utf8");

  assert.equal(wxml.includes('open-type="chooseAvatar"'), false);
  assert.equal(wxml.includes('type="nickname"'), false);
  assert.equal(wxml.includes("bindchooseavatar"), false);
  assert.equal(wxml.includes("bindblur=\"onNicknameBlur\""), false);
});

await test("choosing avatar from album updates and stores profile draft", () => {
  let chooseMediaOptions;
  let storedValue;
  const page = loadProfilePage({
    chooseMedia(options) {
      chooseMediaOptions = options;
      options.success({
        tempFiles: [{ tempFilePath: "/tmp/album-avatar.png" }],
      });
    },
    setStorageSync(key, value) {
      storedValue = value;
    },
  });

  page.openProfileEditor();
  page.chooseProfileAvatarFromAlbum();

  assert.deepEqual(plain(chooseMediaOptions.sourceType), ["album"]);
  assert.deepEqual(plain(chooseMediaOptions.mediaType), ["image"]);
  assert.equal(page.data.profileDraft.avatarUrl, "/tmp/album-avatar.png");
  assert.equal(page.data.profileInfo.avatarUrl, "/tmp/album-avatar.png");
  assert.deepEqual(plain(storedValue), {
    nickname: "微信名称",
    avatarUrl: "/tmp/album-avatar.png",
  });
});

await test("taking profile photo uses camera source and stores profile draft", () => {
  let chooseMediaOptions;
  let storedValue;
  const page = loadProfilePage({
    chooseMedia(options) {
      chooseMediaOptions = options;
      options.success({
        tempFiles: [{ tempFilePath: "/tmp/camera-avatar.png" }],
      });
    },
    setStorageSync(key, value) {
      storedValue = value;
    },
  });

  page.openProfileEditor();
  page.takeProfileAvatarPhoto();

  assert.equal(page.data.isProfileEditorVisible, true);
  assert.deepEqual(plain(chooseMediaOptions.sourceType), ["camera"]);
  assert.deepEqual(plain(chooseMediaOptions.mediaType), ["image"]);
  assert.equal(page.data.profileDraft.avatarUrl, "/tmp/camera-avatar.png");
  assert.equal(page.data.profileInfo.avatarUrl, "/tmp/camera-avatar.png");
  assert.deepEqual(plain(storedValue), {
    nickname: "微信名称",
    avatarUrl: "/tmp/camera-avatar.png",
  });
});

await test("profile shows inquiry admin entry only for admins", async () => {
  let navigatedUrl = "";
  const wxml = readFileSync(wxmlPath, "utf8");
  const page = loadProfilePage(
    {
      navigateTo(options) {
        navigatedUrl = options.url;
      },
    },
    {
      checkInquiryAdminAccess: async () => true,
    }
  );

  await page.refreshInquiryAdminAccess();
  page.openInquiryAdmin();

  assert.equal(wxml.includes("hasInquiryAdminAccess"), true);
  assert.equal(wxml.includes("需求管理"), true);
  assert.equal(page.data.hasInquiryAdminAccess, true);
  assert.equal(navigatedUrl, "/pages/inquiry-admin/index");
});

await test("profile shows case admin entry only for admins", async () => {
  let navigatedUrl = "";
  const wxml = readFileSync(wxmlPath, "utf8");
  const page = loadProfilePage(
    {
      navigateTo(options) {
        navigatedUrl = options.url;
      },
    },
    {
      checkCaseAdminAccess: async () => true,
    }
  );

  await page.refreshCaseAdminAccess();
  page.openCaseAdmin();

  assert.equal(wxml.includes("hasCaseAdminAccess"), true);
  assert.equal(wxml.includes("案例管理"), true);
  assert.equal(page.data.hasCaseAdminAccess, true);
  assert.equal(navigatedUrl, "/pages/case-admin/index");
});
