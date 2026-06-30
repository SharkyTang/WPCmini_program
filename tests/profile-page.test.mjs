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

function loadProfilePage(wxMock = {}) {
  const source = readFileSync(modulePath, "utf8");
  let pageConfig;
  const sandbox = {
    Page(config) {
      pageConfig = config;
    },
    wx: {
      navigateTo() {},
      showToast() {},
      ...wxMock,
    },
  };

  vm.runInNewContext(source, sandbox, { filename: modulePath });
  return pageConfig;
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("profile quick actions include feedback with image icon paths", () => {
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

test("feedback quick action does not navigate", () => {
  let page;
  let navigated = false;
  let toastTitle = "";

  page = loadProfilePage({
    navigateTo() {
      navigated = true;
    },
    showToast(options) {
      toastTitle = options.title;
    },
  });

  page.handleQuickAction({ currentTarget: { dataset: { key: "feedback" } } });

  assert.equal(navigated, false);
  assert.equal(toastTitle, "入口后续开放");
});

test("notice quick action navigates to notifications page", () => {
  let navigatedUrl = "";

  const page = loadProfilePage({
    navigateTo(options) {
      navigatedUrl = options.url;
    },
  });

  page.handleQuickAction({ currentTarget: { dataset: { key: "notice" } } });

  assert.equal(navigatedUrl, "/pages/notifications/index");
});
