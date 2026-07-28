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
  HOME_DISPLAY_LIMITS,
  VALID_CASE_ADMIN_ACTIONS,
  buildCaseSearchText,
  buildHomepageDisplayItems,
  filterCaseItems,
  generateSequentialCaseId,
  getActivatedHomepageSlots,
  getAdminOpenidsFromEnv,
  getCaseIdNumber,
  isAdminOpenid,
  normalizeCloudFileIds,
  pickAllowedCaseFields,
  sanitizeCasePayload,
  validateHomepageDisplayCapacity,
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
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("getCaseImageUrls"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("getVisibleImageUrls"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("listHomepageDisplay"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("listRecentCases"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("createCase"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("setCaseVisibility"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("deleteCase"), true);
});

test("normalizes cloud file ids for image URL exchange", () => {
  assert.deepEqual(
    plain(normalizeCloudFileIds([" cloud://env/a.jpg ", "/tmp/a.jpg", "cloud://env/a.jpg", ""])),
    ["cloud://env/a.jpg"]
  );
  assert.equal(normalizeCloudFileIds(Array.from({ length: 55 }, (_, index) => `cloud://env/${index}`)).length, 50);
});

test("keeps only writable case fields", () => {
  const picked = pickAllowedCaseFields({
    title: "案例",
    coverImage: "cloud://cloud1/file.jpg",
    galleryImages: ["cloud://cloud1/file.jpg", "cloud://cloud1/detail.jpg"],
    isPinned: true,
    homeSections: ["popular"],
    _openid: "hacker",
    createdAt: "bad",
    updatedByOpenid: "bad",
  });

  assert.deepEqual(plain(Object.keys(picked)), ["title", "coverImage", "galleryImages", "homeSections", "isPinned"]);
  assert.equal(ALLOWED_CASE_FIELDS.includes("_openid"), false);
  assert.equal(ALLOWED_CASE_FIELDS.includes("homeSections"), true);
});

test("uses the first gallery image as the server-side cover", () => {
  const result = sanitizeCasePayload({
    title: "多图案例",
    galleryImages: ["cloud://cloud1/cover.jpg", "cloud://cloud1/detail.jpg"],
    packageTypes: ["礼盒"],
    isPinned: true,
  }, { isCreate: true, defaultCaseId: "case_092" });

  assert.equal(result.valid, true);
  assert.equal(result.data.coverImage, "cloud://cloud1/cover.jpg");
  assert.deepEqual(plain(result.data.galleryImages), ["cloud://cloud1/cover.jpg", "cloud://cloud1/detail.jpg"]);
  assert.equal(result.data.isPinned, true);
});

test("rejects partially generated image variant arrays", () => {
  const result = sanitizeCasePayload({
    title: "不完整图片案例",
    galleryImages: ["cloud://env/display-1.jpg", "cloud://env/display-2.jpg"],
    sourceGalleryImages: ["cloud://env/source-1.jpg", "cloud://env/source-2.jpg"],
    galleryThumbnails: ["cloud://env/thumb-1.jpg"],
    packageTypes: ["礼盒"],
  }, { isCreate: true, defaultCaseId: "case_092" });

  assert.equal(result.valid, false);
  assert.equal(result.code, "INCOMPLETE_IMAGE_VARIANTS");
});

test("sanitizes create payload with defaults and preserves visible flag", () => {
  const result = sanitizeCasePayload(
    {
      title: "  新案例  ",
      coverImage: "cloud://cloud1/file.jpg",
      packageTypes: { values: ["礼盒", "礼盒"] },
      homeSections: ["latest"],
      isVisible: true,
    },
    { isCreate: true, defaultCaseId: "case_091" }
  );

  assert.equal(result.valid, true);
  assert.equal(result.data.title, "新案例");
  assert.equal(result.data.caseId, "case_091");
  assert.equal(result.data.isVisible, true);
  assert.equal(result.data.sortOrder, 91);
  assert.deepEqual(plain(result.data.packageTypes), { values: ["礼盒"] });
  assert.deepEqual(plain(result.data.homeSections), { values: ["latest"] });
  assert.deepEqual(plain(result.data.keywords.values), ["新案例", "case_091", "白酒", "礼盒"]);
});

test("new cases stay hidden unless visible flag is explicitly enabled", () => {
  const omitted = sanitizeCasePayload(
    {
      title: "新案例",
      coverImage: "cloud://cloud1/file.jpg",
      packageTypes: ["礼盒"],
    },
    { isCreate: true, defaultCaseId: "case_091" }
  );
  const disabled = sanitizeCasePayload(
    {
      title: "新案例",
      coverImage: "cloud://cloud1/file.jpg",
      packageTypes: ["礼盒"],
      isVisible: false,
    },
    { isCreate: true, defaultCaseId: "case_091" }
  );

  assert.equal(omitted.valid, true);
  assert.equal(omitted.data.isVisible, false);
  assert.deepEqual(plain(omitted.data.homeSections), { values: [] });
  assert.equal(disabled.valid, true);
  assert.equal(disabled.data.isVisible, false);
});

test("detects homepage slots that become active", () => {
  assert.deepEqual(
    plain(getActivatedHomepageSlots(
      { isVisible: true, homeSections: { values: ["latest"] } },
      { isVisible: true, homeSections: { values: ["popular", "latest"] } }
    )),
    ["popular"]
  );
  assert.deepEqual(
    plain(getActivatedHomepageSlots(
      { isVisible: false, homeSections: { values: ["banner", "popular"] } },
      { isVisible: true, homeSections: { values: ["banner", "popular"] } }
    )),
    ["banner", "popular"]
  );
});

test("rejects homepage selections beyond their visible limits", () => {
  const popularCases = Array.from({ length: HOME_DISPLAY_LIMITS.popular }, (_, index) => ({
    _id: `popular_${index}`,
    caseId: `case_popular_${index}`,
    isVisible: true,
    sortOrder: index,
    homeSections: { values: ["popular"] },
  }));
  const candidate = {
    _id: "candidate",
    caseId: "case_candidate",
    isVisible: true,
    sortOrder: 99,
    homeSections: { values: ["popular", "latest"] },
  };

  const result = validateHomepageDisplayCapacity(popularCases, [], candidate, {
    slots: ["popular"],
  });
  assert.equal(result.valid, false);
  assert.equal(result.code, "HOME_DISPLAY_LIMIT_REACHED");
  assert.equal(result.slot, "popular");
  assert.equal(result.limit, HOME_DISPLAY_LIMITS.popular);

  const hiddenResult = validateHomepageDisplayCapacity(popularCases, [], {
    ...candidate,
    isVisible: false,
  });
  assert.equal(hiddenResult.valid, true);
});

test("keeps manual sort order when creating cases", () => {
  const result = sanitizeCasePayload(
    {
      title: "新案例",
      coverImage: "cloud://cloud1/file.jpg",
      packageTypes: ["礼盒"],
      sortOrder: "7",
    },
    { isCreate: true, defaultCaseId: "case_091" }
  );

  assert.equal(result.valid, true);
  assert.equal(result.data.caseId, "case_091");
  assert.equal(result.data.sortOrder, 7);
});

test("generates sequential case ids and ignores timestamp-like ids", () => {
  assert.equal(getCaseIdNumber("case_089"), 89);
  assert.equal(getCaseIdNumber("case_1783473800622"), 0);
  assert.equal(getCaseIdNumber("draft"), 0);
  assert.equal(
    generateSequentialCaseId([
      { caseId: "case_001" },
      { caseId: "case_089" },
      { caseId: "case_1783473800622" },
      { caseId: "draft" },
    ]),
    "case_090"
  );
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

test("builds the same limited homepage display snapshots as the homepage", () => {
  const cases = [
    { _id: "case_1", caseId: "case_001", title: "轮播案例", coverImage: "cloud://env/case-1.jpg", isVisible: true, sortOrder: 1, homeSections: { values: ["banner", "popular", "latest"] } },
    { _id: "case_2", caseId: "case_002", title: "热门案例", coverImage: "cloud://env/case-2.jpg", isVisible: true, sortOrder: 2, homeSections: { values: ["popular"] } },
    { _id: "case_banner_2", caseId: "case_banner_002", title: "案例轮播", coverImage: "cloud://env/case-banner.jpg", isVisible: true, sortOrder: 3, homeSections: { values: ["banner"] } },
    { _id: "case_3", caseId: "case_003", title: "隐藏案例", coverImage: "cloud://env/case-3.jpg", isVisible: false, sortOrder: 0, homeSections: { values: ["banner", "popular", "latest"] } },
    ...Array.from({ length: 6 }, (_, index) => ({
      _id: `latest_${index + 1}`,
      caseId: `case_latest_${index + 1}`,
      title: `最新案例 ${index + 1}`,
      coverImage: `cloud://env/latest-${index + 1}.jpg`,
      isVisible: true,
      sortOrder: index + 3,
      homeSections: { values: ["latest"] },
    })),
  ];
  const banners = [
    { _id: "banner_1", caseId: "case_001", title: "独立重复轮播", image: "cloud://env/banner-1.jpg", isVisible: true, sortOrder: 0 },
    { _id: "banner_2", title: "独立轮播", image: "cloud://env/banner-2.jpg", isVisible: true, sortOrder: 1 },
    { _id: "banner_hidden", title: "隐藏轮播", image: "cloud://env/banner-hidden.jpg", isVisible: false, sortOrder: 0 },
  ];

  const bannerItems = buildHomepageDisplayItems(cases, banners, { slot: "banner" });
  const popularItems = buildHomepageDisplayItems(cases, banners, { slot: "popular" });
  const latestItems = buildHomepageDisplayItems(cases, banners, { slot: "latest" });

  assert.equal(bannerItems.length, 3);
  assert.deepEqual(plain(bannerItems.map((item) => item.source)), ["banner", "banner", "case"]);
  assert.deepEqual(plain(bannerItems.map((item) => item.title)), ["独立重复轮播", "独立轮播", "案例轮播"]);
  assert.equal(bannerItems[0].displayOrderLabel, "第 1 张");
  assert.deepEqual(plain(popularItems.map((item) => item.caseId)), ["case_001", "case_002"]);
  assert.equal(latestItems.length, HOME_DISPLAY_LIMITS.latest);
  assert.deepEqual(plain(latestItems.map((item) => item.caseId)), [
    "case_latest_6",
    "case_latest_5",
    "case_latest_4",
    "case_latest_3",
    "case_latest_2",
    "case_latest_1",
  ]);
  assert.deepEqual(
    plain(buildHomepageDisplayItems(cases, banners, { slot: "latest", keyword: "case_001" })),
    []
  );
  const searchedLatest = buildHomepageDisplayItems(cases, banners, { slot: "latest", keyword: "最新案例 3" });
  assert.equal(searchedLatest.length, 1);
  assert.equal(searchedLatest[0].displayOrderLabel, "第 4 个");
});
