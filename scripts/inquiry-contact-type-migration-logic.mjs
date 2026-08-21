const INQUIRY_COLLECTION = "inquiries";
const CONTACT_TYPE_SOURCE = "inferred_legacy";
const VALID_CONTACT_TYPES = Object.freeze(["wechat", "phone", "email"]);
const VALID_CONTACT_TYPE_SET = new Set(VALID_CONTACT_TYPES);
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 50;

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeExistingContactType(value) {
  const contactType = trimText(value).toLowerCase();
  return VALID_CONTACT_TYPE_SET.has(contactType) ? contactType : "";
}

function isEmptyContactType(value) {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.trim() === "";
}

function isStrictEmail(value) {
  const email = trimText(value);
  if (!email || email.length > 254) return false;
  const separatorIndex = email.indexOf("@");
  const localPart = separatorIndex >= 0 ? email.slice(0, separatorIndex) : "";
  if (
    !localPart
    || localPart.length > 64
    || localPart.startsWith(".")
    || localPart.endsWith(".")
    || localPart.includes("..")
  ) {
    return false;
  }
  const emailPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
  return emailPattern.test(email);
}

function normalizeMainlandPhone(value) {
  return trimText(value).replace(/[\s-]/g, "");
}

function isStrictMainlandPhone(value) {
  return /^(?:\+?86)?1[3-9]\d{9}$/.test(normalizeMainlandPhone(value));
}

function inferLegacyContactType(contact) {
  const normalizedContact = trimText(contact);
  if (!normalizedContact) {
    return {
      contactType: "",
      source: "unknown",
      reason: "empty_contact",
    };
  }
  if (isStrictEmail(normalizedContact)) {
    return {
      contactType: "email",
      source: CONTACT_TYPE_SOURCE,
      reason: "strict_email",
    };
  }
  if (isStrictMainlandPhone(normalizedContact)) {
    return {
      contactType: "phone",
      source: CONTACT_TYPE_SOURCE,
      reason: "strict_mainland_phone",
    };
  }
  return {
    contactType: "wechat",
    source: CONTACT_TYPE_SOURCE,
    reason: "legacy_nonempty_fallback",
  };
}

function snapshotRecord(record = {}) {
  return {
    contact: typeof record.contact === "string" ? record.contact : "",
    contactType: record.contactType === undefined ? null : record.contactType,
    contactTypeSource: record.contactTypeSource === undefined
      ? null
      : record.contactTypeSource,
  };
}

function classifyInquiryRecord(record = {}) {
  const id = trimText(record._id);
  const before = snapshotRecord(record);
  const normalizedExistingType = normalizeExistingContactType(record.contactType);

  if (!id) {
    return {
      id: "",
      action: "skip",
      reason: "missing_id",
      before,
      after: before,
    };
  }

  if (normalizedExistingType) {
    return {
      id,
      action: "skip",
      reason: "valid_existing_contact_type",
      before,
      after: before,
    };
  }

  if (!isEmptyContactType(record.contactType)) {
    return {
      id,
      action: "skip",
      reason: "invalid_existing_contact_type",
      before,
      after: before,
    };
  }

  const inference = inferLegacyContactType(record.contact);
  if (!inference.contactType) {
    return {
      id,
      action: "skip",
      reason: inference.reason,
      inference: {
        contactType: "unknown",
        source: inference.source,
      },
      before,
      after: before,
    };
  }

  return {
    id,
    action: "migrate",
    reason: inference.reason,
    expectedContact: before.contact,
    inference: {
      contactType: inference.contactType,
      source: inference.source,
    },
    before,
    after: {
      ...before,
      contactType: inference.contactType,
      contactTypeSource: inference.source,
    },
  };
}

function normalizePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), maximum);
}

