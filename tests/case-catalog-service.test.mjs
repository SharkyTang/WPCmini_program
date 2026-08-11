import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const caseDataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/caseData.js"
);
const servicePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/caseCatalogService.js"
);

function loadCommonJS(path, extraSandbox = {}) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    ...extraSandbox,
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(path, "utf8"), sandbox, { filename: path });
  return sandbox.module.exports;
}

function loadService(handler) {
  const calls = [];
  const caseData = loadCommonJS(caseDataPath);
  const service = loadCommonJS(servicePath, {
    wx: {
      cloud: {
        async callFunction(options) {
          calls.push(options);
          return handler(options);
        },
      },
    },
    require(request) {
      if (request === "./caseData") return caseData;
      throw new Error(`Unexpected require: ${request}`);
    },
  });
  return { calls, service };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
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

await test("catalog image service requests unique document ids only", async () => {
  const { calls, service } = loadService(async ({ data }) => ({
    result: {
      ok: true,
      images: {
        doc_1: {
          imageFileId: "cloud://env/banner-1.jpg",
          thumbnailUrl: "https://temp/banner-1.jpg",
        },
        unrequested: {
          imageFileId: "cloud://env/private.jpg",
          thumbnailUrl: "https://temp/private.jpg",
        },
      },
    },
  }));

  const result = await service.fetchCatalogImageUrls([
    " doc_1 ",
    "doc_1",
    "doc_2",
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "caseCatalog");
  assert.equal(calls[0].data.action, "getCatalogImageUrls");
  assert.deepEqual(plain(calls[0].data.ids), ["doc_1", "doc_2"]);
  assert.deepEqual(plain(result), {
    doc_1: {
      imageFileId: "cloud://env/banner-1.jpg",
      thumbnailUrl: "https://temp/banner-1.jpg",
    },
  });
});

await test("catalog image service keeps client batches within 24 ids", async () => {
  const { calls, service } = loadService(async () => ({
    result: { ok: true, images: {} },
  }));
  const ids = Array.from({ length: 30 }, (_, index) => `doc_${index + 1}`);

  await service.fetchCatalogImageUrls(ids);

  assert.equal(calls[0].data.ids.length, 24);
  assert.equal(calls[0].data.ids[23], "doc_24");
});

await test("catalog image service skips the cloud call for an empty batch", async () => {
  const { calls, service } = loadService(async () => {
    throw new Error("should not be called");
  });

  assert.deepEqual(plain(await service.fetchCatalogImageUrls([])), {});
  assert.equal(calls.length, 0);
});

await test("catalog image service rejects malformed image maps", async () => {
  const { service } = loadService(async () => ({
    result: { ok: true, images: [] },
  }));
  await assert.rejects(
    service.fetchCatalogImageUrls(["doc_1"]),
    (error) => error.code === "CATALOG_INVALID_RESULT"
  );
});

await test("catalog fallback is limited to explicit compatibility failures", () => {
  const { service } = loadService(async () => ({ result: { ok: true } }));
  const allowed = [
    Object.assign(new Error("missing"), { code: -501000 }),
    Object.assign(new Error("missing"), { code: "FUNCTION_NOT_FOUND" }),
    Object.assign(new Error("old action"), { code: "UNKNOWN_ACTION" }),
    new Error("cloud.callFunction:fail function not found"),
    new Error("云函数不存在"),
  ];
  allowed.forEach((error) => {
    assert.equal(service.isLegacyCatalogFallbackAllowed(error), true);
  });
  [
    Object.assign(new Error("timeout"), { code: "NETWORK_ERROR" }),
    Object.assign(new Error("hidden"), { code: "CASE_NOT_FOUND" }),
    Object.assign(new Error("server"), { code: "SERVER_ERROR" }),
    new Error("request timeout"),
    new Error("function not found while retrying"),
  ].forEach((error) => {
    assert.equal(service.isLegacyCatalogFallbackAllowed(error), false);
  });
});

await test("unsupported actions and missing functions are disabled for the session", async () => {
  const unsupported = loadService(async () => ({
    result: { ok: false, code: "UNKNOWN_ACTION", message: "old deployment" },
  }));
  await assert.rejects(unsupported.service.fetchHomeFeed());
  await assert.rejects(unsupported.service.fetchHomeFeed());
  assert.equal(unsupported.calls.length, 1);

  const missing = loadService(async () => {
    const error = new Error("missing function");
    error.code = "FUNCTION_NOT_FOUND";
    throw error;
  });
  await assert.rejects(missing.service.fetchHomeFeed());
  await assert.rejects(missing.service.fetchCatalogSnapshot());
  assert.equal(missing.calls.length, 1);
});

await test("home and catalog services reject malformed list contracts", async () => {
  const home = loadService(async () => ({
    result: {
      ok: true,
      revision: 1,
      notModified: false,
      banners: [],
      popularCases: {},
      latestCases: [],
    },
  }));
  await assert.rejects(
    home.service.fetchHomeFeed(),
    (error) => error.code === "CATALOG_INVALID_ITEMS"
  );

  const catalog = loadService(async () => ({
    result: { ok: true, revision: 1, notModified: false, items: {} },
  }));
  await assert.rejects(
    catalog.service.fetchCatalogSnapshot(),
    (error) => error.code === "CATALOG_INVALID_ITEMS"
  );
});

await test("home feed forwards the cached feed mode with its revision", async () => {
  const { calls, service } = loadService(async () => ({
    result: {
      ok: true,
      revision: 9,
      notModified: true,
      feedModeUsed: "indexed_v2",
    },
  }));

  const result = await service.fetchHomeFeed({
    knownRevision: 9,
    knownFeedMode: "indexed_v2",
  });

  assert.deepEqual(plain(calls[0].data), {
    action: "getHomeFeed",
    knownRevision: 9,
    knownFeedMode: "indexed_v2",
    feedMode: "indexed_v2",
  });
  assert.equal(result.notModified, true);
  assert.equal(result.feedModeUsed, "indexed_v2");
});

await test("detail initial mode preserves partial gallery metadata", async () => {
  const { calls, service } = loadService(async () => ({
    result: {
      ok: true,
      detailSchemaVersion: 2,
      detailMode: "initial_v2",
      item: {
        id: "doc_1",
        caseId: "case_1",
        title: "案例",
        gallery: [
          {
            index: 0,
            fileID: "cloud://env/display-0.jpg",
            thumbnailUrl: "https://temp/thumb-0",
            heroUrl: "https://temp/hero-0",
            displayUrl: "",
            downloadUrl: "",
            hydrated: false,
          },
          {
            index: 1,
            fileID: "cloud://env/display-1.jpg",
            thumbnailUrl: "https://temp/thumb-1",
            heroUrl: "",
            displayUrl: "",
            downloadUrl: "",
            hydrated: false,
          },
        ],
      },
    },
  }));

  const detail = await service.fetchCaseDetail("doc_1");
  assert.equal(calls[0].data.detailMode, "initial_v2");
  assert.equal(detail.detailSchemaVersion, 2);
  assert.equal(detail.detailMode, "initial_v2");
  assert.equal(detail.coverImageUrl, "https://temp/hero-0");
  assert.equal(detail.gallery[0].displayUrl, "");
  assert.equal(detail.gallery[0].url, "https://temp/hero-0");
  assert.equal(detail.gallery[1].thumbnailUrl, "https://temp/thumb-1");
});

await test("detail patch accepts v2 patches and legacy full responses", async () => {
  const v2 = loadService(async () => ({
    result: {
      ok: true,
      detailSchemaVersion: 2,
      detailMode: "gallery_patch_v2",
      galleryPatch: [
        {
          index: 1,
          fileID: "cloud://env/display-1.jpg",
          displayUrl: "https://temp/display-1",
          downloadUrl: "https://temp/display-1",
        },
      ],
    },
  }));
  assert.deepEqual(
    plain(await v2.service.fetchCaseDetailPatch("doc_1", [1, 1, "2", -1])),
    [{
      index: 1,
      fileID: "cloud://env/display-1.jpg",
      displayUrl: "https://temp/display-1",
      downloadUrl: "https://temp/display-1",
    }]
  );
  assert.deepEqual(plain(v2.calls[0].data.indexes), [1]);

  const legacy = loadService(async () => ({
    result: {
      ok: true,
      item: {
        id: "doc_1",
        title: "案例",
        gallery: [
          {
            fileID: "cloud://env/display-0.jpg",
            displayUrl: "https://temp/display-0",
            thumbnailUrl: "https://temp/thumb-0",
            downloadUrl: "https://temp/display-0",
          },
        ],
      },
    },
  }));
  assert.deepEqual(
    plain(await legacy.service.fetchCaseDetailPatch("doc_1", [0])),
    [{
      index: 0,
      fileID: "cloud://env/display-0.jpg",
      displayUrl: "https://temp/display-0",
      downloadUrl: "https://temp/display-0",
    }]
  );
});

await test("detail patch splits a full gallery into batches of at most nine indexes", async () => {
  const { calls, service } = loadService(async ({ data }) => ({
    result: {
      ok: true,
      detailSchemaVersion: 2,
      detailMode: "gallery_patch_v2",
      galleryPatch: data.indexes.map((index) => ({
        index,
        fileID: `cloud://env/batch-${index}.jpg`,
        displayUrl: `https://temp/batch-${index}`,
      })),
    },
  }));
  const indexes = Array.from({ length: 12 }, (_, index) => index);
  const patches = await service.fetchCaseDetailPatch("doc_batch", indexes);
  assert.equal(patches.length, 12);
  assert.equal(calls.length, 2);
  assert.deepEqual(plain(calls[0].data.indexes), indexes.slice(0, 9));
  assert.deepEqual(plain(calls[1].data.indexes), indexes.slice(9));
});
