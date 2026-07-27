import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/detail/index.wxml"
);
const jsonPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/detail/index.json"
);
const wxssPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/detail/index.wxss"
);

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("detail page exposes one clear return action for unavailable cases", () => {
  const wxml = readFileSync(wxmlPath, "utf8");

  assert.equal(wxml.includes("返回继续筛选"), false);
  assert.equal(wxml.includes("返回案例库"), true);
});

test("detail consult action opens official customer service", () => {
  const wxml = readFileSync(wxmlPath, "utf8");

  assert.equal(wxml.includes('open-type="contact"'), true);
  assert.equal(wxml.includes('session-from="{{customerServiceSessionFrom}}"'), true);
  assert.equal(wxml.includes('bindcontact="handleContact"'), true);
  assert.equal(wxml.includes('bindtap="showConsultTip"'), false);
});

test("detail page keeps customer service and adds inquiry action", () => {
  const wxml = readFileSync(wxmlPath, "utf8");

  assert.equal(wxml.includes("咨询同款包装方案"), true);
  assert.equal(wxml.includes("提交定制需求"), true);
  assert.equal(wxml.includes('bindtap="openInquiryForm"'), true);
});

test("detail page supports a gallery and downloads the selected image", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const source = readFileSync(resolve(__dirname, "../miniprogram/miniprogram/pages/detail/index.js"), "utf8");

  assert.equal(wxml.includes('bindchange="onGalleryChange"'), true);
  assert.equal(wxml.includes('bindtap="selectGalleryImage"'), true);
  assert.equal(source.includes("currentImageUrl"), true);
});

test("detail page uses branded states and removes developer-facing copy", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const pageJson = JSON.parse(readFileSync(jsonPath, "utf8"));

  assert.equal(pageJson.usingComponents["mp-msg"], "weui-miniprogram/msg/msg");
  assert.equal(wxml.includes("<mp-msg"), true);
  assert.equal(wxml.includes("产品卡片点击后进入详情确认信息"), false);
  assert.equal(wxml.includes("image-count"), true);
  assert.equal(wxml.includes("案例信息"), true);
});

test("detail page removes the top copy and aligns its title with case information", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const wxss = readFileSync(wxssPath, "utf8");

  assert.equal(wxml.includes("hero-copy"), false);
  assert.equal(wxml.includes("CASE INFORMATION"), false);
  assert.equal(wxml.includes("info-card-head"), true);
  assert.equal(wxml.includes("{{caseItem.title}}"), true);
  assert.match(
    wxss,
    /\.info-card-head\s*\{[\s\S]*?grid-template-columns:\s*150rpx minmax\(0,\s*1fr\);/
  );
  assert.match(wxss, /\.info-case-title\s*\{[\s\S]*?text-align:\s*left;/);
  assert.match(wxss, /\.consult-button,\s*\.inquiry-button\s*\{[\s\S]*?min-height:\s*100rpx;/);
  assert.match(
    wxss,
    /\.consult-contact-button\s*\{[\s\S]*?min-width:\s*100%;[\s\S]*?max-width:\s*100%;/
  );
});
