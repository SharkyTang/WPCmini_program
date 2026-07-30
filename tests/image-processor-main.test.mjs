import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mainPath = resolve(
  __dirname,
  "../miniprogram/cloudfunctions/imageProcessor/index.js"
);
const logicPath = resolve(
  __dirname,
  "../miniprogram/cloudfunctions/imageProcessor/imageProcessorLogic.js"
);

function loadMain(options = {}) {
  const exported = {};
  const calls = {
    uploads: [],
    deletions: [],
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: Symbol("DYNAMIC_CURRENT_ENV"),
    init() {},
    getWXContext() {
      return { OPENID: "admin_1" };
    },
    async downloadFile() {
      return { fileContent: Buffer.from("source") };
    },
    async uploadFile({ cloudPath }) {
      calls.uploads.push(cloudPath);
      if (calls.uploads.length === options.uploadFailureIndex) {
        throw new Error("upload failed");
      }
      return { fileID: `cloud://env/${cloudPath}` };
    },
    async deleteFile({ fileList }) {
      calls.deletions.push(fileList);
      return {};
    },
  };
  const sandbox = {
    Buffer,
    console: {
      ...console,
      error() {},
    },
    exports: exported,
    process: {
      env: {
        ADMIN_OPENIDS: "admin_1",
      },
    },
    require(moduleName) {
      if (moduleName === "wx-server-sdk") return cloud;
      if (moduleName === "jimp") {
        if (options.imageLibraryError) throw options.imageLibraryError;
        return {};
      }
      if (moduleName === "jimp/package.json") {
        return { version: "0.22.12" };
      }
      if (moduleName === "./jimpSharpCompat") {
        return {
          createJimpSharpCompat() {
            return {
              versions: {
                jimp: "0.22.12",
              },
            };
          },
        };
      }
      if (moduleName === "./imageProcessorLogic") {
        return {
          ...require(logicPath),
          ...(options.logic || {}),
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  vm.runInNewContext(readFileSync(mainPath, "utf8"), sandbox, {
    filename: mainPath,
  });
  exported.main.calls = calls;
  return exported.main;
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

await test("unknown actions do not load the image dependency", async () => {
  const main = loadMain({
    imageLibraryError: new Error("image library cannot load"),
  });
  const result = await main({ action: "probe" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "UNKNOWN_ACTION");
});

await test("health checks return a structured image dependency error", async () => {
  const main = loadMain({
    imageLibraryError: new Error("image library cannot load"),
  });
  const result = await main({ action: "healthCheck" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "IMAGE_PROCESSOR_UNAVAILABLE");
  assert.equal(result.message, "image library cannot load");
});

await test("health checks expose the loaded image library version", async () => {
  const main = loadMain();
  const result = await main({ action: "healthCheck" });

  assert.equal(result.ok, true);
  assert.equal(result.imageLibrary, "jimp");
  assert.equal(result.imageLibraryVersion, "0.22.12");
});

await test("case variants return display, thumbnail and banner v2 files", async () => {
  const main = loadMain({
    logic: {
      async generateVariantBuffers() {
        return {
          displayBuffer: Buffer.from("display"),
          thumbnailBuffer: Buffer.from("thumbnail"),
          bannerBuffer: Buffer.from("banner"),
          metadata: {
            bannerBytes: 6,
            bannerQuality: 72,
            variantVersion: 2,
          },
        };
      },
    },
  });
  const result = await main({
    action: "generateCaseVariants",
    files: ["cloud://env/source.jpg"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.variants.length, 1);
  assert.match(result.variants[0].displayFileID, /display\.jpg$/);
  assert.match(result.variants[0].thumbnailFileID, /thumbnail\.jpg$/);
  assert.match(result.variants[0].bannerFileID, /banner\.jpg$/);
  assert.equal(result.variants[0].variantVersion, 2);
});

await test("case variants accept nine images and reject the tenth", async () => {
  const main = loadMain({
    logic: {
      async generateVariantBuffers() {
        return {
          displayBuffer: Buffer.from("display"),
          thumbnailBuffer: Buffer.from("thumbnail"),
          bannerBuffer: Buffer.from("banner"),
          metadata: { variantVersion: 2 },
        };
      },
    },
  });
  const files = Array.from(
    { length: 9 },
    (_, index) => `cloud://env/source-${index}.jpg`
  );
  const accepted = await main({
    action: "generateCaseVariants",
    files,
  });
  const rejected = await main({
    action: "generateCaseVariants",
    files: [...files, "cloud://env/source-9.jpg"],
  });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.variants.length, 9);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "INVALID_FILES");
  assert.match(rejected.message, /9 张以内/);
});

await test("partial v2 upload failures clean generated files", async () => {
  const main = loadMain({
    uploadFailureIndex: 3,
    logic: {
      async generateVariantBuffers() {
        return {
          displayBuffer: Buffer.from("display"),
          thumbnailBuffer: Buffer.from("thumbnail"),
          bannerBuffer: Buffer.from("banner"),
          metadata: { variantVersion: 2 },
        };
      },
    },
  });
  const result = await main({
    action: "generateCaseVariants",
    files: ["cloud://env/source.jpg"],
  });
  assert.equal(result.ok, false);
  assert.equal(main.calls.deletions.length, 1);
  assert.equal(main.calls.deletions[0].length, 2);
});

await test("batch failures clean variants generated for earlier images", async () => {
  const main = loadMain({
    uploadFailureIndex: 6,
    logic: {
      async generateVariantBuffers() {
        return {
          displayBuffer: Buffer.from("display"),
          thumbnailBuffer: Buffer.from("thumbnail"),
          bannerBuffer: Buffer.from("banner"),
          metadata: { variantVersion: 2 },
        };
      },
    },
  });
  const result = await main({
    action: "generateCaseVariants",
    files: ["cloud://env/source-1.jpg", "cloud://env/source-2.jpg"],
  });
  assert.equal(result.ok, false);
  assert.equal(main.calls.deletions.length, 2);
  assert.equal(main.calls.deletions[0].length, 2);
  assert.equal(main.calls.deletions[1].length, 3);
});
