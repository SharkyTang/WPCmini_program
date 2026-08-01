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
    if (expected && Array.isArray(expected.$in)) {
      return expected.$in.includes(record[key]);
    }
    return record[key] === expected;
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
      orderBy() {
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
        return {
          data: filtered.slice(state.skip, state.skip + state.limit),
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
