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
  const cloud = {
    DYNAMIC_CURRENT_ENV: Symbol("DYNAMIC_CURRENT_ENV"),
    init() {},
    getWXContext() {
      return { OPENID: "admin_1" };
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
      if (moduleName === "sharp") {
        if (options.sharpError) throw options.sharpError;
        return {
          versions: {
            sharp: "0.33.5",
          },
        };
      }
      if (moduleName === "./imageProcessorLogic") return require(logicPath);
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  vm.runInNewContext(readFileSync(mainPath, "utf8"), sandbox, {
    filename: mainPath,
  });
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

await test("unknown actions do not load the native image dependency", async () => {
  const main = loadMain({
    sharpError: new Error("native module cannot load"),
  });
  const result = await main({ action: "probe" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "UNKNOWN_ACTION");
});

await test("health checks return a structured native dependency error", async () => {
  const main = loadMain({
    sharpError: new Error("native module cannot load"),
  });
  const result = await main({ action: "healthCheck" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "IMAGE_PROCESSOR_UNAVAILABLE");
  assert.equal(result.message, "native module cannot load");
});

await test("health checks expose the loaded sharp version", async () => {
  const main = loadMain();
  const result = await main({ action: "healthCheck" });

  assert.equal(result.ok, true);
  assert.equal(result.sharpVersion, "0.33.5");
});
