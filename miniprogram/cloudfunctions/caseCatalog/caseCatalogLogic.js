const HOME_SECTION_VALUES = {
  BANNER: "banner",
  POPULAR: "popular",
  LATEST: "latest",
};

const USER_LIBRARY_LIMITS = {
  favorites: 100,
  history: 50,
};
const DETAIL_INITIAL_THUMBNAIL_LIMIT = 9;
const HTTPS_MEDIA_URL_MAX_LENGTH = 2048;
const VIDEO_DURATION_SECONDS_MAX = 120;

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHttpsMediaUrl(value) {
  const url = trimText(value);
  if (!url || url.length > HTTPS_MEDIA_URL_MAX_LENGTH || /\s/.test(url)) return "";
  const match = /^https:\/\/(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?(?:[/?#].*)?$/i.exec(url);
  if (!match) return "";
  const port = match[2] ? Number(match[2]) : 443;
  return port > 0 && port <= 65535 ? url : "";
}

function normalizeVideoDurationSeconds(value) {
  if (value === "" || value === null || value === undefined) return null;
  const duration = Number(value);
  return Number.isSafeInteger(duration)
    && duration > 0
    && duration <= VIDEO_DURATION_SECONDS_MAX
    ? duration
    : null;
}

function normalizeVideoFileSizeBytes(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

function normalizeCloudFileId(value) {
  const fileID = trimText(value);
  return fileID.indexOf("cloud://") === 0 ? fileID : "";
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
    });
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
  const galleryBanners = normalizeGallery(record.galleryBanners);
  const homeSections = normalizeValues(record.homeSections);
  const statuses = normalizeValues(record.statuses);
  const packageTypes = normalizeValues(record.packageTypes);
  const styles = normalizeValues(record.styles);
  const scenes = normalizeValues(record.scenes);
  const id = record._id || record.id || "";
  const videoFileID = normalizeCloudFileId(record.videoFileID);
  const videoUrl = normalizeHttpsMediaUrl(record.videoUrl);
  const hasVideo = Boolean(videoFileID || videoUrl);

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
    galleryBanners,
    coverImage: firstImage(record.coverImage) || galleryImages[0] || legacyCover,
    coverThumbnail:
      firstImage(record.coverThumbnail) || galleryThumbnails[0] || galleryImages[0] || legacyCover,
    coverBanner:
      firstImage(record.coverBanner) || galleryBanners[0] || galleryImages[0] || legacyCover,
    imageVariantVersion: Number(record.imageVariantVersion) || 0,
    videoFileID,
    videoUrl,
    videoPosterFileID: hasVideo ? normalizeCloudFileId(record.videoPosterFileID) : "",
    videoPoster: hasVideo ? normalizeHttpsMediaUrl(record.videoPoster) : "",
    videoDurationSeconds: hasVideo
      ? normalizeVideoDurationSeconds(record.videoDurationSeconds)
      : null,
    videoFileSizeBytes: videoFileID
      ? normalizeVideoFileSizeBytes(record.videoFileSizeBytes)
      : null,
  };
}

function getCardImageFileId(item = {}, options = {}) {
  if (options.preferBanner === true) {
    // Category cards need the full composition. The optimized banner keeps the
    // source aspect ratio, unlike the square thumbnail used elsewhere.
    return item.coverBanner || item.coverThumbnail || item.coverImage || "";
  }
  return item.coverThumbnail || item.coverImage || "";
}

function buildCard(record = {}, urlMap = {}, options = {}) {
  const item = normalizeCaseRecord(record);
  const imageFileId = getCardImageFileId(item, options);
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
  // Indexed queries intentionally overlap when one case belongs to multiple
  // home sections. Deduplicate before slicing so one case cannot consume
  // several result or URL-signing slots.
  const cases = uniqueCaseRecords(records)
    .map(normalizeCaseRecord)
    .filter((item) => item.isVisible);
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
        item.homeSections.includes(HOME_SECTION_VALUES.BANNER) &&
        Boolean(item.coverBanner || item.coverImage)
    )
  )
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      caseId: item.caseId || item.id,
      title: item.title,
      image: item.coverBanner || item.coverImage,
      sortOrder: item.sortOrder,
    }));
  return { popularCases, latestCases, fallbackBanners };
}

function normalizeBanner(record = {}) {
  const optimizedImage = firstImage(record.optimizedImage);
  return {
    id: record._id || record.id || record.caseId || trimText(record.title),
    caseId: record.caseId || "",
    title: trimText(record.title),
    image: optimizedImage || firstImage(record.image || record.coverImage),
    optimizedImage,
    imageVariantVersion: Number(record.imageVariantVersion) || 0,
    sortOrder: toNumber(record.sortOrder),
    isVisible: record.isVisible !== false,
  };
}

