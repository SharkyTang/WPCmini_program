const HOME_SECTION_VALUES = {
  BANNER: "banner",
  POPULAR: "popular",
  LATEST: "latest",
};

const USER_LIBRARY_LIMITS = {
  favorites: 100,
  history: 50,
};

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value.values)) return value.values.filter(Boolean);
  if (typeof value === "string") return value ? [value] : [];
  return [];
}

function firstImage(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstImage(value[0]);
  return firstImage(value.fileID || value.cloudID || value.url || value.tempFileURL);
}

function normalizeGallery(value, fallback = "") {
  const seen = new Set();
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return [...source, fallback]
    .map(firstImage)
    .filter(Boolean)
    .filter((fileID) => {
      if (seen.has(fileID)) return false;
      seen.add(fileID);
      return true;
    })
    .slice(0, 5);
}

function toNumber(value, fallback = 9999) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeCaseRecord(record = {}) {
  const legacyCover = firstImage(record.coverImage || record.image || record.images);
  const galleryImages = normalizeGallery(record.galleryImages, legacyCover);
  const normalizedSourceImages = normalizeGallery(record.sourceGalleryImages);
  const sourceGalleryImages = normalizedSourceImages.length
    ? normalizedSourceImages
    : galleryImages.slice();
  const galleryThumbnails = normalizeGallery(record.galleryThumbnails);
  const homeSections = normalizeValues(record.homeSections);
  const statuses = normalizeValues(record.statuses);
  const packageTypes = normalizeValues(record.packageTypes);
  const styles = normalizeValues(record.styles);
  const scenes = normalizeValues(record.scenes);
  const id = record._id || record.id || "";

  return {
    id,
    caseId: record.caseId || id,
    title: trimText(record.title || record.name) || "未命名案例",
    wineType: trimText(record.wineType) || "白酒",
    packageTypes,
    styles,
    priceLevel: trimText(record.priceLevel),
    scenes,
    statuses,
    homeSections,
    sortOrder: toNumber(record.sortOrder),
    isPinned: record.isPinned === true,
    isVisible: record.isVisible !== false,
    notes: trimText(record.notes || record.description),
    galleryImages,
    sourceGalleryImages,
    galleryThumbnails,
    coverImage: firstImage(record.coverImage) || galleryImages[0] || legacyCover,
    coverThumbnail:
      firstImage(record.coverThumbnail) || galleryThumbnails[0] || galleryImages[0] || legacyCover,
  };
}

function getCardImageFileId(item = {}) {
  return item.coverThumbnail || item.coverImage || "";
}

function buildCard(record = {}, urlMap = {}) {
  const item = normalizeCaseRecord(record);
  const imageFileId = getCardImageFileId(item);
  return {
    id: item.id,
    caseId: item.caseId,
    title: item.title,
    wineType: item.wineType,
    packageTypes: item.packageTypes,
    styles: item.styles,
    priceLevel: item.priceLevel,
    scenes: item.scenes,
    statuses: item.statuses,
    homeSections: item.homeSections,
    sortOrder: item.sortOrder,
    isPinned: item.isPinned,
    isVisible: item.isVisible,
    imageFileId,
    thumbnailUrl: urlMap[imageFileId] || "",
  };
}

function sortCases(items, direction = "asc") {
  const multiplier = direction === "desc" ? -1 : 1;
  return items.slice().sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) {
      return (left.sortOrder - right.sortOrder) * multiplier;
    }
    return String(left.caseId || left.id).localeCompare(String(right.caseId || right.id));
  });
}

function buildHomeCaseGroups(records = []) {
  const cases = records.map(normalizeCaseRecord).filter((item) => item.isVisible);
  const popularCases = sortCases(
    cases.filter((item) => item.homeSections.includes(HOME_SECTION_VALUES.POPULAR))
  ).slice(0, 4);
  const latestCases = sortCases(
    cases.filter((item) => item.homeSections.includes(HOME_SECTION_VALUES.LATEST)),
    "desc"
  ).slice(0, 6);
  const fallbackBanners = sortCases(
    cases.filter(
      (item) =>
        item.homeSections.includes(HOME_SECTION_VALUES.BANNER) && Boolean(item.coverImage)
    )
  )
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      caseId: item.caseId || item.id,
      title: item.title,
      image: item.coverImage,
      sortOrder: item.sortOrder,
    }));
  return { popularCases, latestCases, fallbackBanners };
}

function normalizeBanner(record = {}) {
  return {
    id: record._id || record.id || record.caseId || trimText(record.title),
    caseId: record.caseId || "",
    title: trimText(record.title),
    image: firstImage(record.image || record.coverImage),
    sortOrder: toNumber(record.sortOrder),
    isVisible: record.isVisible !== false,
  };
}

