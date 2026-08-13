import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pageRoot = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/privacy"
);
const modulePath = resolve(pageRoot, "index.js");
const wxml = readFileSync(resolve(pageRoot, "index.wxml"), "utf8");
const wxss = readFileSync(resolve(pageRoot, "index.wxss"), "utf8");

function loadPage(wxMock = {}) {
  let pageConfig;
  const sandbox = {
    Page(config) {
      pageConfig = config;
    },
    console,
    wx: {
      navigateTo() {},
      showToast() {},
      ...wxMock,
    },
  };
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, {
    filename: modulePath,
  });
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

await test("privacy page explains collection purposes and deletion path", async () => {
  assert.equal(wxml.includes("头像与昵称"), true);
  assert.equal(wxml.includes("收藏与浏览记录"), true);
  assert.equal(wxml.includes("需求、反馈与联系方式"), true);
  assert.equal(wxml.includes("必要的运行信息"), true);
  assert.equal(wxml.includes("申请删除其他数据"), true);
  assert.equal(wxml.includes('open-type="contact"'), true);
  assert.equal(wxml.includes("原始 OpenID"), true);
});

await test("privacy contact button centers its label without native button padding", async () => {
  assert.match(wxss, /\.contact-button\s*\{[^}]*display:\s*flex;/s);
  assert.match(wxss, /\.contact-button\s*\{[^}]*align-items:\s*center;/s);
  assert.match(wxss, /\.contact-button\s*\{[^}]*justify-content:\s*center;/s);
  assert.match(wxss, /\.contact-button\s*\{[^}]*padding:\s*0;/s);
  assert.match(wxss, /\.contact-button\s*\{[^}]*line-height:\s*1\.2;/s);
});

await test("privacy data actions only navigate to whitelisted pages", async () => {
  const navigations = [];
  const page = loadPage({
    navigateTo(options) {
      navigations.push(options.url);
    },
  });

  page.openDataAction({ currentTarget: { dataset: { key: "profile" } } });
  page.openDataAction({ currentTarget: { dataset: { key: "favorites" } } });
  page.openDataAction({ currentTarget: { dataset: { key: "history" } } });
  page.openDataAction({ currentTarget: { dataset: { key: "unknown" } } });

  assert.deepEqual(navigations, [
    "/pages/profile/edit/index?mode=edit",
    "/pages/favorites/index",
    "/pages/history/index",
  ]);
});
