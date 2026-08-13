import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const modulePath = resolve(
  __dirname,
  "../miniprogram/cloudfunctions/caseCatalog/index.js"
);
const logic = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/caseCatalog/caseCatalogLogic.js"
));

function matches(record, condition = {}) {
  return Object.entries(condition).every(([key, expected]) => {
    const actual = key.split(".").reduce(
      (value, part) => (value && typeof value === "object" ? value[part] : undefined),
      record
    );
    if (expected && Array.isArray(expected.$in)) {
      return expected.$in.includes(actual);
    }
    if (Array.isArray(actual)) return actual.includes(expected);
    return actual === expected;
  });
}

function loadCaseCatalog(options = {}) {
  const calls = [];
  const recordsByCollection = options.recordsByCollection || {};
  const removed = [];
  const tempFileRequests = [];
  const command = {
    in(values) {
      return { $in: values };
    },
  };

  function collection(name) {
    const state = {
      where: null,
      limit: Infinity,
      skip: 0,
      orderFields: [],
    };
    const query = {
      where(condition) {
        state.where = condition;
        calls.push({ collection: name, type: "where", condition });
        return this;
      },
      field() {
        return this;
      },
      orderBy(field, direction = "asc") {
        state.orderFields.push({ field, direction });
        return this;
      },
      skip(value) {
        state.skip = value;
        return this;
      },
      limit(value) {
        state.limit = value;
        return this;
      },
      async get() {
        calls.push({ collection: name, type: "get" });
        const source = recordsByCollection[name] || [];
        const filtered = state.where
          ? source.filter((record) => matches(record, state.where))
          : source;
        const ordered = state.orderFields.length
          ? filtered.slice().sort((left, right) => {
              for (const order of state.orderFields) {
                const leftValue = left[order.field];
                const rightValue = right[order.field];
                const leftNumber = Number(leftValue);
                const rightNumber = Number(rightValue);
                const difference = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
                  ? leftNumber - rightNumber
                  : String(leftValue || "").localeCompare(String(rightValue || ""));
                if (difference) return order.direction === "desc" ? -difference : difference;
              }
              return 0;
            })
          : filtered;
        return {
          data: ordered.slice(state.skip, state.skip + state.limit),
        };
      },
      doc(id) {
        return {
          async get() {
            calls.push({ collection: name, type: "doc.get", id });
            const source = recordsByCollection[name] || [];
            const record = source.find((item) => item._id === id);
            if (!record) throw new Error("not found");
            return { data: record };
          },
          async remove() {
            removed.push({ collection: name, id });
            return {};
          },
        };
      },
    };
    return query;
  }

  const mockCloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-env",
    init() {},
    getWXContext() {
      return { OPENID: options.openid || "server_openid" };
    },
    async getTempFileURL({ fileList }) {
      tempFileRequests.push(...fileList);
      return {
        fileList: fileList.map((fileID) => ({
          fileID,
          tempFileURL: `https://temp/${encodeURIComponent(fileID)}`,
        })),
      };
    },
    database() {
      return {
        command,
        collection,
      };
    },
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    process: { env: options.env || {} },
    require(moduleName) {
      if (moduleName === "wx-server-sdk") return mockCloud;
      if (moduleName === "./caseCatalogLogic") return logic;
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, {
    filename: modulePath,
  });
  return {
    main: sandbox.module.exports.main,
    calls,
    removed,
    tempFileRequests,
  };
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

await test("known catalog revision returns notModified without reading cases", async () => {
  const { main, calls } = loadCaseCatalog({
    recordsByCollection: {
      catalog_meta: [{ _id: "current", revision: 7 }],
    },
  });
  const result = await main({
    action: "getCatalogSnapshot",
    knownRevision: 7,
  });
  assert.equal(result.ok, true);
  assert.equal(result.revision, 7);
  assert.equal(result.notModified, true);
  assert.equal(
    calls.some((call) => call.collection === "wine_packaging"),
    false
  );
});

await test("missing revision metadata never validates a known client revision", async () => {
  const { main, calls } = loadCaseCatalog({
    recordsByCollection: {
      wine_packaging: [{
        _id: "doc_1",
        caseId: "case_1",
        title: "案例 1",
        isVisible: true,
      }],
    },
  });
  const result = await main({
    action: "getCatalogSnapshot",
    knownRevision: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.notModified, false);
  assert.equal(result.revision, 0);
  assert.equal(result.items.length, 1);
  assert.equal(
    calls.some((call) => call.collection === "wine_packaging" && call.type === "get"),
    true
  );
});

await test("home revision is notModified only when the cached feed mode matches", async () => {
  const recordsByCollection = {
    catalog_meta: [{ _id: "current", revision: 9 }],
    wine_packaging: [{
      _id: "doc_1",
      caseId: "case_1",
      title: "案例 1",
      isVisible: true,
      sortOrder: 1,
      homeSections: { values: ["popular", "latest", "banner"] },
      coverBanner: "cloud://env/banner-1.jpg",
    }],
    home_banners: [],
  };

  const matching = loadCaseCatalog({
    env: { HOME_FEED_INDEXED_ENABLED: "true" },
    recordsByCollection,
  });
  const matchingResult = await matching.main({
    action: "getHomeFeed",
    knownRevision: 9,
    knownFeedMode: "indexed_v2",
    feedMode: "indexed_v2",
  });
  assert.equal(matchingResult.notModified, true);
  assert.equal(matchingResult.feedModeUsed, "indexed_v2");
  assert.equal(
    matching.calls.some(
      (call) => call.collection === "wine_packaging" && call.type === "get"
    ),
    false
  );

  const enabling = loadCaseCatalog({
    env: { HOME_FEED_INDEXED_ENABLED: "true" },
    recordsByCollection,
  });
  const enablingResult = await enabling.main({
    action: "getHomeFeed",
    knownRevision: 9,
    knownFeedMode: "legacy",
    feedMode: "indexed_v2",
  });
  assert.equal(enablingResult.notModified, false);
  assert.equal(enablingResult.feedModeUsed, "indexed_v2");
  assert.equal(enablingResult.popularCases.length, 1);

  const disabling = loadCaseCatalog({
    env: { HOME_FEED_INDEXED_ENABLED: "false" },
    recordsByCollection,
  });
  const disablingResult = await disabling.main({
    action: "getHomeFeed",
    knownRevision: 9,
    knownFeedMode: "indexed_v2",
    feedMode: "indexed_v2",
  });
  assert.equal(disablingResult.notModified, false);
  assert.equal(disablingResult.feedModeUsed, "legacy");
  assert.equal(disablingResult.popularCases.length, 1);
});

await test("legacy clients keep revision-only notModified compatibility", async () => {
  const { main, calls } = loadCaseCatalog({
    recordsByCollection: {
      catalog_meta: [{ _id: "current", revision: 9 }],
    },
  });

  const result = await main({
    action: "getHomeFeed",
    knownRevision: 9,
  });

  assert.equal(result.notModified, true);
  assert.equal(result.feedModeUsed, "legacy");
  assert.equal(
    calls.some((call) => call.collection === "wine_packaging"),
    false
  );
});

await test("catalog snapshot keeps image metadata without signing every URL", async () => {
  const banner = "cloud://env/banner-1.jpg";
  const { main, tempFileRequests } = loadCaseCatalog({
    recordsByCollection: {
      catalog_meta: [{ _id: "current", revision: 8 }],
      wine_packaging: [{
        _id: "doc_1",
        caseId: "case_1",
        title: "案例 1",
        isVisible: true,
        coverImage: "cloud://env/display-1.jpg",
        coverThumbnail: "cloud://env/thumb-1.jpg",
        coverBanner: banner,
      }],
    },
  });

  const result = await main({ action: "getCatalogSnapshot" });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "doc_1");
  assert.equal(result.items[0].imageFileId, banner);
  assert.equal(result.items[0].thumbnailUrl, "");
  assert.deepEqual(tempFileRequests, []);
});

await test("catalog image URLs are signed only for requested visible document ids", async () => {
  const visibleBanner = "cloud://env/visible-banner.jpg";
  const hiddenBanner = "cloud://env/hidden-banner.jpg";
  const unrequestedBanner = "cloud://env/unrequested-banner.jpg";
  const { main, tempFileRequests } = loadCaseCatalog({
    recordsByCollection: {
      wine_packaging: [
        {
          _id: "doc_visible",
          caseId: "case_visible",
          isVisible: true,
          coverImage: "cloud://env/visible-display.jpg",
          coverThumbnail: "cloud://env/visible-thumb.jpg",
          coverBanner: visibleBanner,
        },
        {
          _id: "doc_hidden",
          caseId: "case_hidden",
          isVisible: false,
          coverBanner: hiddenBanner,
        },
        {
          _id: "doc_unrequested",
          caseId: "case_unrequested",
          isVisible: true,
          coverBanner: unrequestedBanner,
        },
      ],
    },
  });

  const result = await main({
    action: "getCatalogImageUrls",
    ids: ["doc_visible", "doc_hidden", "cloud://env/arbitrary-private.jpg"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.images)), {
    doc_visible: {
      imageFileId: visibleBanner,
      thumbnailUrl: `https://temp/${encodeURIComponent(visibleBanner)}`,
    },
  });
  assert.deepEqual(tempFileRequests, [visibleBanner]);
  assert.equal(tempFileRequests.includes(hiddenBanner), false);
  assert.equal(tempFileRequests.includes(unrequestedBanner), false);
  assert.equal(tempFileRequests.includes("cloud://env/arbitrary-private.jpg"), false);
});

await test("catalog image URL endpoint rejects batches over 24 ids", async () => {
  const { main, calls, tempFileRequests } = loadCaseCatalog({
    recordsByCollection: {
      wine_packaging: [],
    },
  });
  const result = await main({
    action: "getCatalogImageUrls",
    ids: Array.from({ length: 25 }, (_, index) => `doc_${index}`),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_CATALOG_IMAGE_IDS");
  assert.equal(
    calls.some((call) => call.collection === "wine_packaging"),
    false
  );
  assert.deepEqual(tempFileRequests, []);
});

await test("catalog image URL endpoint rejects empty or oversized document ids", async () => {
  for (const invalidId of ["   ", "x".repeat(129), 123]) {
    const { main, calls, tempFileRequests } = loadCaseCatalog({
      recordsByCollection: {
        wine_packaging: [],
      },
    });
    const result = await main({
      action: "getCatalogImageUrls",
      ids: [invalidId],
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_CATALOG_IMAGE_IDS");
    assert.equal(
      calls.some((call) => call.collection === "wine_packaging"),
      false
    );
    assert.deepEqual(tempFileRequests, []);
  }
});

await test("public case detail never signs source originals", async () => {
  const source = "cloud://env/source.jpg";
  const display = "cloud://env/display.jpg";
  const thumbnail = "cloud://env/thumbnail.jpg";
  const { main, tempFileRequests } = loadCaseCatalog({
    recordsByCollection: {
      wine_packaging: [{
        _id: "doc_1",
        caseId: "case_1",
        title: "案例",
        isVisible: true,
        galleryImages: [display],
        sourceGalleryImages: [source],
        galleryThumbnails: [thumbnail],
        coverImage: display,
        coverThumbnail: thumbnail,
      }],
    },
  });
  const result = await main({ action: "getCaseDetail", id: "doc_1" });
  assert.equal(result.ok, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.item, "sourceGalleryImages"),
    false
  );
  assert.equal(result.item.gallery[0].downloadUrl, result.item.gallery[0].displayUrl);
  assert.equal(tempFileRequests.includes(source), false);
  assert.equal(tempFileRequests.includes(display), true);
  assert.equal(tempFileRequests.includes(thumbnail), true);
});

await test("hidden case details stay unavailable by document id and case id", async () => {
  const source = "cloud://env/hidden-source.jpg";
  const options = {
    env: { DETAIL_INITIAL_MODE_ENABLED: "true" },
    recordsByCollection: {
      wine_packaging: [{
        _id: "doc_hidden",
        caseId: "case_hidden",
        isVisible: false,
        galleryImages: [source],
        sourceGalleryImages: [source],
      }],
    },
  };

  for (const id of ["doc_hidden", "case_hidden"]) {
    const { main, tempFileRequests } = loadCaseCatalog(options);
    const result = await main({
      action: "getCaseDetail",
      id,
      detailMode: "initial_v2",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "CASE_NOT_FOUND");
    assert.deepEqual(tempFileRequests, []);
  }
});

await test("detail initial v2 signs only one hero and gallery thumbnails", async () => {
  const displays = [
    "cloud://env/display-0.jpg",
    "cloud://env/display-1.jpg",
  ];
  const thumbnails = [
    "cloud://env/thumb-0.jpg",
    "cloud://env/thumb-1.jpg",
  ];
  const hero = "cloud://env/hero-0.jpg";
  const source = "cloud://env/source-0.jpg";
  const { main, tempFileRequests } = loadCaseCatalog({
    env: { DETAIL_INITIAL_MODE_ENABLED: "true" },
    recordsByCollection: {
      wine_packaging: [{
        _id: "doc_1",
        caseId: "case_1",
        title: "案例",
        isVisible: true,
        galleryImages: displays,
        galleryThumbnails: thumbnails,
        galleryBanners: [hero],
        sourceGalleryImages: [source],
        coverImage: displays[0],
        coverThumbnail: thumbnails[0],
        coverBanner: hero,
      }],
    },
  });

  const result = await main({
    action: "getCaseDetail",
    id: "doc_1",
    detailMode: "initial_v2",
  });
  assert.equal(result.ok, true);
  assert.equal(result.detailSchemaVersion, 2);
  assert.equal(result.detailMode, "initial_v2");
  assert.equal(result.item.gallery.length, 2);
  assert.equal(result.item.gallery[0].heroUrl, `https://temp/${encodeURIComponent(hero)}`);
  assert.equal(result.item.gallery[0].displayUrl, "");
  assert.equal(result.item.gallery[1].thumbnailUrl, `https://temp/${encodeURIComponent(thumbnails[1])}`);
  assert.deepEqual(tempFileRequests, [hero, ...thumbnails]);
  assert.equal(tempFileRequests.includes(displays[0]), false);
  assert.equal(tempFileRequests.includes(source), false);
});

await test("detail gallery patch signs only validated database indexes", async () => {
  const displays = Array.from(
    { length: 3 },
    (_, index) => `cloud://env/display-${index}.jpg`
  );
  const options = {
    env: { DETAIL_INITIAL_MODE_ENABLED: "true" },
    recordsByCollection: {
      wine_packaging: [{
        _id: "doc_1",
        caseId: "case_1",
        isVisible: true,
        galleryImages: displays,
        imageVariantVersion: 2,
      }],
    },
  };
  const valid = loadCaseCatalog(options);
  const result = await valid.main({
    action: "getCaseDetail",
    id: "doc_1",
    detailMode: "gallery_patch_v2",
    indexes: [2],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.galleryPatch)), [{
    index: 2,
    fileID: displays[2],
    displayUrl: `https://temp/${encodeURIComponent(displays[2])}`,
    downloadUrl: `https://temp/${encodeURIComponent(displays[2])}`,
  }]);
  assert.deepEqual(valid.tempFileRequests, [displays[2]]);

  const invalid = loadCaseCatalog(options);
  const invalidResult = await invalid.main({
    action: "getCaseDetail",
    id: "doc_1",
    detailMode: "gallery_patch_v2",
    indexes: [1, 1],
  });
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.code, "INVALID_DETAIL_INDEXES");
  assert.deepEqual(invalid.tempFileRequests, []);
});

await test("detail v2 never signs a source id aliased into public variants", async () => {
  const source = "cloud://env/source-alias.jpg";
  const options = {
    env: { DETAIL_INITIAL_MODE_ENABLED: "true" },
    recordsByCollection: {
      wine_packaging: [{
        _id: "doc_alias",
        caseId: "case_alias",
        isVisible: true,
        galleryImages: [source],
        sourceGalleryImages: [source],
        galleryThumbnails: [source],
        galleryBanners: [source],
        coverImage: source,
        coverThumbnail: source,
        coverBanner: source,
        imageVariantVersion: 2,
      }],
    },
  };
  const initial = loadCaseCatalog(options);
  const initialResult = await initial.main({
    action: "getCaseDetail",
    id: "doc_alias",
    detailMode: "initial_v2",
  });
  assert.equal(initialResult.ok, true);
  assert.equal(initialResult.item.gallery.length, 1);
  assert.equal(initialResult.item.gallery[0].fileID, "");
  assert.equal(initialResult.item.gallery[0].heroUrl, "");
  assert.equal(initialResult.item.gallery[0].thumbnailUrl, "");
  assert.deepEqual(initial.tempFileRequests, []);

  const patch = loadCaseCatalog(options);
  const patchResult = await patch.main({
    action: "getCaseDetail",
    id: "doc_alias",
    detailMode: "gallery_patch_v2",
    indexes: [0],
  });
  assert.equal(patchResult.galleryPatch[0].fileID, "");
  assert.equal(patchResult.galleryPatch[0].displayUrl, "");
  assert.deepEqual(patch.tempFileRequests, []);
});

await test("detail v2 requests fall back to the legacy response while disabled", async () => {
  const display = "cloud://env/display.jpg";
  const record = {
    _id: "doc_1",
    isVisible: true,
    galleryImages: [display],
    coverImage: display,
  };
  const { main } = loadCaseCatalog({
    env: { DETAIL_INITIAL_MODE_ENABLED: "false" },
    recordsByCollection: {
      wine_packaging: [record],
    },
  });
  const result = await main({
    action: "getCaseDetail",
    id: "doc_1",
    detailMode: "initial_v2",
  });
  const expectedItem = logic.buildDetail(record, {
    [display]: `https://temp/${encodeURIComponent(display)}`,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    item: JSON.parse(JSON.stringify(expectedItem)),
  });
});

await test("indexed home feed uses bounded section queries and preserves limits", async () => {
  const cases = Array.from({ length: 12 }, (_, index) => ({
    _id: `doc_${index + 1}`,
    caseId: `case_${index + 1}`,
    title: `案例 ${index + 1}`,
    isVisible: true,
    sortOrder: index + 1,
    homeSections: { values: ["popular", "latest", "banner"] },
    coverBanner: `cloud://env/banner-${index + 1}.jpg`,
  }));
  const banners = Array.from({ length: 7 }, (_, index) => ({
    _id: `banner_${index}`,
    isVisible: true,
    sortOrder: index,
    optimizedImage: `cloud://env/independent-${index}.jpg`,
  }));
  const { main, calls, tempFileRequests } = loadCaseCatalog({
    env: { HOME_FEED_INDEXED_ENABLED: "true" },
    recordsByCollection: {
      catalog_meta: [{ _id: "current", revision: 9 }],
      wine_packaging: cases,
      home_banners: banners,
    },
  });
  const result = await main({
    action: "getHomeFeed",
    feedMode: "indexed_v2",
  });
  assert.equal(result.ok, true);
  assert.equal(result.feedModeUsed, "indexed_v2");
  assert.equal(result.popularCases.length, 4);
  assert.equal(result.latestCases.length, 6);
  assert.equal(result.banners.length, 5);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.latestCases.map((item) => item.sortOrder))),
    [12, 11, 10, 9, 8, 7]
  );
  const sectionQueries = calls.filter(
    (call) =>
      call.collection === "wine_packaging"
      && call.type === "where"
      && Object.prototype.hasOwnProperty.call(call.condition, "homeSections.values")
  );
  assert.equal(sectionQueries.length, 3);
  assert.equal(
    calls.filter(
      (call) => call.collection === "wine_packaging" && call.type === "get"
    ).length,
    3
  );
  const selectedIndependent = result.banners
    .map((item) => decodeURIComponent(item.imageUrl.replace("https://temp/", "")))
    .filter((fileID) => fileID.includes("independent-"))
    .sort();
  const signedIndependent = tempFileRequests
    .filter((fileID) => fileID.includes("independent-"))
    .sort();
  assert.deepEqual(signedIndependent, selectedIndependent);
});

