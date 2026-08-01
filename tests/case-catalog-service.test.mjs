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
