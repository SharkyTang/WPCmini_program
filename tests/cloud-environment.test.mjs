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

test("develop and trial use the existing non-production staging environment", () => {
  assert.equal(envConfig.CLOUD_ENVIRONMENT_IDS.develop, envConfig.STAGING_ENV_ID);
  assert.equal(envConfig.CLOUD_ENVIRONMENT_IDS.trial, envConfig.STAGING_ENV_ID);
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
  assert.deepEqual(JSON.parse(JSON.stringify(cloudInitOptions)), {
    env: envConfig.PRODUCTION_ENV_ID,
    traceUser: true,
  });
});
