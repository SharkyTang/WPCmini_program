import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/libraryAccessConfig.js"
);
const servicePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/libraryAccessService.js"
);

export function loadOpenIdLibraryAccessService(kind) {
  const flagName = kind === "history"
    ? "historyIdentityMode"
    : "favoritesIdentityMode";
  const flagPattern = `${flagName}: LIBRARY_ACCESS_MODE.PROFILE`;
  const enabledFlagPattern = `${flagName}: LIBRARY_ACCESS_MODE.OPENID`;
  const configSource = readFileSync(configPath, "utf8");
  if (
    !configSource.includes(flagPattern)
    && !configSource.includes(enabledFlagPattern)
  ) {
    throw new Error(`Missing build-time library flag: ${flagName}`);
  }
  const openIdConfigSource = configSource.includes(flagPattern)
    ? configSource.replace(flagPattern, enabledFlagPattern)
    : configSource;

  const configSandbox = {
    module: { exports: {} },
    exports: {},
  };
  configSandbox.exports = configSandbox.module.exports;
  vm.runInNewContext(
    openIdConfigSource,
    configSandbox,
    { filename: configPath }
  );

  let profileChecks = 0;
  let openidChecks = 0;
  const serviceSandbox = {
    module: { exports: {} },
    exports: {},
    console,
    Date,
    encodeURIComponent,
    require(moduleName) {
      if (moduleName === "./libraryAccessConfig") {
        return configSandbox.module.exports;
      }
      if (moduleName === "./userService") {
        return {
          async ensureProfileIdentity() {
            profileChecks += 1;
            throw new Error("OpenID mode must not check profile completeness");
          },
          async ensureWxIdentity() {
            openidChecks += 1;
            return "openid_1";
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {},
  };
  serviceSandbox.exports = serviceSandbox.module.exports;
  vm.runInNewContext(readFileSync(servicePath, "utf8"), serviceSandbox, {
    filename: servicePath,
  });

  return {
    service: serviceSandbox.module.exports,
    get openidChecks() {
      return openidChecks;
    },
    get profileChecks() {
      return profileChecks;
    },
  };
}
