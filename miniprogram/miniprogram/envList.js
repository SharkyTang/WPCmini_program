const PRODUCTION_ENV_ID = "cloud1-d3gznsms746425a42";
const STAGING_ENV_ID = "wine-admin-staging-d5c4cf20f02c5";
const CLOUD_ENVIRONMENT_IDS = Object.freeze({
  develop: PRODUCTION_ENV_ID,
  trial: STAGING_ENV_ID,
  release: PRODUCTION_ENV_ID,
});

const envList = Object.keys(CLOUD_ENVIRONMENT_IDS)
  .map((envVersion) => ({
    envId: CLOUD_ENVIRONMENT_IDS[envVersion],
    alias: envVersion,
  }))
  .filter((item) => item.envId);
const isMac = false;

function normalizeEnvVersion(value) {
  return ["develop", "trial", "release"].includes(value) ? value : "release";
}

function resolveCloudEnvironment(envVersion, environmentIds = CLOUD_ENVIRONMENT_IDS) {
  const version = normalizeEnvVersion(envVersion);
  const configuredEnv = environmentIds && typeof environmentIds[version] === "string"
    ? environmentIds[version].trim()
    : "";
  return configuredEnv || PRODUCTION_ENV_ID;
}

function getMiniProgramEnvVersion(wxApi) {
  try {
    const accountInfo = wxApi && typeof wxApi.getAccountInfoSync === "function"
      ? wxApi.getAccountInfoSync()
      : null;
    return normalizeEnvVersion(
      accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion
    );
  } catch (error) {
    return "release";
  }
}

module.exports = {
  CLOUD_ENVIRONMENT_IDS,
  PRODUCTION_ENV_ID,
  STAGING_ENV_ID,
  envList,
  getMiniProgramEnvVersion,
  isMac,
  normalizeEnvVersion,
  resolveCloudEnvironment,
};
