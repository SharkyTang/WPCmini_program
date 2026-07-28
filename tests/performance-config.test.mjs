import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../miniprogram");
const miniRoot = resolve(projectRoot, "miniprogram");
const appConfig = JSON.parse(
  readFileSync(resolve(miniRoot, "app.json"), "utf8")
);
const projectConfig = JSON.parse(
  readFileSync(resolve(projectRoot, "project.config.json"), "utf8")
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

test("main package keeps only the four core pages", () => {
  assert.deepEqual(appConfig.pages, [
    "pages/index/index",
    "pages/category/index",
    "pages/profile/index",
    "pages/detail/index",
  ]);
});

test("all subpackage routes resolve and admin packages are not preloaded", () => {
  const names = new Set(appConfig.subpackages.map((item) => item.name));
  appConfig.subpackages.forEach((subpackage) => {
    subpackage.pages.forEach((page) => {
      assert.equal(
        existsSync(resolve(miniRoot, subpackage.root, `${page}.js`)),
        true,
        `${subpackage.root}/${page}.js should exist`
      );
    });
  });
  const preloaded = Object.values(appConfig.preloadRule).flatMap(
    (rule) => rule.packages
  );
  assert.equal(preloaded.every((name) => names.has(name)), true);
  assert.equal(preloaded.some((name) => name.startsWith("admin-")), false);
  assert.equal(
    Object.values(appConfig.preloadRule).every((rule) => rule.network === "wifi"),
    true
  );
});

test("project keeps lazy loading, audits and system-file exclusion enabled", () => {
  assert.equal(appConfig.lazyCodeLoading, "requiredComponents");
  assert.equal(projectConfig.setting.autoAudits, true);
  assert.equal(projectConfig.setting.minified, true);
  assert.equal(
    projectConfig.packOptions.ignore.some(
      (item) => item.type === "glob" && item.value === "**/.DS_Store"
    ),
    true
  );
  assert.notEqual(projectConfig.libVersion, "2.21.2");
});

test("profile page no longer imports admin service bundles", () => {
  const source = readFileSync(resolve(miniRoot, "pages/profile/index.js"), "utf8");
  assert.equal(source.includes("inquiryAdminService"), false);
  assert.equal(source.includes("caseAdminService"), false);
  assert.equal(source.includes("notificationAdminService"), false);
  assert.equal(source.includes("fetchSessionSummary"), true);
});

test("subpackage-only services are no longer stored in the main utils directory", () => {
  [
    "caseAdminService.js",
    "feedbackService.js",
    "inquiryAdminService.js",
    "inquiryService.js",
    "notificationAdminService.js",
    "notificationService.js",
  ].forEach((fileName) => {
    assert.equal(existsSync(resolve(miniRoot, "utils", fileName)), false);
  });
});