function buildBanners(records = [], fallbackBanners = [], urlMap = {}) {
  const seen = new Set();
  return [...records.map(normalizeBanner), ...fallbackBanners]
    .filter((item) => item.isVisible !== false && item.image)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .filter((item) => {
      const key = item.caseId || item.image || item.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      caseId: item.caseId,
      title: item.title,
      imageUrl: urlMap[item.image] || "",
    }));
}

function buildHomeFeed(caseRecords = [], bannerRecords = [], urlMap = {}) {
  const groups = buildHomeCaseGroups(caseRecords);
  return {
    banners: buildBanners(bannerRecords, groups.fallbackBanners, urlMap),
    popularCases: groups.popularCases.map((item) => buildCard(item, urlMap)),
    latestCases: groups.latestCases.map((item) => buildCard(item, urlMap)),
  };
}

function collectHomeImageFileIds(caseRecords = [], bannerRecords = []) {
  const groups = buildHomeCaseGroups(caseRecords);
  return Array.from(
    new Set(
      [
        ...groups.popularCases.map(getCardImageFileId),
        ...groups.latestCases.map(getCardImageFileId),
        ...bannerRecords.map((item) => normalizeBanner(item).image),
        ...groups.fallbackBanners.map((item) => item.image),
      ].filter(Boolean)
    )
  );
}

function buildCatalogSnapshot(records = [], urlMap = {}) {
  return sortCases(
    records.map(normalizeCaseRecord).filter((item) => item.isVisible)
  ).map((item) => buildCard(item, urlMap));
}

function getLibraryType(value) {
  return Object.prototype.hasOwnProperty.call(USER_LIBRARY_LIMITS, value) ? value : "";
}

function getLibraryCaseKey(record = {}) {
  return record.caseDocId || record.caseId || "";
}

function buildCaseLookup(records = [], urlMap = {}) {
  return records.reduce((map, record) => {
    const item = normalizeCaseRecord(record);
    if (!item.isVisible) return map;
    const card = buildCard(item, urlMap);
    if (item.id) map[item.id] = card;
    if (item.caseId) map[item.caseId] = card;
    return map;
  }, {});
}

function mergeUserLibrary(type, libraryRecords = [], caseRecords = [], urlMap = {}) {
  const caseMap = buildCaseLookup(caseRecords, urlMap);
  const staleIds = [];
  const items = [];

  libraryRecords.forEach((record) => {
    const caseItem = caseMap[record.caseDocId] || caseMap[record.caseId];
    const recordId = record._id || record.id || "";
    if (!caseItem) {
      if (recordId) staleIds.push(recordId);
      return;
    }
    items.push({
      recordId,
      viewedAt: record.lastViewedAt || record.createdAt || null,
      viewCount: Number(record.viewCount) || 0,
      caseItem,
    });
  });

  return { type, items, staleIds };
}

function buildDetail(record = {}, urlMap = {}) {
  const item = normalizeCaseRecord(record);
  const sourceImages = item.sourceGalleryImages.length
    ? item.sourceGalleryImages
    : item.galleryImages;
  const gallery = item.galleryImages.map((fileID, index) => {
    const thumbnailFileID =
      item.galleryThumbnails[index] || item.coverThumbnail || fileID;
    const sourceFileID = sourceImages[index] || fileID;
    return {
      fileID,
      thumbnailUrl: urlMap[thumbnailFileID] || urlMap[fileID] || "",
      displayUrl: urlMap[fileID] || "",
      downloadUrl: urlMap[sourceFileID] || urlMap[fileID] || "",
    };
  });
  return {
    ...item,
    gallery,
    coverImageUrl: gallery[0] ? gallery[0].displayUrl : "",
  };
}

function collectDetailImageFileIds(record = {}) {
  const item = normalizeCaseRecord(record);
  return Array.from(
    new Set(
      [
        ...item.galleryImages,
        ...item.galleryThumbnails,
        ...item.sourceGalleryImages,
        item.coverImage,
        item.coverThumbnail,
      ].filter(Boolean)
    )
  );
}

function chunkList(items = [], size = 10) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

module.exports = {
  HOME_SECTION_VALUES,
  USER_LIBRARY_LIMITS,
  buildCatalogSnapshot,
  buildCard,
  buildDetail,
  buildHomeFeed,
  chunkList,
  collectDetailImageFileIds,
  collectHomeImageFileIds,
  getCardImageFileId,
  getLibraryCaseKey,
  getLibraryType,
  mergeUserLibrary,
  normalizeCaseRecord,
  trimText,
};
