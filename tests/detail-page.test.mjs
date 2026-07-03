import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/detail/index.wxml"
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

test("detail page does not show duplicate return-to-filter button", () => {
  const wxml = readFileSync(wxmlPath, "utf8");

  assert.equal(wxml.includes("返回继续筛选"), false);
  assert.equal(wxml.includes("返回首页"), true);
});
