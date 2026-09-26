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
  CASE_ADMIN_OPTIONS,
  CASE_GALLERY_MAX,
  HOME_DISPLAY_LIMITS,
  VALID_CASE_ADMIN_ACTIONS,
  VIDEO_DURATION_SECONDS_MAX,
  VIDEO_POSTER_UPLOAD_BYTES,
  VIDEO_UPLOAD_BYTES,
  buildBatchCasePatch,
  buildCaseSearchText,
  buildExpectedVariantPaths,
  buildPreparedVideoUpload,
  buildHomepageDisplayItems,
  filterCaseItems,
  filterCaseItemsV2,
  generateSequentialCaseId,
  getActivatedHomepageSlots,
  getAdminDisplayName,
  getAdminOpenidsFromEnv,
  getCaseIdNumber,
  hasCaseImageChanges,
  isAdminOpenid,
  isAdminActor,
  isCloudFileFromEnvironment,
  isPreparedVideoUploadFile,
  isVideoUploadFileForActor,
  isWebAdminUploadFile,
  normalizeClientMutationId,
  normalizeCloudFileIds,
  parseAdminDisplayNames,
  pickAllowedCaseFields,
  sanitizeCasePayload,
  sanitizeVideoPatch,
  sortCaseItemsV2,
  resolveAdminActor,
  validateExpectedVersion,
  validateHomepageOrders,
  validateHomepageDisplayCapacity,
  validateWebImageVariants,
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

test("resolves trusted CloudBase UIDs separately from WeChat OPENIDs", () => {
  const web = resolveAdminActor({ UID: "web-admin-1" }, {});
  const wechat = resolveAdminActor({ OPENID: "wx-admin-1", UID: "ignored" }, {});
  const none = resolveAdminActor({}, {});
  assert.deepEqual(plain(web), {
    authenticated: true,
    actor: { type: "cloudbase_uid", id: "web-admin-1" },
  });
  assert.deepEqual(plain(wechat.actor), {
    type: "wechat_openid",
    id: "wx-admin-1",
  });
  assert.equal(none.authenticated, false);
  assert.equal(isAdminActor(web.actor, { CASE_ADMIN_UIDS: "web-admin-1,web-admin-2" }), true);
  assert.equal(isAdminActor(web.actor, { CASE_ADMIN_UIDS: "other" }), false);
});

test("keeps the case-specific WeChat admin allowlist with legacy fallback", () => {
  const actor = { type: "wechat_openid", id: "wx-case-admin" };
  assert.equal(isAdminActor(actor, {
    CASE_ADMIN_OPENIDS: "wx-case-admin",
    ADMIN_OPENIDS: "legacy-admin",
  }), true);
  assert.equal(isAdminActor(actor, {
    CASE_ADMIN_OPENIDS: "other-case-admin",
    ADMIN_OPENIDS: "wx-case-admin",
  }), false);
  assert.equal(isAdminActor(actor, {
    CASE_ADMIN_OPENIDS: "",
    ADMIN_OPENIDS: "wx-case-admin",
  }), true);
});

test("parses administrator display names", () => {
  assert.deepEqual(plain(parseAdminDisplayNames(
    '{"uid-mother":"sharky","uid-owner":"administrator","blank":""}'
  )), {
    "uid-mother": "sharky",
    "uid-owner": "administrator",
  });
  assert.deepEqual(plain(parseAdminDisplayNames(
    'json:{"uid-mother":"sharky","uid-owner":"administrator"}'
  )), {
    "uid-mother": "sharky",
    "uid-owner": "administrator",
  });
  assert.deepEqual(plain(parseAdminDisplayNames("invalid-json")), {});
  assert.equal(getAdminDisplayName(
    { type: "cloudbase_uid", id: "uid-mother" },
    { CASE_ADMIN_DISPLAY_NAMES: '{"uid-mother":"sharky"}' }
  ), "sharky");
});

test("validates web upload ownership and task ids", () => {
  assert.equal(
    isWebAdminUploadFile(
      "cloud://env/wine-packaging/admin-web/web-admin-1/batch-1/source.jpg",
      "web-admin-1"
    ),
    true
  );
  assert.equal(
    isWebAdminUploadFile(
      "cloud://env/wine-packaging/admin-web/other/batch-1/source.jpg",
      "web-admin-1"
    ),
    false
  );
  assert.equal(normalizeClientMutationId("batch:item-1").valid, true);
  assert.equal(normalizeClientMutationId("../unsafe").valid, false);
});

