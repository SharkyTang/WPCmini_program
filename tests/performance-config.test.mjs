import assert from "node:assert/strict";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../miniprogram");
const miniRoot = resolve(projectRoot, "miniprogram");
const appConfig = JSON.parse(
  readFileSync(resolve(miniRoot, "app.json"), "utf8")
);
const projectConfig = JSON.parse(
  readFileSync(resolve(projectRoot, "project.config.json"), "utf8")
);
const BUNDLED_MEDIA_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".svg",
  ".webp",
  ".gif",
  ".flac",
  ".m4a",
  ".ogg",
  ".ape",
  ".amr",
  ".wma",
  ".wav",
  ".mp3",
  ".mp4",
  ".aac",
  ".aiff",
  ".caf",
]);

function collectFiles(directory, excludedRoots = []) {
  return readdirSync(directory).flatMap((name) => {
    const filePath = resolve(directory, name);
    if (
      excludedRoots.some(
        (root) => filePath === root || filePath.startsWith(`${root}/`)
      )
    ) {
      return [];
    }
    return statSync(filePath).isDirectory()
      ? collectFiles(filePath, excludedRoots)
      : [filePath];
  });
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
  assert.equal(names.has("account-contact"), true);
  assert.equal(preloaded.includes("account-contact"), false);
  assert.equal(names.has("admin-contact"), true);
  assert.equal(preloaded.includes("admin-contact"), false);
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
  ["store-1.jpg", "store-2.jpg", "store-3.jpg"].forEach((fileName) => {
    assert.equal(
      projectConfig.packOptions.ignore.some(
        (item) =>
          item.type === "glob" &&
          item.value === `**/pages/contact/assets/${fileName}`
      ),
      true,
      `${fileName} should not enter the production package`
    );
  });
  assert.notEqual(projectConfig.libVersion, "2.21.2");
});

test("bundled image and audio resources stay under the 200 KiB audit limit", () => {
  const mediaFiles = collectFiles(miniRoot).filter((filePath) =>
    BUNDLED_MEDIA_EXTENSIONS.has(extname(filePath).toLowerCase())
  );
  const mediaBytes = mediaFiles.reduce(
    (total, filePath) => total + statSync(filePath).size,
    0
  );
  assert.equal(
    mediaBytes < 200 * 1024,
    true,
    `bundled image and audio resources total ${mediaBytes} bytes`
  );
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

test("main package source and the new access layer stay inside their size budgets", () => {
  const subpackageRoots = appConfig.subpackages.map((item) =>
    resolve(miniRoot, item.root)
  );
  const mainPackageFiles = collectFiles(miniRoot, subpackageRoots);
  const mainPackageBytes = mainPackageFiles.reduce(
    (total, filePath) => total + statSync(filePath).size,
    0
  );
  assert.equal(
    mainPackageBytes < 350 * 1024,
    true,
    `main package source is ${mainPackageBytes} bytes`
  );

  const accessLayer = Buffer.concat([
    readFileSync(resolve(miniRoot, "utils/libraryAccessConfig.js")),
    readFileSync(resolve(miniRoot, "utils/libraryAccessService.js")),
  ]);
  const compressedAccessLayerBytes = gzipSync(accessLayer).length;
  assert.equal(
    compressedAccessLayerBytes < 10 * 1024,
    true,
    `access layer gzip size is ${compressedAccessLayerBytes} bytes`
  );
});
