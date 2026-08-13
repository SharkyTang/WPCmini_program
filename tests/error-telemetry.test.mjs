import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/errorTelemetry.js"
);

function loadTelemetry(reportEvent) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    getCurrentPages() {
      return [{ route: "pages/category/index?openid=private-user" }];
    },
    wx: {
      reportEvent,
      getDeviceInfo() {
        return {
          platform: "android",
          benchmarkLevel: 20,
          model: "private-model-name",
          system: "private-system-version",
        };
      },
      getAppBaseInfo() {
        return { SDKVersion: "3.7.1" };
      },
      getAccountInfoSync() {
        return {
          miniProgram: {
            appId: "private-app-id",
            version: "1.2.2",
            envVersion: "release",
          },
        };
      },
      getLaunchOptionsSync() {
        return {
          scene: 1001,
          query: { phone: "13800138000" },
        };
      },
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

await test("fault telemetry sends only bounded fields and hashes raw errors", () => {
  const calls = [];
  const telemetry = loadTelemetry((name, payload) => calls.push({ name, payload }));
  const privateError = new Error("openid private-user phone 13800138000");
  privateError.code = "https://private-user.example/secret";
  privateError.stack = "Error: private-user\n at secretFunction (/private/path.js:1:2)";

  assert.equal(telemetry.reportClientFault({
    type: "category_error",
    stage: "load_catalog",
    error: privateError,
    route: "/pages/category/index?openid=private-user",
    action: "load_catalog",
    requestKind: "fallback",
    cacheState: "miss",
    openid: "private-user",
  }), true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, telemetry.TELEMETRY_EVENT_NAME);
  assert.equal(calls[0].payload.route, "pages/category/index");
  assert.equal(calls[0].payload.platform, "android");
  assert.equal(calls[0].payload.device_tier, "mid");
  assert.equal(calls[0].payload.error_code, "UNKNOWN_ERROR");
  const serialized = JSON.stringify(calls[0]);
  for (const privateValue of [
    "private-user",
    "13800138000",
    "secretFunction",
    "/private/path.js",
    "private-model-name",
    "private-system-version",
    "private-app-id",
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

await test("non-fatal fault telemetry deduplicates and caps each session at five events", () => {
  const calls = [];
  const telemetry = loadTelemetry((name, payload) => calls.push({ name, payload }));
  const duplicate = {
    type: "category_error",
    stage: "duplicate",
    code: "TEST_FAILURE",
  };

  assert.equal(telemetry.reportClientFault(duplicate), true);
  assert.equal(telemetry.reportClientFault(duplicate), false);
  for (let index = 1; index < 15; index += 1) {
    telemetry.reportClientFault({
      type: "category_error",
      stage: `stage_${index}`,
      code: `TEST_${index}`,
    });
  }
  assert.equal(calls.length, telemetry.MAX_NON_FATAL_EVENTS_PER_SESSION);
});

await test("fatal, unhandled, and page-not-found telemetry keeps a ten event budget", () => {
  const calls = [];
  const telemetry = loadTelemetry((name, payload) => calls.push({ name, payload }));

  for (let index = 0; index < 15; index += 1) {
    telemetry.reportClientFault({
      type: index % 2 === 0 ? "unhandled_rejection" : "page_not_found",
      stage: `fatal_stage_${index}`,
      code: `FATAL_${index}`,
    });
  }

  assert.equal(calls.length, telemetry.MAX_FATAL_EVENTS_PER_SESSION);
  assert.equal(calls.every((call) => call.name === "client_fault"), true);
});

await test("performance telemetry uses a fixed event id and drops extra fields", () => {
  const calls = [];
  const telemetry = loadTelemetry((name, payload) => calls.push({ name, payload }));

  assert.equal(telemetry.reportPerformanceEvent("client_boot_result", {
    route: "pages/index/index?token=private-token",
    stage: "success",
    durationMs: 99999999,
    success: true,
    requestKind: "network",
    cacheState: "miss",
    duration_bucket: "5000ms_plus",
    shell_bucket: "under_500ms",
    on_ready_bucket: "500_999ms",
    hero_bucket: "1000_1999ms",
    data_bucket: "2000_4999ms",
    secret_bucket: "private-bucket",
    openid: "private-user",
  }), true);

  assert.equal(calls[0].name, "client_boot_result");
  assert.equal(calls[0].payload.duration_ms, 600000);
  assert.equal(calls[0].payload.duration_bucket, "5000ms_plus");
  assert.equal(calls[0].payload.shell_bucket, "under_500ms");
  assert.equal(calls[0].payload.on_ready_bucket, "500_999ms");
  assert.equal(calls[0].payload.hero_bucket, "1000_1999ms");
  assert.equal(calls[0].payload.data_bucket, "2000_4999ms");
  assert.equal(calls[0].payload.route, "pages/index/index");
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].payload, "openid"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].payload, "secret_bucket"), false);
  assert.equal(JSON.stringify(calls[0]).includes("private-token"), false);
  assert.equal(telemetry.normalizeDurationBucket("private-bucket"), "unknown");
});

await test("performance telemetry only accepts configured backend event names", () => {
  const calls = [];
  const telemetry = loadTelemetry((name, payload) => calls.push({ name, payload }));

  assert.equal(telemetry.reportPerformanceEvent("unknown_event", {}), false);
  assert.equal(telemetry.reportPerformanceEvent("page_ready_result", {
    route: "pages/detail/index",
    durationMs: 120,
    shell_bucket: "under_500ms",
  }), true);
  assert.deepEqual(calls.map((call) => call.name), ["page_ready_result"]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(calls[0].payload, "shell_bucket"),
    false
  );
});

await test("telemetry never throws when the native reporting API fails", () => {
  const telemetry = loadTelemetry(() => {
    throw new Error("reportEvent unavailable");
  });

  assert.equal(telemetry.reportClientFault({ stage: "native_failure" }), false);
  assert.equal(
    telemetry.reportPerformanceEvent("client_boot_result", {
      stage: "native_failure",
    }),
    false
  );
});
