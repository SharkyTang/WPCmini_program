const crypto = require("crypto");

const FAVORITE_LIMIT = 100;
const HISTORY_LIMIT = 50;
const CASE_ID_MAX_LENGTH = 128;
const RECORD_ID_MAX_LENGTH = 128;
const BATCH_ID_LIMIT = 100;

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCaseReference(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const caseDocId = trimText(source.caseDocId || source.id || source._id);
  const caseId = trimText(source.caseId) || caseDocId;
  if (
    (!caseDocId && !caseId)
    || caseDocId.length > CASE_ID_MAX_LENGTH
    || caseId.length > CASE_ID_MAX_LENGTH
  ) {
    return null;
  }
  return { caseDocId, caseId };
}

function normalizeRecordIds(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map(trimText)
        .filter((id) => id && id.length <= RECORD_ID_MAX_LENGTH)
    )
  ).slice(0, BATCH_ID_LIMIT);
}

function buildLibraryDocumentId(type, openid, reference = {}) {
  const prefix = type === "history" ? "his_" : "fav_";
  const caseKey = reference.caseDocId || reference.caseId;
  const digest = crypto
    .createHash("sha256")
    .update(`${trimText(openid)}\n${trimText(caseKey)}`)
    .digest("hex");
  return `${prefix}${digest.slice(0, 28)}`;
}

module.exports = {
  BATCH_ID_LIMIT,
  FAVORITE_LIMIT,
  HISTORY_LIMIT,
  buildLibraryDocumentId,
  normalizeCaseReference,
  normalizeRecordIds,
  trimText,
};
