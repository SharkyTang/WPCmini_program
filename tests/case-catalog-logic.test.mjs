import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  buildCatalogSnapshot,
  buildDetail,
  buildDetailPatch,
  buildHomeFeed,
  buildIndexedHomeFeed,
  buildInitialDetail,
  chunkList,
  collectDetailPatchFileIds,
  collectInitialDetailImageFileIds,
  mergeUserLibrary,
} = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/caseCatalog/caseCatalogLogic.js"
));

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

function buildCase(index, overrides = {}) {
  const fileID = `cloud://env/case-${index}.jpg`;
  return {
    _id: `doc_${index}`,
    caseId: `case_${String(index).padStart(3, "0")}`,
    title: `案例 ${index}`,
    isVisible: true,
    sortOrder: index,
    packageTypes: { values: ["礼盒"] },
    homeSections: { values: [] },
    coverImage: fileID,
    ...overrides,
  };
}

test("home feed enforces limits, ordering, and visibility", () => {
  const cases = Array.from({ length: 12 }, (_, index) =>
    buildCase(index + 1, {
      homeSections: {
        values: ["popular", "latest", "banner"],
      },
    })
  );
  cases.push(buildCase(99, {
    isVisible: false,
    homeSections: { values: ["popular", "latest", "banner"] },
  }));
  const banners = Array.from({ length: 7 }, (_, index) => ({
    _id: `banner_${index}`,
    caseId: `banner_case_${index}`,
    image: `cloud://env/banner-${index}.jpg`,
    sortOrder: index,
    isVisible: index !== 0,
  }));
  const allFiles = [...cases, ...banners].reduce((map, item) => {
    const fileID = item.coverImage || item.image;
    if (fileID) map[fileID] = `https://temp/${encodeURIComponent(fileID)}`;
    return map;
  }, {});

  const result = buildHomeFeed(cases, banners, allFiles);

  assert.equal(result.banners.length, 5);
  assert.equal(result.popularCases.length, 4);
  assert.equal(result.latestCases.length, 6);
  assert.equal(result.popularCases.some((item) => item.id === "doc_99"), false);
  assert.deepEqual(
    plain(result.popularCases.map((item) => item.sortOrder)),
    [1, 2, 3, 4]
  );
  assert.deepEqual(
    plain(result.latestCases.map((item) => item.sortOrder)),
    [12, 11, 10, 9, 8, 7]
  );
});

test("catalog snapshot handles target boundary sizes and hides records", () => {
  [0, 1, 20, 21, 89, 100].forEach((count) => {
    const records = Array.from({ length: count }, (_, index) => buildCase(index + 1));
    assert.equal(buildCatalogSnapshot(records).length, count);
  });
  const result = buildCatalogSnapshot([
    buildCase(2),
    buildCase(1),
    buildCase(3, { isVisible: false }),
  ]);
  assert.deepEqual(plain(result.map((item) => item.id)), ["doc_1", "doc_2"]);
  assert.equal(Object.prototype.hasOwnProperty.call(result[0], "notes"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result[0], "galleryImages"), false);
});

test("catalog cards prefer the aspect-preserving banner cover", () => {
  const banner = "cloud://env/banner.jpg";
  const thumbnail = "cloud://env/thumbnail.jpg";
  const display = "cloud://env/display.jpg";
  const result = buildCatalogSnapshot([
    buildCase(1, {
      coverImage: display,
      coverThumbnail: thumbnail,
      coverBanner: banner,
    }),
  ], {
    [banner]: "https://temp/banner",
    [thumbnail]: "https://temp/thumbnail",
    [display]: "https://temp/display",
  });

  assert.equal(result[0].imageFileId, banner);
  assert.equal(result[0].thumbnailUrl, "https://temp/banner");
});

test("home cards use the same aspect-preserving covers as category", () => {
  const banner = "cloud://env/banner.jpg";
  const thumbnail = "cloud://env/thumbnail.jpg";
  const result = buildHomeFeed([
    buildCase(1, {
      coverThumbnail: thumbnail,
      coverBanner: banner,
      homeSections: { values: ["popular"] },
    }),
  ], [], {
    [banner]: "https://temp/banner",
    [thumbnail]: "https://temp/thumbnail",
  });

  assert.equal(result.popularCases[0].imageFileId, banner);
  assert.equal(result.popularCases[0].thumbnailUrl, "https://temp/banner");
});