test("binds every web image variant to its administrator-owned source", () => {
  const actor = { type: "cloudbase_uid", id: "web-admin-1" };
  const source =
    "cloud://env/wine-packaging/admin-web/web-admin-1/batch-1/source.jpg";
  const paths = buildExpectedVariantPaths(source);
  const item = {
    sourceGalleryImages: [source],
    galleryImages: [`cloud://env/${paths.displayPath}`],
    galleryThumbnails: [`cloud://env/${paths.thumbnailPath}`],
    galleryBanners: [`cloud://env/${paths.bannerPath}`],
    coverImage: `cloud://env/${paths.displayPath}`,
    coverThumbnail: `cloud://env/${paths.thumbnailPath}`,
    coverBanner: `cloud://env/${paths.bannerPath}`,
  };
  assert.equal(validateWebImageVariants(item, actor).valid, true);
  const forged = validateWebImageVariants({
    ...item,
    galleryImages: ["cloud://env/private/customer-contract.pdf"],
    coverImage: "cloud://env/private/customer-contract.pdf",
  }, actor);
  assert.equal(forged.valid, false);
  assert.equal(forged.code, "INVALID_IMAGE_VARIANTS");
  assert.equal(hasCaseImageChanges(item, { galleryImages: item.galleryImages }), false);
  assert.equal(
    hasCaseImageChanges(item, { galleryImages: ["cloud://env/other.jpg"] }),
    true
  );
});