await test("indexed home feed matches legacy selection when sortOrder values tie", async () => {
  const caseIds = ["08", "03", "07", "01", "06", "02", "05", "04"];
  const cases = caseIds.map((suffix) => ({
    _id: `doc_${suffix}`,
    caseId: `case_${suffix}`,
    title: `案例 ${suffix}`,
    isVisible: true,
    sortOrder: 10,
    homeSections: { values: ["popular", "latest", "banner"] },
    coverBanner: `cloud://env/banner-${suffix}.jpg`,
  }));
  const recordsByCollection = {
    catalog_meta: [{ _id: "current", revision: 10 }],
    wine_packaging: cases,
    home_banners: [],
  };

  const legacy = loadCaseCatalog({ recordsByCollection });
  const legacyResult = await legacy.main({ action: "getHomeFeed" });
  const indexed = loadCaseCatalog({
    env: { HOME_FEED_INDEXED_ENABLED: "true" },
    recordsByCollection,
  });
  const indexedResult = await indexed.main({
    action: "getHomeFeed",
    feedMode: "indexed_v2",
  });

  const selectPublicFeed = (result) => ({
    banners: result.banners,
    popularCases: result.popularCases,
    latestCases: result.latestCases,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(selectPublicFeed(indexedResult))),
    JSON.parse(JSON.stringify(selectPublicFeed(legacyResult)))
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(indexedResult.popularCases.map((item) => item.caseId))),
    ["case_01", "case_02", "case_03", "case_04"]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(indexedResult.latestCases.map((item) => item.caseId))),
    ["case_01", "case_02", "case_03", "case_04", "case_05", "case_06"]
  );
});