function countBy(entries, selector) {
  return entries.reduce((counts, entry) => {
    const key = selector(entry);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function buildMigrationPlan(records = [], options = {}) {
  const entries = records.map(classifyInquiryRecord);
  const candidates = entries.filter((entry) => entry.action === "migrate");
  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(0, Math.floor(Number(options.limit)))
    : 0;
  const selectedIds = new Set(
    (limit > 0 ? candidates.slice(0, limit) : candidates).map((entry) => entry.id)
  );

  const plannedEntries = entries.map((entry) => {
    if (entry.action !== "migrate") {
      return { ...entry, outcome: "skipped" };
    }
    if (!selectedIds.has(entry.id)) {
      return { ...entry, outcome: "not_selected_limit" };
    }
    return { ...entry, outcome: "planned" };
  });

  return {
    entries: plannedEntries,
    summary: {
      scanned: records.length,
      candidates: candidates.length,
      selected: selectedIds.size,
      skipped: entries.length - candidates.length,
      reasons: countBy(entries, (entry) => entry.reason),
      inferredTypes: countBy(
        candidates,
        (entry) => entry.after.contactType
      ),
    },
  };
}

function getDocumentData(response) {
  if (!response) return null;
  if (Array.isArray(response.data)) return response.data[0] || null;
  return response.data && typeof response.data === "object" ? response.data : null;
}

function verifyWritePreconditions(entry, currentRecord) {
  if (!currentRecord) {
    return { valid: false, reason: "document_missing" };
  }
  if (currentRecord.contact !== entry.expectedContact) {
    return { valid: false, reason: "contact_changed" };
  }
  if (!isEmptyContactType(currentRecord.contactType)) {
    return { valid: false, reason: "contact_type_no_longer_empty" };
  }
  return { valid: true, reason: "" };
}

async function applyMigrationEntry(db, entry, options = {}) {
  const collectionName = options.collection || INQUIRY_COLLECTION;
  try {
    return await db.runTransaction(async (transaction) => {
      const document = transaction.collection(collectionName).doc(entry.id);
      const response = await document.get();
      const currentRecord = getDocumentData(response);
      const precondition = verifyWritePreconditions(entry, currentRecord);
      if (!precondition.valid) {
        return {
          ...entry,
          outcome: "skipped_precondition",
          resultReason: precondition.reason,
          current: snapshotRecord(currentRecord || {}),
        };
      }

      await document.update({
        contactType: entry.after.contactType,
        contactTypeSource: CONTACT_TYPE_SOURCE,
      });
      return {
        ...entry,
        outcome: "updated",
        resultReason: "",
        current: snapshotRecord(currentRecord),
      };
    });
  } catch (error) {
    return {
      ...entry,
      outcome: "failed",
      resultReason: error && error.message ? error.message : String(error),
    };
  }
}

function chunkEntries(entries, batchSize) {
  const chunks = [];
  for (let index = 0; index < entries.length; index += batchSize) {
    chunks.push(entries.slice(index, index + batchSize));
  }
  return chunks;
}

async function applyMigrationPlan(db, plan, options = {}) {
  const batchSize = normalizePositiveInteger(
    options.batchSize,
    DEFAULT_BATCH_SIZE,
    MAX_BATCH_SIZE
  );
  const selectedEntries = plan.entries.filter((entry) => entry.outcome === "planned");
  const resultsById = new Map();

  for (const batch of chunkEntries(selectedEntries, batchSize)) {
    const results = await Promise.all(
      batch.map((entry) => applyMigrationEntry(db, entry, options))
    );
    results.forEach((result) => resultsById.set(result.id, result));
  }

  const entries = plan.entries.map((entry) => resultsById.get(entry.id) || entry);
  return {
    entries,
    summary: {
      ...plan.summary,
      outcomes: countBy(entries, (entry) => entry.outcome),
    },
  };
}

async function fetchAllInquiries(db, options = {}) {
  const collectionName = options.collection || INQUIRY_COLLECTION;
  const pageSize = normalizePositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1000);
  const records = [];
  let offset = 0;
  while (true) {
    const response = await db
      .collection(collectionName)
      .skip(offset)
      .limit(pageSize)
      .get();
    const page = Array.isArray(response && response.data) ? response.data : [];
    records.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return records;
}

async function runInquiryContactTypeMigration(db, options = {}) {
  const records = await fetchAllInquiries(db, options);
  const plan = buildMigrationPlan(records, options);
  if (!options.apply) {
    return {
      mode: "dry-run",
      ...plan,
      summary: {
        ...plan.summary,
        outcomes: countBy(plan.entries, (entry) => entry.outcome),
      },
    };
  }
  const applied = await applyMigrationPlan(db, plan, options);
  return {
    mode: "apply",
    ...applied,
  };
}

export {
  CONTACT_TYPE_SOURCE,
  DEFAULT_BATCH_SIZE,
  INQUIRY_COLLECTION,
  MAX_BATCH_SIZE,
  VALID_CONTACT_TYPES,
  applyMigrationEntry,
  applyMigrationPlan,
  buildMigrationPlan,
  classifyInquiryRecord,
  fetchAllInquiries,
  inferLegacyContactType,
  isEmptyContactType,
  isStrictEmail,
  isStrictMainlandPhone,
  normalizeExistingContactType,
  runInquiryContactTypeMigration,
  verifyWritePreconditions,
};
