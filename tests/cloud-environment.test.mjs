import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envConfigPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/envList.js"
);
const appPath = resolve(__dirname, "../miniprogram/miniprogram/app.js");
function loadCommonJsModule(filePath) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(filePath, "utf8"), sandbox, {
    filename: filePath,
  });
  return sandbox.module.exports;
}

const envConfig = loadCommonJsModule(envConfigPath);

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("cloud environments map develop, trial and release through a pure resolver", () => {
  const configured = {
    develop: "cloud-develop",
    trial: "cloud-trial",
    release: "cloud-release",
  };
  assert.equal(envConfig.resolveCloudEnvironment("develop", configured), "cloud-develop");
  assert.equal(envConfig.resolveCloudEnvironment("trial", configured), "cloud-trial");
  assert.equal(envConfig.resolveCloudEnvironment("release", configured), "cloud-release");
});

test("develop, trial and release use the same production environment", () => {
  assert.equal(envConfig.CLOUD_ENVIRONMENT_IDS.develop, envConfig.PRODUCTION_ENV_ID);
  assert.equal(envConfig.CLOUD_ENVIRONMENT_IDS.trial, envConfig.PRODUCTION_ENV_ID);
  assert.equal(envConfig.CLOUD_ENVIRONMENT_IDS.release, envConfig.PRODUCTION_ENV_ID);
  assert.notEqual(envConfig.STAGING_ENV_ID, envConfig.PRODUCTION_ENV_ID);
});

test("missing, blank and unknown environment values safely use the current production cloud", () => {
  assert.equal(
    envConfig.resolveCloudEnvironment("develop", { develop: "   " }),
    envConfig.PRODUCTION_ENV_ID
  );
  assert.equal(
    envConfig.resolveCloudEnvironment("unknown", {}),
    envConfig.PRODUCTION_ENV_ID
  );
  assert.equal(envConfig.normalizeEnvVersion(), "release");
});

test("runtime environment detection is defensive", () => {
  assert.equal(envConfig.getMiniProgramEnvVersion({
    getAccountInfoSync() {
      return { miniProgram: { envVersion: "trial" } };
    },
  }), "trial");
  assert.equal(envConfig.getMiniProgramEnvVersion({
    getAccountInfoSync() {
      throw new Error("not ready");
    },
  }), "release");
});

test("the release app initializes the unchanged production environment", () => {
  let appConfig;
  let cloudInitOptions;
  const sandbox = {
    App(config) {
      appConfig = config;
    },
    console,
    require(moduleName) {
      if (moduleName === "./envList") return envConfig;
      if (moduleName === "./utils/errorTelemetry") {
        return { reportClientFault() {} };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {
      getAccountInfoSync() {
        return { miniProgram: { envVersion: "release" } };
      },
      cloud: {
        init(options) {
          cloudInitOptions = options;
        },
      },
    },
  };
  vm.runInNewContext(readFileSync(appPath, "utf8"), sandbox, {
    filename: appPath,
  });
  const app = {};
  appConfig.onLaunch.call(app);
  assert.equal(app.globalData.envVersion, "release");
  assert.equal(app.globalData.env, envConfig.PRODUCTION_ENV_ID);
  assert.equal(app.globalData.cloudReady, true);
  assert.deepEqual(JSON.parse(JSON.stringify(cloudInitOptions)), {
    env: envConfig.PRODUCTION_ENV_ID,
    traceUser: true,
  });
});

test("app hooks contain cloud failures and recover missing pages without throwing", () => {
  let appConfig;
  const reports = [];
  const relaunches = [];
  const cloudError = new Error("cloud init failed with private detail");
  const sandbox = {
    App(config) {
      appConfig = config;
    },
    console: {
      ...console,
      error() {},
    },
    require(moduleName) {
      if (moduleName === "./envList") return envConfig;
      if (moduleName === "./utils/errorTelemetry") {
        return {
          reportClientFault(payload) {
            reports.push(payload);
            return true;
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {
      getAccountInfoSync() {
        return { miniProgram: { envVersion: "release" } };
      },
      cloud: {
        init() {
          throw cloudError;
        },
      },
      reLaunch(options) {
        relaunches.push(options.url);
      },
    },
  };

  vm.runInNewContext(readFileSync(appPath, "utf8"), sandbox, {
    filename: appPath,
  });
  const app = {};
  appConfig.onLaunch.call(app);
  appConfig.onError.call(app, "page runtime failure");
  appConfig.onUnhandledRejection.call(app, {
    reason: new Error("promise failure"),
  });
  appConfig.onPageNotFound.call(app, {
    path: "pages/removed/index?private=value",
  });

  assert.equal(app.globalData.cloudReady, false);
  assert.deepEqual(relaunches, ["/pages/index/index"]);
  assert.deepEqual(
    reports.map((report) => report.type),
    [
      "cloud_init_error",
      "app_error",
      "unhandled_rejection",
      "page_not_found",
    ]
  );
});

test("page-not-found fallback does not relaunch the home route recursively", () => {
  let appConfig;
  let relaunchCount = 0;
  const sandbox = {
    App(config) {
      appConfig = config;
    },
    console,
    require(moduleName) {
      if (moduleName === "./envList") return envConfig;
      if (moduleName === "./utils/errorTelemetry") {
        return { reportClientFault() {} };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {
      reLaunch() {
        relaunchCount += 1;
      },
    },
  };

  vm.runInNewContext(readFileSync(appPath, "utf8"), sandbox, {
    filename: appPath,
  });
  appConfig.onPageNotFound.call({ globalData: {} }, {
    path: "pages/index/index?from=missing",
  });
  assert.equal(relaunchCount, 0);
});

await asyncTest("an asynchronous cloud init rejection is consumed by the app", async () => {
  let appConfig;
  let rejectCloudInit;
  const reports = [];
  const sandbox = {
    App(config) {
      appConfig = config;
    },
    console: {
      ...console,
      error() {},
    },
    require(moduleName) {
      if (moduleName === "./envList") return envConfig;
      if (moduleName === "./utils/errorTelemetry") {
        return {
          reportClientFault(payload) {
            reports.push(payload);
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {
      getAccountInfoSync() {
        return { miniProgram: { envVersion: "release" } };
      },
      cloud: {
        init() {
          return new Promise((resolvePromise, rejectPromise) => {
            rejectCloudInit = rejectPromise;
          });
        },
      },
    },
  };

  vm.runInNewContext(readFileSync(appPath, "utf8"), sandbox, {
    filename: appPath,
  });
  const app = {};
  appConfig.onLaunch.call(app);
  assert.equal(app.globalData.cloudReady, false);
  rejectCloudInit(new Error("async init failure"));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(app.globalData.cloudReady, false);
  assert.equal(reports.at(-1).stage, "cloud_init_async");
});
