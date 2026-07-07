import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const logic = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/caseAdmin/caseAdminLogic.js"
));

const {
  ALLOWED_CASE_FIELDS,
  VALID_CASE_ADMIN_ACTIONS,
  buildCaseSearchText,
  filterCaseItems,
  getAdminOpenidsFromEnv,
  isAdminOpenid,
  pickAllowedCaseFields,
  sanitizeCasePayload,
} = logic;

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

test("checks admin openid from comma separated env value", () => {
  assert.deepEqual(plain(getAdminOpenidsFromEnv(" a, b ,, c ")), ["a", "b", "c"]);
  assert.equal(isAdminOpenid("b", "a,b,c"), true);
  assert.equal(isAdminOpenid("x", "a,b,c"), false);
});

test("declares supported case admin actions", () => {
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("checkAccess"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("createCase"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("setCaseVisibility"), true);
});

test("keeps only writable case fields", () => {
  const picked = pickAllowedCaseFields({
    title: "案例",
    coverImage: "cloud://cloud1/file.jpg",
    _openid: "hacker",
    createdAt: "bad",
    updatedByOpenid: "bad",
  });

  assert.deepEqual(plain(Object.keys(picked)), ["title", "coverImage"]);
  assert.equal(ALLOWED_CASE_FIELDS.includes("_openid"), false);
});

test("sanitizes create payload with defaults", () => {
  const result = sanitizeCasePayload(
    {
      title: "  新案例  ",
      coverImage: "cloud://cloud1/file.jpg",
      packageTypes: { values: ["礼盒", "礼盒"] },
      isVisible: true,
    },
    { isCreate: true, now: 1760000000000 }
  );

  assert.equal(result.valid, true);
  assert.equal(result.data.title, "新案例");
  assert.equal(result.data.caseId, "case_1760000000000");
  assert.equal(result.data.isVisible, false);
  assert.equal(result.data.sortOrder, 9999);
  assert.deepEqual(plain(result.data.packageTypes), { values: ["礼盒"] });
  assert.deepEqual(plain(result.data.keywords.values), ["新案例", "case_1760000000000", "白酒", "礼盒"]);
});

test("rejects invalid cover file id and missing package types", () => {
  const badImage = sanitizeCasePayload(
    {
      title: "新案例",
      coverImage: "/tmp/local.jpg",
      packageTypes: ["礼盒"],
    },
    { isCreate: true }
  );
  const missingPackage = sanitizeCasePayload(
    {
      title: "新案例",
      coverImage: "cloud://cloud1/file.jpg",
      packageTypes: [],
    },
    { isCreate: true }
  );

  assert.equal(badImage.valid, false);
  assert.equal(badImage.message, "封面图片需要先上传到云存储");
  assert.equal(missingPackage.valid, false);
  assert.equal(missingPackage.message, "请选择包装内容");
});

test("filters case items by visibility and keyword", () => {
  const items = [
    { title: "青花礼盒", caseId: "case_001", isVisible: true, packageTypes: { values: ["礼盒"] } },
    { title: "隐藏礼盒", caseId: "case_002", isVisible: false, packageTypes: { values: ["礼盒"] } },
    { title: "红色瓶标", caseId: "case_003", isVisible: true, packageTypes: { values: ["瓶标"] } },
  ];

  assert.equal(buildCaseSearchText(items[0]).includes("青花礼盒"), true);
  assert.deepEqual(
    plain(filterCaseItems(items, { visibility: "visible", keyword: "礼盒" }).map((item) => item.caseId)),
    ["case_001"]
  );
  assert.deepEqual(
    plain(filterCaseItems(items, { visibility: "hidden", keyword: "" }).map((item) => item.caseId)),
    ["case_002"]
  );
});
