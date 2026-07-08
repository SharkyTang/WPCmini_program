function getGlobalData() {
  if (typeof getApp !== "function") return null;
  const app = getApp();
  return app && app.globalData ? app.globalData : null;
}

function normalizeVersion(value) {
  return Number.isFinite(value) ? value : 0;
}

function getCaseDataVersion() {
  const globalData = getGlobalData();
  return normalizeVersion(globalData && globalData.caseDataVersion);
}

function markCaseDataStale() {
  const globalData = getGlobalData();
  if (!globalData) return 0;

  const nextVersion = getCaseDataVersion() + 1;
  globalData.caseDataVersion = nextVersion;
  return nextVersion;
}

function shouldRefreshCaseData(lastLoadedVersion) {
  return normalizeVersion(lastLoadedVersion) !== getCaseDataVersion();
}

module.exports = {
  getCaseDataVersion,
  markCaseDataStale,
  shouldRefreshCaseData,
};