await test("favorites use server OPENID and batched case lookups", async () => {
  const favorites = Array.from({ length: 100 }, (_, index) => ({
    _id: `fav_${index}`,
    _openid: "server_openid",
    caseDocId: `doc_${index}`,
    createdAt: 100 - index,
  }));
  favorites.push({
    _id: "spoofed_favorite",
    _openid: "spoofed",
    caseDocId: "doc_0",
    createdAt: 200,
  });
  const cases = Array.from({ length: 99 }, (_, index) => ({
    _id: `doc_${index}`,
    caseId: `case_${index}`,
    title: `案例 ${index}`,
    isVisible: true,
    sortOrder: index,
    coverThumbnail: `cloud://env/thumb-${index}.jpg`,
  }));
  const { main, calls, removed } = loadCaseCatalog({
    openid: "server_openid",
    recordsByCollection: {
      favorites,
      wine_packaging: cases,
    },
  });

  const result = await main({
    action: "listUserLibrary",
    type: "favorites",
    openid: "spoofed",
  });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 99);
  assert.equal(result.items[0].recordId, "fav_0");
  const favoriteWhere = calls.find(
    (call) => call.collection === "favorites" && call.type === "where"
  );
  assert.equal(favoriteWhere.condition._openid, "server_openid");
  const caseReads = calls.filter(
    (call) => call.collection === "wine_packaging" && call.type === "get"
  );
  assert.equal(caseReads.length, 10);
  assert.deepEqual(removed, [{ collection: "favorites", id: "fav_99" }]);
});
