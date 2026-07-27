import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/cloudfunctions/quickstartFunctions/index.js"
);

function loadQuickstartFunctions() {
  const mockCloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-env",
    init() {},
    getWXContext() {
      return {
        OPENID: "openid_1",
        APPID: "appid_1",
        UNIONID: "unionid_1",
      };
    },
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(moduleName) {
      if (moduleName === "wx-server-sdk") return mockCloud;
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, {
    filename: modulePath,
  });
  return sandbox.module.exports;
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

await test("quickstartFunctions only returns current openid for getOpenId", async () => {
  const quickstartFunctions = loadQuickstartFunctions();
  const result = await quickstartFunctions.main({ type: "getOpenId" });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    openid: "openid_1",
    appid: "appid_1",
    unionid: "unionid_1",
  });
});

await test("quickstartFunctions rejects removed template database actions", async () => {
  const quickstartFunctions = loadQuickstartFunctions();
  const result = await quickstartFunctions.main({ type: "selectRecord" });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    code: "UNKNOWN_TYPE",
    message: "未知云函数操作",
  });
});