test("declares supported case admin actions", () => {
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("checkAccess"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("getCaseImageUrls"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("getVisibleImageUrls"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("prepareVideoUpload"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("listHomepageDisplay"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("listRecentCases"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("createCase"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("setCaseVisibility"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("deleteCase"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("cleanupUnreferencedFiles"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("permanentlyDeleteCases"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("retryPurgeCleanup"), true);
  assert.equal(VALID_CASE_ADMIN_ACTIONS.includes("listPendingPurgeJobs"), true);
});

test("accepts complete v2 image arrays and rejects incomplete banners", () => {
  const base = {
    title: "v2 案例",
    packageTypes: ["礼盒"],
    galleryImages: ["cloud://env/display.jpg"],
    sourceGalleryImages: ["cloud://env/source.jpg"],
    galleryThumbnails: ["cloud://env/thumb.jpg"],
    galleryBanners: ["cloud://env/banner.jpg"],
    coverBanner: "cloud://env/banner.jpg",
    imageVariantVersion: 2,
  };
  const valid = sanitizeCasePayload(base, {
    isCreate: true,
    defaultCaseId: "case_100",
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.data.coverBanner, "cloud://env/banner.jpg");
  assert.equal(valid.data.imageVariantVersion, 2);
  const invalid = sanitizeCasePayload(
    { ...base, galleryImages: [...base.galleryImages, "cloud://env/display-2.jpg"] },
    { isCreate: true, defaultCaseId: "case_101" }
  );
  assert.equal(invalid.valid, false);
  assert.equal(invalid.code, "INCOMPLETE_IMAGE_VARIANTS");
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
    videoUrl: "https://media.example.com/case.mp4",
    videoPoster: "https://media.example.com/case.jpg",
    videoDurationSeconds: 75,
    isPinned: true,
    homeSections: ["popular"],
    _openid: "hacker",
    createdAt: "bad",
    updatedByOpenid: "bad",
  });

  assert.deepEqual(plain(Object.keys(picked)), [
    "title",
    "coverImage",
    "galleryImages",
    "homeSections",
    "isPinned",
  ]);
  assert.equal(ALLOWED_CASE_FIELDS.includes("_openid"), false);
  assert.equal(ALLOWED_CASE_FIELDS.includes("homeSections"), true);
});

test("validates atomic external, upload and clear video patches", () => {
  const accepted = sanitizeVideoPatch({
    mode: "external",
    url: "  https://media.example.com/cases/demo.mp4  ",
    posterUrl: "https://media.example.com/cases/demo.jpg",
    durationSeconds: 90.2,
  });
  assert.equal(accepted.valid, true);
  assert.deepEqual(plain(accepted.data), {
    videoFileID: "",
    videoUrl: "https://media.example.com/cases/demo.mp4",
    videoPosterFileID: "",
    videoPoster: "https://media.example.com/cases/demo.jpg",
    videoDurationSeconds: 91,
    videoFileSizeBytes: null,
  });

  const insecureUrl = sanitizeVideoPatch({
    mode: "external",
    url: "http://media.example.com/demo.mp4",
  });
  assert.equal(insecureUrl.valid, false);
  assert.equal(insecureUrl.code, "INVALID_VIDEO_URL");

  const badPoster = sanitizeVideoPatch({
    mode: "external",
    url: "https://media.example.com/demo.mp4",
    posterUrl: "https://user:secret@media.example.com/demo.jpg",
  });
  assert.equal(badPoster.valid, false);
  assert.equal(badPoster.code, "INVALID_VIDEO_URL");

  const badDuration = sanitizeVideoPatch({
    mode: "upload",
    fileID: "cloud://env/wine-packaging/videos/demo.mp4",
    durationSeconds: 120.01,
  });
  assert.equal(badDuration.valid, false);
  assert.equal(badDuration.code, "INVALID_VIDEO_DURATION");

  const upload = sanitizeVideoPatch({
    mode: "upload",
    fileID: "cloud://env/wine-packaging/videos/video.mp4",
    durationSeconds: 120,
    posterFileID: "cloud://env/wine-packaging/videos/poster.jpg",
  });
  assert.equal(upload.valid, true);
  assert.equal(upload.data.videoDurationSeconds, 120);
  assert.deepEqual(plain(upload.fileIDs), [
    "cloud://env/wine-packaging/videos/video.mp4",
    "cloud://env/wine-packaging/videos/poster.jpg",
  ]);

  const clearPatch = sanitizeVideoPatch({ mode: "clear" });
  assert.equal(clearPatch.valid, true);
  assert.deepEqual(plain(clearPatch.data), {
    videoFileID: "",
    videoUrl: "",
    videoPosterFileID: "",
    videoPoster: "",
    videoDurationSeconds: null,
    videoFileSizeBytes: null,
  });

  assert.equal(sanitizeVideoPatch(undefined).omitted, true);
  assert.equal(sanitizeVideoPatch({ mode: "unknown" }).valid, false);
  assert.equal(VIDEO_UPLOAD_BYTES, 104857600);
  assert.equal(VIDEO_POSTER_UPLOAD_BYTES, 5242880);
  assert.equal(VIDEO_DURATION_SECONDS_MAX, 120);
});

test("binds prepared video paths to one actor, case and file kind", () => {
  const actor = { type: "cloudbase_uid", id: "web-admin-1" };
  const uploadId = "a".repeat(32);
  const video = buildPreparedVideoUpload({
    actor,
    caseDocumentId: "case-doc-1",
    kind: "video",
    fileName: "demo.MP4",
    uploadId,
  });
  assert.equal(video.valid, true);
  const fileID = `cloud://current-env/${video.cloudPath}`;
  assert.equal(isPreparedVideoUploadFile(fileID, actor, "case-doc-1", "video"), true);
  assert.equal(isPreparedVideoUploadFile(fileID, actor, "case-doc-2", "video"), false);
  assert.equal(isPreparedVideoUploadFile(fileID, actor, "case-doc-1", "poster"), false);
  assert.equal(isVideoUploadFileForActor(fileID, actor), true);
  assert.equal(
    isVideoUploadFileForActor(fileID, { type: "cloudbase_uid", id: "other" }),
    false
  );
  assert.equal(isCloudFileFromEnvironment(fileID, "current-env"), true);
  assert.equal(isCloudFileFromEnvironment(fileID, "other-env"), false);
  assert.equal(isCloudFileFromEnvironment(
    "cloud://cloud1-d3gznsms746425a42.636c-cloud1-d3gznsms746425a42/wine-packaging/videos/demo.mp4",
    "cloud1-d3gznsms746425a42"
  ), true);
  assert.equal(buildPreparedVideoUpload({
    actor,
    caseDocumentId: "case-doc-1",
    kind: "video",
    fileName: "demo.mov",
    uploadId,
  }).code, "INVALID_VIDEO_FORMAT");
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

test("server accepts nine case images and rejects the tenth", () => {
  const galleryImages = Array.from(
    { length: CASE_GALLERY_MAX },
    (_, index) => `cloud://cloud1/display-${index}.jpg`
  );
  const accepted = sanitizeCasePayload({
    title: "九图案例",
    galleryImages,
    packageTypes: ["礼盒"],
  }, { isCreate: true, defaultCaseId: "case_109" });
  const rejected = sanitizeCasePayload({
    title: "十图案例",
    galleryImages: [...galleryImages, "cloud://cloud1/display-9.jpg"],
    packageTypes: ["礼盒"],
  }, { isCreate: true, defaultCaseId: "case_111" });

  assert.equal(CASE_GALLERY_MAX, 9);
  assert.equal(accepted.valid, true);
  assert.equal(accepted.data.galleryImages.length, 9);
  assert.equal(rejected.valid, false);
  assert.equal(rejected.code, "TOO_MANY_IMAGES");
  assert.equal(rejected.message, "一个案例最多上传 9 张图片");
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

test("rejects original or display images masquerading as thumbnails", () => {
  const source = "cloud://env/source.jpg";
  const result = sanitizeCasePayload({
    title: "错误回退案例",
    galleryImages: [source],
    sourceGalleryImages: [source],
    galleryThumbnails: [source],
    packageTypes: ["礼盒"],
  }, { isCreate: true, defaultCaseId: "case_093" });
  assert.equal(result.valid, false);
  assert.equal(result.code, "INVALID_IMAGE_VARIANTS");
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

test("keeps canonical scene values while wedding search accepts the display label", () => {
  assert.deepEqual(plain(CASE_ADMIN_OPTIONS.scenes), [
    "婚宴",
    "百日/满月",
    "生日宴",
    "寿宴",
    "乔迁宴",
    "送礼",
    "商务招待",
    "节庆礼赠",
    "企业纪念",
    "商超陈列",
    "电商展示",
  ]);
  const weddingCase = {
    _id: "wedding_case",
    caseId: "case_888",
    title: "红色礼盒",
    scenes: { values: ["婚宴"] },
    isVisible: true,
  };
  assert.equal(buildCaseSearchText(weddingCase).includes("婚宴/喜宴"), true);
  assert.deepEqual(
    plain(filterCaseItemsV2([weddingCase], { keyword: "喜宴" }).map((item) => item._id)),
    ["wedding_case"],
  );
  assert.equal(filterCaseItemsV2([weddingCase], { scenes: ["婚宴"] }).length, 1);
  assert.equal(filterCaseItemsV2([weddingCase], { scenes: ["婚宴/喜宴"] }).length, 0);
  const sanitized = sanitizeCasePayload(
    {
      title: "婚宴礼盒",
      coverImage: "cloud://cloud1/wedding.jpg",
      packageTypes: ["礼盒"],
      scenes: ["婚宴"],
    },
    { isCreate: true, defaultCaseId: "case_888" },
  );
  assert.equal(sanitized.valid, true);
  assert.deepEqual(plain(sanitized.data.scenes), { values: ["婚宴"] });
  assert.equal(sanitized.data.keywords.values.includes("婚宴"), true);
  assert.equal(sanitized.data.keywords.values.includes("婚宴/喜宴"), false);
});

test("saves and batch patches the four added scene values", () => {
  const addedSceneValues = ["百日/满月", "生日宴", "寿宴", "乔迁宴"];
  const created = sanitizeCasePayload(
    {
      title: "新增宴席场景",
      coverImage: "cloud://cloud1/banquet.jpg",
      packageTypes: ["礼盒"],
      scenes: addedSceneValues,
    },
    { isCreate: true, defaultCaseId: "case_889" },
  );
  assert.equal(created.valid, true);
  assert.deepEqual(plain(created.data.scenes), { values: addedSceneValues });
  addedSceneValues.forEach((scene) => {
    assert.equal(
      filterCaseItemsV2(
        [{ _id: `scene_${scene}`, ...created.data, isVisible: true }],
        { scenes: [scene] },
      ).length,
      1,
    );
  });
  const existing = { scenes: { values: ["送礼", "百日/满月"] } };
  assert.deepEqual(
    plain(
      buildBatchCasePatch(existing, {
        tags: { scenes: ["生日宴", "寿宴"] },
        tagMode: "append",
      }).data.scenes,
    ),
    { values: ["送礼", "百日/满月", "生日宴", "寿宴"] },
  );
  assert.deepEqual(
    plain(
      buildBatchCasePatch(existing, {
        tags: { scenes: ["百日/满月"] },
        tagMode: "remove",
      }).data.scenes,
    ),
    { values: ["送礼"] },
  );
  assert.deepEqual(
    plain(
      buildBatchCasePatch(existing, {
        tags: { scenes: ["乔迁宴"] },
        tagMode: "replace",
      }).data.scenes,
    ),
    { values: ["乔迁宴"] },
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

test("filters and stably sorts more than the legacy search window", () => {
  const items = Array.from({ length: 350 }, (_, index) => ({
    _id: `doc_${index}`,
    caseId: `case_${String(index + 1).padStart(3, "0")}`,
    title: index % 2 ? "青花礼盒" : "商务瓶标",
    packageTypes: { values: [index % 2 ? "礼盒" : "瓶标"] },
    isVisible: index % 3 !== 0,
    sortOrder: 350 - index,
  }));
  const filtered = filterCaseItemsV2(items, {
    keyword: "青花",
    packageTypes: ["礼盒"],
    visibility: "visible",
    trash: false,
  });
  assert.equal(filtered.length > 50, true);
  const sorted = sortCaseItemsV2(filtered, { field: "sortOrder", direction: "asc" });
  assert.equal(sorted[0].sortOrder <= sorted.at(-1).sortOrder, true);
});

test("applies append, remove and replace tag patches without losing other fields", () => {
  const existing = {
    title: "礼盒",
    caseId: "case_001",
    packageTypes: { values: ["礼盒"] },
    styles: { values: ["国风", "简约"] },
    isVisible: false,
  };
  const appended = buildBatchCasePatch(existing, {
    tags: { styles: ["轻奢"] },
    tagMode: "append",
  });
  const removed = buildBatchCasePatch(existing, {
    tags: { styles: ["简约"] },
    tagMode: "remove",
  });
  const replaced = buildBatchCasePatch(existing, {
    tags: { styles: ["时尚"] },
    tagMode: "replace",
  });
  assert.deepEqual(plain(appended.data.styles), { values: ["国风", "简约", "轻奢"] });
  assert.deepEqual(plain(removed.data.styles), { values: ["国风"] });
  assert.deepEqual(plain(replaced.data.styles), { values: ["时尚"] });
});

test("applies single-value price level batch semantics", () => {
  const filled = { title: "礼盒", priceLevel: "品质款", isVisible: false };
  const empty = { title: "礼盒", priceLevel: "", isVisible: false };

  assert.equal(
    buildBatchCasePatch(empty, {
      tags: { priceLevel: ["高端款"] },
      tagMode: "append",
    }).data.priceLevel,
    "高端款"
  );
  assert.equal(
    buildBatchCasePatch(filled, {
      tags: { priceLevel: ["高端款"] },
      tagMode: "append",
    }).data.priceLevel,
    "品质款"
  );
  assert.equal(
    buildBatchCasePatch(filled, {
      tags: { priceLevel: ["高端款"] },
      tagMode: "remove",
    }).data.priceLevel,
    "品质款"
  );
  assert.equal(
    buildBatchCasePatch(filled, {
      tags: { priceLevel: ["品质款"] },
      tagMode: "remove",
    }).data.priceLevel,
    ""
  );
  assert.equal(
    buildBatchCasePatch(filled, {
      tags: { priceLevel: ["珍藏款"] },
      tagMode: "replace",
    }).data.priceLevel,
    "珍藏款"
  );
  assert.equal(
    buildBatchCasePatch(filled, {
      tags: { priceLevel: [] },
      tagMode: "replace",
    }).data.priceLevel,
    ""
  );
  assert.equal(
    buildBatchCasePatch(filled, {
      tags: { priceLevel: ["基础款", "高端款"] },
      tagMode: "replace",
    }).code,
    "INVALID_BATCH_PATCH"
  );
});

test("requires and checks optimistic versions for desktop writes", () => {
  const item = { version: 4 };
  assert.equal(validateExpectedVersion(item, undefined, { required: true }).code, "EXPECTED_VERSION_REQUIRED");
  assert.equal(validateExpectedVersion(item, 3, { required: true }).code, "VERSION_CONFLICT");
  assert.equal(validateExpectedVersion(item, 4, { required: true }).valid, true);
  assert.equal(validateExpectedVersion({}, undefined, { required: false }).valid, true);
});

test("allows one case in multiple homepage sections but rejects duplicates within a section", () => {
  const accepted = validateHomepageOrders({
    banner: ["case_1"],
    popular: ["case_1"],
    latest: [],
  });
  const rejected = validateHomepageOrders({
    banner: ["case_1", "case_1"],
    popular: [],
    latest: [],
  });
  assert.equal(accepted.valid, true);
  assert.equal(rejected.code, "DUPLICATE_HOME_CASE");
});

test("prefers per-section order and falls back to legacy latest descending order", () => {
  const cases = [
    { _id: "a", caseId: "case_001", isVisible: true, sortOrder: 1, homeSections: { values: ["latest"] }, homeSectionOrder: { latest: 2 } },
    { _id: "b", caseId: "case_002", isVisible: true, sortOrder: 99, homeSections: { values: ["latest"] }, homeSectionOrder: { latest: 1 } },
  ];
  assert.deepEqual(
    plain(buildHomepageDisplayItems(cases, [], { slot: "latest" }).map((item) => item.id)),
    ["b", "a"]
  );
  const legacy = cases.map(({ homeSectionOrder, ...item }) => item);
  assert.deepEqual(
    plain(buildHomepageDisplayItems(legacy, [], { slot: "latest" }).map((item) => item.id)),
    ["b", "a"]
  );
});