test("user library preserves record order and identifies stale records", () => {
  const library = [
    { _id: "fav_3", caseDocId: "doc_3", createdAt: 30 },
    { _id: "fav_missing", caseDocId: "doc_missing", createdAt: 20 },
    { _id: "fav_1", caseId: "case_001", createdAt: 10 },
  ];
  const result = mergeUserLibrary("favorites", library, [
    buildCase(1),
    buildCase(3),
  ]);

  assert.deepEqual(
    plain(result.items.map((item) => item.caseItem.id)),
    ["doc_3", "doc_1"]
  );
  assert.deepEqual(plain(result.staleIds), ["fav_missing"]);
});

test("detail downloads the display variant and never exposes source URLs", () => {
  const source = "cloud://env/source.jpg";
  const display = "cloud://env/display.jpg";
  const thumbnail = "cloud://env/thumb.jpg";
  const detail = buildDetail(
    buildCase(1, {
      sourceGalleryImages: [source],
      galleryImages: [display],
      galleryThumbnails: [thumbnail],
      coverImage: display,
      coverThumbnail: thumbnail,
    }),
    {
      [source]: "https://temp/source",
      [display]: "https://temp/display",
      [thumbnail]: "https://temp/thumb",
    }
  );
  assert.deepEqual(plain(detail.gallery[0]), {
    fileID: display,
    thumbnailUrl: "https://temp/thumb",
    displayUrl: "https://temp/display",
    downloadUrl: "https://temp/display",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(detail, "sourceGalleryImages"), false);

  const legacy = buildDetail(buildCase(2), {
    "cloud://env/case-2.jpg": "https://temp/legacy",
  });
  assert.equal(legacy.gallery[0].displayUrl, "https://temp/legacy");
  assert.equal(legacy.gallery[0].downloadUrl, "https://temp/legacy");
});

test("detail preserves all nine case images", () => {
  const galleryImages = Array.from(
    { length: 9 },
    (_, index) => `cloud://env/display-${index}.jpg`
  );
  const galleryThumbnails = Array.from(
    { length: 9 },
    (_, index) => `cloud://env/thumb-${index}.jpg`
  );
  const urlMap = [...galleryImages, ...galleryThumbnails].reduce((map, fileID) => {
    map[fileID] = `https://temp/${fileID.split("/").pop()}`;
    return map;
  }, {});
  const detail = buildDetail(
    buildCase(9, {
      galleryImages,
      galleryThumbnails,
      coverImage: galleryImages[0],
      coverThumbnail: galleryThumbnails[0],
    }),
    urlMap
  );

  assert.equal(detail.gallery.length, 9);
  assert.equal(detail.gallery[8].fileID, galleryImages[8]);
  assert.equal(detail.gallery[8].thumbnailUrl, urlMap[galleryThumbnails[8]]);
});

test("initial detail signs only the hero and thumbnails", () => {
  const displays = [
    "cloud://env/display-0.jpg",
    "cloud://env/display-1.jpg",
  ];
  const thumbnails = [
    "cloud://env/thumb-0.jpg",
    "cloud://env/thumb-1.jpg",
  ];
  const hero = "cloud://env/hero-0.jpg";
  const record = buildCase(1, {
    galleryImages: displays,
    galleryThumbnails: thumbnails,
    galleryBanners: [hero],
    coverImage: displays[0],
    coverThumbnail: thumbnails[0],
    coverBanner: hero,
  });
  assert.deepEqual(
    plain(collectInitialDetailImageFileIds(record)),
    [hero, ...thumbnails]
  );
  const detail = buildInitialDetail(record, {
    [hero]: "https://temp/hero",
    [thumbnails[0]]: "https://temp/thumb-0",
    [thumbnails[1]]: "https://temp/thumb-1",
    [displays[0]]: "https://temp/should-not-be-used",
  });
  assert.equal(detail.coverImageUrl, "https://temp/hero");
  assert.equal(detail.gallery.length, 2);
  assert.equal(detail.gallery[0].heroUrl, "https://temp/hero");
  assert.equal(detail.gallery[0].displayUrl, "");
  assert.equal(detail.gallery[1].thumbnailUrl, "https://temp/thumb-1");
  assert.equal(detail.gallery[1].heroUrl, "");
  assert.equal(Object.prototype.hasOwnProperty.call(detail, "sourceGalleryImages"), false);
});

test("initial detail keeps the full gallery while limiting signed thumbnails to nine", () => {
  const displays = Array.from(
    { length: 12 },
    (_, index) => `cloud://env/full-display-${index}.jpg`
  );
  const thumbnails = Array.from(
    { length: 12 },
    (_, index) => `cloud://env/full-thumb-${index}.jpg`
  );
  const hero = "cloud://env/full-hero.jpg";
  const record = buildCase(12, {
    coverImage: displays[0],
    galleryImages: displays,
    galleryThumbnails: thumbnails,
    galleryBanners: [hero],
    imageVariantVersion: 2,
  });
  const signedIds = collectInitialDetailImageFileIds(record);
  assert.equal(signedIds.length, 10);
  assert.deepEqual(plain(signedIds), [hero, ...thumbnails.slice(0, 9)]);
  const urlMap = signedIds.reduce((map, fileID) => {
    map[fileID] = `https://temp/${fileID.split("/").pop()}`;
    return map;
  }, {});
  const detail = buildInitialDetail(record, urlMap);
  assert.equal(detail.gallery.length, 12);
  assert.notEqual(detail.gallery[8].thumbnailUrl, "");
  assert.equal(detail.gallery[9].thumbnailUrl, "");
  assert.equal(detail.gallery[11].fileID, displays[11]);
});

test("detail patch signs only requested display indexes", () => {
  const displays = Array.from(
    { length: 3 },
    (_, index) => `cloud://env/display-${index}.jpg`
  );
  const record = buildCase(1, {
    galleryImages: displays,
    imageVariantVersion: 2,
  });
  assert.deepEqual(
    plain(collectDetailPatchFileIds(record, [2, 0])),
    [displays[2], displays[0]]
  );
  assert.deepEqual(
    plain(buildDetailPatch(record, [2], {
      [displays[2]]: "https://temp/display-2",
    })),
    [{
      index: 2,
      fileID: displays[2],
      displayUrl: "https://temp/display-2",
      downloadUrl: "https://temp/display-2",
    }]
  );
});

test("indexed home feed preserves legacy limits and ordering", () => {
  const popularRecords = Array.from({ length: 4 }, (_, index) =>
    buildCase(index + 1, { homeSections: { values: ["popular"] } })
  );
  const latestRecords = Array.from({ length: 6 }, (_, index) =>
    buildCase(index + 10, { homeSections: { values: ["latest"] } })
  );
  const fallbackBannerRecords = [
    buildCase(30, { homeSections: { values: ["banner"] } }),
  ];
  const urlMap = [...popularRecords, ...latestRecords, ...fallbackBannerRecords]
    .reduce((map, record) => {
      map[record.coverImage] = `https://temp/${record._id}`;
      return map;
    }, {});
  const feed = buildIndexedHomeFeed({
    popularRecords,
    latestRecords,
    fallbackBannerRecords,
  }, [], urlMap);
  assert.equal(feed.popularCases.length, 4);
  assert.equal(feed.latestCases.length, 6);
  assert.deepEqual(
    plain(feed.latestCases.map((item) => item.sortOrder)),
    [15, 14, 13, 12, 11, 10]
  );
  assert.equal(feed.banners.length, 1);
});

test("home banners prefer optimized independent and case banner variants", () => {
  const caseBanner = "cloud://env/case-banner.jpg";
  const independentBanner = "cloud://env/independent-banner.jpg";
  const feed = buildHomeFeed(
    [
      buildCase(1, {
        homeSections: { values: ["banner"] },
        coverBanner: caseBanner,
      }),
    ],
    [
      {
        _id: "banner_1",
        image: "cloud://env/original-banner.jpg",
        optimizedImage: independentBanner,
        isVisible: true,
        sortOrder: 1,
      },
    ],
    {
      [caseBanner]: "https://temp/case-banner",
      [independentBanner]: "https://temp/independent-banner",
    }
  );
  assert.equal(feed.banners[0].imageUrl, "https://temp/independent-banner");
  assert.equal(feed.banners[1].imageUrl, "https://temp/case-banner");
});

test("case lookup chunks stay at ten ids", () => {
  const chunks = chunkList(Array.from({ length: 25 }, (_, index) => index), 10);
  assert.deepEqual(plain(chunks.map((items) => items.length)), [10, 10, 5]);
});