function selectHomeBanners(records = [], fallbackBanners = []) {
  const seen = new Set();
  return [...records.map(normalizeBanner), ...fallbackBanners]
    .filter((item) => item.isVisible !== false && item.image)
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
      }
      return String(left.caseId || left.id || left.image).localeCompare(
        String(right.caseId || right.id || right.image)
      );
    })
    .filter((item) => {
      const key = item.caseId || item.image || item.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function buildBanners(records = [], fallbackBanners = [], urlMap = {}) {
  return selectHomeBanners(records, fallbackBanners)
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
    popularCases: groups.popularCases.map((item) =>
      buildCard(item, urlMap, { preferBanner: true })
    ),
    latestCases: groups.latestCases.map((item) =>
      buildCard(item, urlMap, { preferBanner: true })
    ),
  };
}

function collectHomeImageFileIds(caseRecords = [], bannerRecords = []) {
  const groups = buildHomeCaseGroups(caseRecords);
  const selectedBanners = selectHomeBanners(
    bannerRecords,
    groups.fallbackBanners
  );
  return Array.from(
    new Set(
      [
        ...groups.popularCases.map((item) =>
          getCardImageFileId(item, { preferBanner: true })
        ),
        ...groups.latestCases.map((item) =>
          getCardImageFileId(item, { preferBanner: true })
        ),
        ...selectedBanners.map((item) => item.image),
      ].filter(Boolean)
    )
  );
}

function buildCatalogSnapshot(records = [], urlMap = {}) {
  return sortCases(
    records.map(normalizeCaseRecord).filter((item) => item.isVisible)
  ).map((item) => buildCard(item, urlMap, { preferBanner: true }));
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
  const {
    sourceGalleryImages: _sourceGalleryImages,
    videoFileID: _videoFileID,
    videoPosterFileID: _videoPosterFileID,
    videoFileSizeBytes: _videoFileSizeBytes,
    ...publicItem
  } = item;
  const gallery = item.galleryImages.map((fileID, index) => {
    const thumbnailFileID =
      item.galleryThumbnails[index] || item.coverThumbnail || fileID;
    return {
      fileID,
      thumbnailUrl: urlMap[thumbnailFileID] || urlMap[fileID] || "",
      displayUrl: urlMap[fileID] || "",
      downloadUrl: urlMap[fileID] || "",
    };
  });
  return {
    ...publicItem,
    ...resolveDetailVideo(item, urlMap),
    gallery,
    coverImageUrl: gallery[0] ? gallery[0].displayUrl : "",
  };
}

function resolveDetailVideo(item = {}, urlMap = {}) {
  const videoUrl = item.videoFileID
    ? resolvePublicUrl(item.videoFileID, urlMap)
    : item.videoUrl;
  if (!videoUrl) {
    return {
      videoUrl: "",
      videoPoster: "",
      videoDurationSeconds: null,
    };
  }
  return {
    videoUrl,
    videoPoster: item.videoPosterFileID
      ? resolvePublicUrl(item.videoPosterFileID, urlMap)
      : item.videoPoster,
    videoDurationSeconds: item.videoDurationSeconds,
  };
}

function resolvePublicUrl(fileID, urlMap = {}) {
  if (!fileID) return "";
  if (urlMap[fileID]) return urlMap[fileID];
  return String(fileID).indexOf("cloud://") === 0 ? "" : String(fileID);
}

function getUnsafeDetailSourceIds(record, item) {
  const explicitSources = normalizeGallery(record.sourceGalleryImages);
  if (explicitSources.length) return new Set(explicitSources);
  const hasReliableVariants = (
    item.imageVariantVersion >= 2
    || normalizeGallery(record.galleryThumbnails).length > 0
    || normalizeGallery(record.galleryBanners).length > 0
  );
  return hasReliableVariants ? new Set() : new Set(item.galleryImages);
}

function getSafeDetailFileId(fileID, unsafeSourceIds) {
  return fileID && !unsafeSourceIds.has(fileID) ? fileID : "";
}

function getDetailThumbnailFileId(item, index, unsafeSourceIds = new Set()) {
  return getSafeDetailFileId(
    item.galleryThumbnails[index]
      || item.coverThumbnail
      || item.galleryImages[index]
      || "",
    unsafeSourceIds
  );
}

function getDetailHeroFileId(item, unsafeSourceIds = new Set()) {
  return getSafeDetailFileId(
    item.galleryBanners[0]
    || item.coverBanner
    || getDetailThumbnailFileId(item, 0, unsafeSourceIds)
    || item.galleryImages[0]
    || "",
    unsafeSourceIds
  );
}

function buildInitialDetail(record = {}, urlMap = {}) {
  const item = normalizeCaseRecord(record);
  const {
    sourceGalleryImages: _sourceGalleryImages,
    galleryImages: _galleryImages,
    galleryThumbnails: _galleryThumbnails,
    galleryBanners: _galleryBanners,
    coverImage: _coverImage,
    coverThumbnail: _coverThumbnail,
    coverBanner: _coverBanner,
    videoFileID: _videoFileID,
    videoPosterFileID: _videoPosterFileID,
    videoFileSizeBytes: _videoFileSizeBytes,
    ...publicItem
  } = item;
  const unsafeSourceIds = getUnsafeDetailSourceIds(record, item);
  const heroFileID = getDetailHeroFileId(item, unsafeSourceIds);
  const gallery = item.galleryImages.map((fileID, index) => {
    const safeDisplayFileID = getSafeDetailFileId(fileID, unsafeSourceIds);
    const thumbnailFileID = getDetailThumbnailFileId(
      item,
      index,
      unsafeSourceIds
    );
    const heroUrl = index === 0 ? resolvePublicUrl(heroFileID, urlMap) : "";
    return {
      index,
      fileID: safeDisplayFileID,
      thumbnailUrl: index < DETAIL_INITIAL_THUMBNAIL_LIMIT
        ? resolvePublicUrl(thumbnailFileID, urlMap) || heroUrl
        : "",
      heroUrl,
      displayUrl: "",
      downloadUrl: "",
      hydrated: false,
    };
  });
  return {
    ...publicItem,
    ...resolveDetailVideo(item, urlMap),
    gallery,
    coverImageUrl: gallery[0] ? gallery[0].heroUrl : "",
  };
}

function collectDetailVideoFileIds(record = {}) {
  const item = normalizeCaseRecord(record);
  if (!item.videoFileID) return [];
  return [item.videoFileID, item.videoPosterFileID].filter(Boolean);
}

function collectInitialDetailImageFileIds(record = {}) {
  const item = normalizeCaseRecord(record);
  const unsafeSourceIds = getUnsafeDetailSourceIds(record, item);
  return Array.from(
    new Set(
      [
        getDetailHeroFileId(item, unsafeSourceIds),
        ...item.galleryImages
          .slice(0, DETAIL_INITIAL_THUMBNAIL_LIMIT)
          .map((_, index) => getDetailThumbnailFileId(
            item,
            index,
            unsafeSourceIds
          )),
      ].filter(Boolean)
    )
  );
}

function collectDetailPatchFileIds(record = {}, indexes = []) {
  const item = normalizeCaseRecord(record);
  const unsafeSourceIds = getUnsafeDetailSourceIds(record, item);
  return indexes
    .map((index) => getSafeDetailFileId(
      item.galleryImages[index],
      unsafeSourceIds
    ))
    .filter(Boolean);
}

function buildDetailPatch(record = {}, indexes = [], urlMap = {}) {
  const item = normalizeCaseRecord(record);
  const unsafeSourceIds = getUnsafeDetailSourceIds(record, item);
  return indexes.map((index) => {
    const fileID = getSafeDetailFileId(
      item.galleryImages[index],
      unsafeSourceIds
    );
    const displayUrl = resolvePublicUrl(fileID, urlMap);
    return {
      index,
      fileID,
      displayUrl,
      downloadUrl: displayUrl,
    };
  });
}

function uniqueCaseRecords(records = []) {
  const seen = new Set();
  return records.filter((record) => {
    const key = record && (record._id || record.id || record.caseId);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildIndexedHomeFeed(groups = {}, bannerRecords = [], urlMap = {}) {
  const caseRecords = uniqueCaseRecords([
    ...(groups.popularRecords || []),
    ...(groups.latestRecords || []),
    ...(groups.fallbackBannerRecords || []),
  ]);
  return buildHomeFeed(caseRecords, bannerRecords, urlMap);
}

function collectDetailImageFileIds(record = {}) {
  const item = normalizeCaseRecord(record);
  return Array.from(
    new Set(
      [
        ...item.galleryImages,
        ...item.galleryThumbnails,
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
  buildDetailPatch,
  buildHomeFeed,
  buildIndexedHomeFeed,
  buildInitialDetail,
  chunkList,
  collectDetailImageFileIds,
  collectDetailPatchFileIds,
  collectDetailVideoFileIds,
  collectHomeImageFileIds,
  collectInitialDetailImageFileIds,
  getCardImageFileId,
  getLibraryCaseKey,
  getLibraryType,
  mergeUserLibrary,
  normalizeCaseRecord,
  normalizeHttpsMediaUrl,
  normalizeVideoDurationSeconds,
  normalizeVideoFileSizeBytes,
  trimText,
};
