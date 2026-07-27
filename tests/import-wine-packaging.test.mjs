import assert from "node:assert/strict";
import {
  buildCloudPath,
  mapCaseToWinePackagingDoc,
  parseImportArgs,
  parseEnvFile,
  resolveImagePath,
} from "../scripts/import-wine-packaging.mjs";

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("maps exported classifier records to wine_packaging documents", () => {
  const doc = mapCaseToWinePackagingDoc(
    {
      id: "case_001",
      title: "国潮礼盒",
      uploadFileName: "case_001.jpg",
      wineType: "白酒",
      packageTypes: ["礼盒", "瓶子"],
      styles: ["国潮"],
      priceLevel: "高端",
      scenes: ["送礼"],
      statuses: ["热门产品"],
      homeSections: ["popular"],
      keywords: ["白酒", "礼盒", "国潮"],
      notes: "测试备注",
      isVisible: true,
      sortOrder: 7,
    },
    "cloud://env/path/case_001.jpg"
  );

  assert.deepEqual(doc, {
    caseId: "case_001",
    title: "国潮礼盒",
    coverImage: "cloud://env/path/case_001.jpg",
    wineType: "白酒",
    packageTypes: { values: ["礼盒", "瓶子"] },
    styles: { values: ["国潮"] },
    priceLevel: "高端",
    scenes: { values: ["送礼"] },
    statuses: { values: ["热门产品"] },
    homeSections: { values: ["popular"] },
    keywords: { values: ["白酒", "礼盒", "国潮"] },
    notes: "测试备注",
    isVisible: true,
    sortOrder: 7,
  });
});

test("builds stable cloud storage paths", () => {
  assert.equal(
    buildCloudPath("wine-packaging/cases", {
      id: "case_001",
      uploadFileName: "case_001.jpg",
    }),
    "wine-packaging/cases/case_001.jpg"
  );
});

test("resolves optimized image paths from exported records", () => {
  assert.equal(
    resolveImagePath("/project/export/optimized-images", {
      uploadFileName: "case_001.jpg",
    }),
    "/project/export/optimized-images/case_001.jpg"
  );
});

test("parses import CLI arguments with safe defaults", () => {
  const args = parseImportArgs([
    "--cases",
    "export/cases.json",
    "--images",
    "export/optimized-images",
    "--env",
    "cloud1-demo",
    "--start",
    "11",
    "--limit",
    "5",
    "--dry-run",
    "--skip-existing",
  ]);

  assert.equal(args.casesPath, "export/cases.json");
  assert.equal(args.imagesDir, "export/optimized-images");
  assert.equal(args.envId, "cloud1-demo");
  assert.equal(args.start, 11);
  assert.equal(args.limit, 5);
  assert.equal(args.dryRun, true);
  assert.equal(args.skipExisting, true);
  assert.equal(args.collection, "wine_packaging");
});

test("parses local env files without exposing secret values", () => {
  assert.deepEqual(
    parseEnvFile(`
# local credentials
TENCENTCLOUD_SECRET_ID="secret-id"
TENCENTCLOUD_SECRET_KEY='secret-key'
EMPTY_VALUE=
`),
    {
      TENCENTCLOUD_SECRET_ID: "secret-id",
      TENCENTCLOUD_SECRET_KEY: "secret-key",
      EMPTY_VALUE: "",
    }
  );
});
