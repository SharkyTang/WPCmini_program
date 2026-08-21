const catalogCache = require("../../utils/catalogCache");
const {
  HOME_CACHE_KEY,
  readCache,
  writeCache,
} = catalogCache;
const {
  getCaseDataVersion,
  shouldRefreshCaseData,
} = require("../../utils/caseRefresh");
const {
  beginPageLoading,
  finishPageLoading,
  cancelPageLoading,
} = require("../../utils/nativePageLoading");
let reportClientFault = null;
let reportPerformanceEvent = null;
try {
  ({
    reportClientFault,
    reportPerformanceEvent,
  } = require("../../utils/errorTelemetry"));
} catch (error) {
  reportClientFault = null;
  reportPerformanceEvent = null;
}

const PENDING_CATEGORY_SORT_KEY = "pendingCategorySort";
const HOME_SHARE_TITLE = "金亿诚包装科技｜酒包装灵感库";
const TIMELINE_SINGLE_PAGE_SCENE = 1154;
const TIMELINE_PREVIEW_MESSAGE = "朋友圈预览暂时不能读取完整案例，请点击右下角“前往小程序”查看。";
const CLIENT_BOOT_TIMEOUT_MS = 5000;
const HOME_IMAGE_URL_TTL_MS = Number(catalogCache.CACHE_TTL_MS) > 0
  ? Number(catalogCache.CACHE_TTL_MS)
  : 20 * 60 * 1000;
const IMAGE_LOAD_STATE_PENDING = "pending";
const IMAGE_LOAD_STATE_EMPTY = "empty";
const IMAGE_LOAD_STATE_FAILED = "failed";
let catalogService = null;
let legacyHomeData = null;

function getCatalogService() {
  if (!catalogService) {
    catalogService = require("../../utils/caseCatalogService");
  }
  return catalogService;
}

function getLegacyHomeData() {
  if (legacyHomeData) return legacyHomeData;
  const cloudData = require("../../utils/cloudData");
  const { HOME_SECTION_VALUES } = require("../../utils/caseData");
  legacyHomeData = {
    ...cloudData,
    HOME_SECTION_VALUES,
  };
  return legacyHomeData;
}

function getDurationBucket(durationMs) {
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration < 0) return "unknown";
  if (duration < 500) return "under_500ms";
  if (duration < 1000) return "500_999ms";
  if (duration < 2000) return "1000_1999ms";
  if (duration < CLIENT_BOOT_TIMEOUT_MS) return "2000_4999ms";
  return "5000ms_plus";
}

function getMilestoneBucket(value) {
  if (value === "not_applicable") return value;
  if (value === null || value === undefined) return "pending";
  return getDurationBucket(value);
}

function getValidRevision(value) {
  const revision = Number(value);
  return Number.isFinite(revision) && revision > 0 ? revision : 0;
}

function getImageUrlsFetchedAt(feed) {
  const fetchedAt = Number(feed && feed.imageUrlsFetchedAt);
  return Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : 0;
}

function areHomeImageUrlsFresh(feed, now = Date.now()) {
  const fetchedAt = getImageUrlsFetchedAt(feed);
  const age = Number(now) - fetchedAt;
  return Boolean(
    fetchedAt
    && Number.isFinite(age)
    && age >= 0
    && age < HOME_IMAGE_URL_TTL_MS
  );
}

function hasUnresolvedHomeImageUrls(feed = {}) {
  const banners = Array.isArray(feed.banners) ? feed.banners : [];
  if (banners.some((banner) => banner && !banner.imageUrl)) return true;

  const cards = [
    ...(Array.isArray(feed.popularCases) ? feed.popularCases : []),
    ...(Array.isArray(feed.latestCases) ? feed.latestCases : []),
  ];
  return cards.some((card) => {
    if (!card) return false;
    const expectedImage = card.imageFileId
      || card.coverBanner
      || card.coverThumbnail
      || card.coverImage
      || "";
    const resolvedUrl = card.coverImageUrl || card.thumbnailUrl || "";
    return Boolean(expectedImage && !resolvedUrl);
  });
}

function createHomeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function reportHomeFault(stage, error, options = {}) {
  if (typeof reportClientFault !== "function") return false;
  try {
    return reportClientFault({
      type: "home_catalog_error",
      route: "pages/index/index",
      stage,
      error,
      code: options.code,
      action: options.action || "home_load",
      requestKind: options.requestKind || "catalog",
      cacheState: options.cacheState || "unknown",
      fallbackUsed: options.fallbackUsed === true,
      disposed: options.disposed === true,
    });
  } catch (telemetryError) {
    return false;
  }
}

function safeReportEvent(eventName, payload = {}, wxApi = wx) {
  if (typeof reportPerformanceEvent === "function") {
    try {
      return reportPerformanceEvent(eventName, payload);
    } catch (error) {
      // 兼容旧版 errorTelemetry，继续尝试微信原生上报。
    }
  }
  if (!wxApi || typeof wxApi.reportEvent !== "function") return false;
  const safePayload = Object.keys(payload).reduce((result, key) => {
    const value = payload[key];
    if (["string", "number", "boolean"].includes(typeof value)) {
      result[key] = value;
    }
    return result;
  }, {});
  try {
    wxApi.reportEvent(eventName, safePayload);
    return true;
  } catch (error) {
    console.warn("首页性能事件上报失败", { eventName, error });
    return false;
  }
}

function runAfterViewFlush(callback, wxApi = wx) {
  if (wxApi && typeof wxApi.nextTick === "function") {
    wxApi.nextTick(callback);
    return;
  }
  Promise.resolve().then(callback);
}

function summarizeTags(caseItem) {
  return [
    ...(caseItem.packageTypes || []),
    ...(caseItem.styles || []),
    caseItem.priceLevel,
  ]
    .filter(Boolean)
    .slice(0, 3)
    .join(" / ");
}

function buildProductCard(caseItem, homeBadge, mediaEpoch = 0) {
  const id = caseItem.id || caseItem._id || caseItem.caseId || "";
  const coverImageUrl = caseItem.coverImageUrl || caseItem.thumbnailUrl || "";
  return {
    id,
    caseId: caseItem.caseId || id,
    title: caseItem.title || "未命名案例",
    coverImageUrl,
    imageLoadState: coverImageUrl
      ? IMAGE_LOAD_STATE_PENDING
      : IMAGE_LOAD_STATE_EMPTY,
    mediaEpoch,
    tagSummary: summarizeTags(caseItem),
    homeBadge,
  };
}

function buildBannerCard(banner = {}, index = 0, mediaEpoch = 0) {
  const imageUrl = banner.imageUrl || "";
  const imageLoadState = banner.imageLoadState === IMAGE_LOAD_STATE_FAILED
    ? IMAGE_LOAD_STATE_FAILED
    : imageUrl
      ? IMAGE_LOAD_STATE_PENDING
      : IMAGE_LOAD_STATE_EMPTY;
  return {
    id: banner.id || banner.caseId || `home-banner-${index}`,
    caseId: banner.caseId || banner.id || "",
    title: banner.title || "",
    imageUrl,
    renderImageUrl: "",
    imageLoadState,
    mediaEpoch: Number.isInteger(banner.mediaEpoch)
      ? banner.mediaEpoch
      : mediaEpoch,
  };
}

function isBannerInRenderWindow(index, activeIndex, count) {
  if (!count) return false;
  if (count <= 3) return true;
  const previous = (activeIndex - 1 + count) % count;
  const next = (activeIndex + 1) % count;
  return index === activeIndex || index === previous || index === next;
}

function buildBannerCards(banners = [], activeIndex = 0, mediaEpoch = 0) {
  const cards = banners.map((banner, index) =>
    buildBannerCard(banner, index, mediaEpoch)
  );
  const safeActiveIndex = activeIndex >= 0 && activeIndex < cards.length
    ? activeIndex
    : 0;
  return cards.map((card, index) => ({
    ...card,
    renderImageUrl: card.imageLoadState !== IMAGE_LOAD_STATE_FAILED
      && isBannerInRenderWindow(index, safeActiveIndex, cards.length)
      ? card.imageUrl
      : "",
  }));
}

function decorateHomeFeed(feed = {}, activeBannerIndex = 0, mediaEpoch = 0) {
  return {
    banners: buildBannerCards(feed.banners || [], activeBannerIndex, mediaEpoch),
    popularCases: (feed.popularCases || []).map((item) =>
      buildProductCard(item, "近期热门", mediaEpoch)
    ),
    latestCases: (feed.latestCases || []).map((item) =>
      buildProductCard(item, "最近上新", mediaEpoch)
    ),
  };
}

function decorateStagedHomeFeed(feed = {}, mediaEpoch = 0) {
  return {
    banners: buildBannerCards((feed.banners || []).slice(0, 1), 0, mediaEpoch),
  };
}

function buildHomeSections(cases, homeSectionValues) {
  const visibleCases = cases.filter((caseItem) => caseItem.isVisible);
  const popularSource = visibleCases.filter((caseItem) =>
    (caseItem.homeSections || []).includes(homeSectionValues.POPULAR)
  );
  const latestSource = visibleCases
    .filter((caseItem) =>
      (caseItem.homeSections || []).includes(homeSectionValues.LATEST)
    )
    .sort((a, b) => b.sortOrder - a.sortOrder);

  return {
    popularCases: popularSource.slice(0, 4),
    latestCases: latestSource.slice(0, 6),
  };
}

function isTimelineSinglePage(wxApi = wx) {
  try {
    const launchOptions =
      wxApi && typeof wxApi.getLaunchOptionsSync === "function"
        ? wxApi.getLaunchOptionsSync()
        : null;
    const enterOptions =
      wxApi && typeof wxApi.getEnterOptionsSync === "function"
        ? wxApi.getEnterOptionsSync()
        : null;
    return [launchOptions, enterOptions].some(
      (options) => Number(options && options.scene) === TIMELINE_SINGLE_PAGE_SCENE
    );
  } catch (error) {
    return false;
  }
}

async function attachHomeSectionImages(
  sections,
  attachCaseImageUrls,
  options = {}
) {
  const cards = [...sections.popularCases, ...sections.latestCases];
  const cardsWithImages = await attachCaseImageUrls(cards, {
    preferBanner: true,
    forceRefresh: options.forceRefresh === true,
  });
  const imageById = cardsWithImages.reduce((map, card) => {
    map[card.id] = card.coverImageUrl;
    return map;
  }, {});

  return {
    popularCases: sections.popularCases.map((card) => ({
      ...card,
      coverImageUrl: imageById[card.id] || "",
    })),
    latestCases: sections.latestCases.map((card) => ({
      ...card,
      coverImageUrl: imageById[card.id] || "",
    })),
  };
}

Page({
  data: {
    loading: true,
    errorMessage: "",
    banners: [],
    popularCases: [],
    latestCases: [],
    timelinePreview: false,
    homeContentReady: false,
    caseDataVersion: 0,
    activeBannerIndex: 0,
  },

  onLoad() {
    this._alive = true;
    this._ready = false;
    this._requestToken = 0;
    this._loadPromise = null;
    this._cacheStageCommitted = false;
    this._cacheHydrationScheduled = false;
    this._fullCacheApplied = false;
    this._bootReported = false;
    this._bootStartedAt = Date.now();
    this._bootMilestones = {
      shell: null,
      onReady: null,
      hero: null,
      data: null,
    };
    this._bootResult = "success";
    this._bootRequestKind = "network";
    this._homeEntryContentCommitted = false;
    this._homeEntrySettledBannerIdentities = new Set();
    this._homeEntryLoadingToken = null;
    this._homeEntryLoadingPhase = "idle";
    this._homeEntryAwaitingFreshFeed = false;
    this._homeMediaEpoch = 0;
    this._homeMediaState = "idle";
    this._homeImageRecoveryPromise = null;
    this._homeImagesNeedRefresh = false;
    this._homePageVisible = true;
    this._homeVisibilityEpoch = 1;
    this._homeAutoRefreshEpoch = 0;
    this.beginHomeEntryLoading();
    this._bootTimer = setTimeout(() => {
      if (this.isAlive()) this.reportClientBoot("timeout", "network");
    }, CLIENT_BOOT_TIMEOUT_MS);
    this._timelinePreview = isTimelineSinglePage(wx);
    this._homeCache = readCache(HOME_CACHE_KEY);
    this._homeEntryAwaitingFreshFeed = Boolean(
      this._homeCache
      && !this._timelinePreview
      && !areHomeImageUrlsFresh(this._homeCache.data)
    );
    this._cacheState = this._homeCache
      ? this._homeCache.fresh
        ? "fresh"
        : "stale"
      : "miss";

    if (this._homeCache) {
      this._bootResult = this._timelinePreview ? "timeline_cache" : "cache";
      this._bootRequestKind = this._timelinePreview ? "timeline" : "cache";
      const staged = decorateStagedHomeFeed(
        this._homeCache.data,
        this._homeMediaEpoch
      );
      const stagedData = {
        ...staged,
        loading: false,
        errorMessage: "",
        homeContentReady: false,
        activeBannerIndex: 0,
        catalogRevision: getValidRevision(this._homeCache.revision),
      };
      if (this._timelinePreview) stagedData.timelinePreview = true;
      this.commitData(stagedData, () => {
        this.markBootMilestone("shell");
        this.markHomeEntryContentCommitted();
        this._cacheStageCommitted = true;
        this.scheduleCachedHydration();
      });
      return;
    }

    if (this._timelinePreview) {
      this._bootResult = "timeline_empty";
      this._bootRequestKind = "timeline";
      this.commitData({
        timelinePreview: true,
        loading: false,
        homeContentReady: false,
        errorMessage: TIMELINE_PREVIEW_MESSAGE,
      }, () => {
        this.markBootMilestone("shell");
        this.markBootMilestone("data");
        this.markBootMilestone("hero", "not_applicable");
        this.reportClientBoot(this._bootResult, this._bootRequestKind);
        this.finishHomeEntryLoading();
      });
      return;
    }

    this.commitData({
      loading: true,
      homeContentReady: false,
      errorMessage: "",
    }, () => {
      this.markBootMilestone("shell");
      runAfterViewFlush(() => {
        if (this.isAlive()) this.loadData({ silent: true });
      });
    });
  },

  onReady() {
    this._ready = true;
    this.markBootMilestone("onReady");
    this.scheduleCachedHydration();
  },

  onShow() {
    if (!this._homePageVisible) {
      this._homePageVisible = true;
      this._homeVisibilityEpoch = (this._homeVisibilityEpoch || 0) + 1;
      this._homeAutoRefreshEpoch = 0;
    }
    if (this._timelinePreview || !this._ready) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    if (this._homeImageRecoveryPromise) {
      this._homeAutoRefreshEpoch = this._homeVisibilityEpoch || 1;
      this.restartHomeEntryLoading();
      return this._homeImageRecoveryPromise;
    }
    if (
      !this._homeEntryLoadingToken
      && (this._loadPromise || this.data.loading)
    ) {
      this.beginHomeEntryLoading();
      if (this._homeEntryContentCommitted && !this._homeEntryAwaitingFreshFeed) {
        this.markHomeEntryContentCommitted();
      }
    }
    if (
      !this.data.loading
      && this._homeCache
      && (
        this._homeImagesNeedRefresh
        || !areHomeImageUrlsFresh(this._homeCache.data)
      )
    ) {
      return this.refreshHomeImages({ automatic: true, reason: "resume" });
    }
    if (!this.data.loading && shouldRefreshCaseData(this.data.caseDataVersion)) {
      return this.loadData({ silent: true, forceRefresh: true });
    }
    return this._loadPromise || Promise.resolve({ ok: true, skipped: true });
  },

  onHide() {
    this._homePageVisible = false;
    this.cancelHomeEntryLoading();
  },

  onUnload() {
    if (!this._bootReported) this.reportClientBoot("unloaded", "lifecycle");
    this._alive = false;
    this._homePageVisible = false;
    this.cancelHomeEntryLoading();
    this._requestToken = (this._requestToken || 0) + 1;
    this._loadPromise = null;
    this._homeImageRecoveryPromise = null;
    if (this._bootTimer) {
      clearTimeout(this._bootTimer);
      this._bootTimer = null;
    }
  },

  onPullDownRefresh() {
    if (this._timelinePreview) {
      this.stopPullDownRefreshSafely();
      return Promise.resolve({ ok: true, skipped: true });
    }
    return this.loadData({ forceRefresh: true }).then((result) => {
      this.stopPullDownRefreshSafely();
      return result;
    });
  },

  onShareAppMessage() {
    return {
      title: HOME_SHARE_TITLE,
      path: "/pages/index/index",
    };
  },

  onShareTimeline() {
    return {
      title: HOME_SHARE_TITLE,
    };
  },

  isAlive() {
    return this._alive !== false;
  },

  isRequestCurrent(requestToken) {
    return this.isAlive() && this._requestToken === requestToken;
  },

  stopPullDownRefreshSafely() {
    try {
      if (wx && typeof wx.stopPullDownRefresh === "function") {
        wx.stopPullDownRefresh();
      }
      return true;
    } catch (error) {
      console.warn("首页停止下拉刷新失败", error);
      return false;
    }
  },

  commitData(nextData, callback) {
    if (!this.isAlive()) return false;
    try {
      this.setData(nextData, () => {
        if (this.isAlive() && typeof callback === "function") callback();
      });
      return true;
    } catch (error) {
      console.error("首页状态更新失败", error);
      return false;
    }
  },

  finishHomeEntryLoading() {
    const token = this._homeEntryLoadingToken;
    if (!token) return false;
    const finished = finishPageLoading(token);
    if (finished) this._homeEntryLoadingPhase = "finishing";
    return finished;
  },

  beginHomeEntryLoading() {
    if (!this.isAlive() || this._homeEntryLoadingToken) {
      return this._homeEntryLoadingToken || null;
    }
    this._homeEntryLoadingToken = beginPageLoading({
      owner: "home-entry",
      title: "加载中",
      delayMs: 120,
      minVisibleMs: 300,
      maxVisibleMs: 3000,
      mask: false,
    });
    this._homeEntryLoadingPhase = "active";
    return this._homeEntryLoadingToken;
  },

  restartHomeEntryLoading() {
    const token = this._homeEntryLoadingToken;
    if (token) cancelPageLoading(token);
    this._homeEntryLoadingToken = null;
    this._homeEntryLoadingPhase = "idle";
    return this.beginHomeEntryLoading();
  },

  cancelHomeEntryLoading() {
    const token = this._homeEntryLoadingToken;
    if (!token) return false;
    this._homeEntryLoadingToken = null;
    this._homeEntryLoadingPhase = "idle";
    return cancelPageLoading(token);
  },

  markHomeEntryContentCommitted() {
    this._homeEntryContentCommitted = true;
    if (this._homeEntryAwaitingFreshFeed) return false;
    const activeIndex = Number(this.data.activeBannerIndex) || 0;
    const activeIdentity = this.getHomeEntryBannerIdentity(activeIndex);
    const settledBannerIdentities = this._homeEntrySettledBannerIdentities || new Set();
    if (
      !this.hasRenderableActiveBanner() ||
      (activeIdentity && settledBannerIdentities.has(activeIdentity))
    ) {
      this.finishHomeEntryLoading();
    }
  },

  getHomeEntryBannerIdentity(index, bannerId, imageUrl, mediaEpoch) {
    if (!Number.isInteger(index) || index < 0) return "";
    const currentBanner = Array.isArray(this.data.banners)
      ? this.data.banners[index]
      : null;
    const resolvedId = bannerId || currentBanner && currentBanner.id || "";
    const resolvedUrl = imageUrl || currentBanner && currentBanner.renderImageUrl || "";
    const resolvedEpoch = Number.isInteger(Number(mediaEpoch))
      ? Number(mediaEpoch)
      : Number(currentBanner && currentBanner.mediaEpoch);
    return resolvedId && resolvedUrl && Number.isInteger(resolvedEpoch)
      ? `${resolvedEpoch}\n${index}\n${resolvedId}\n${resolvedUrl}`
      : "";
  },

  isCurrentHomeEntryBanner(index, bannerId, imageUrl, mediaEpoch) {
    const eventIdentity = this.getHomeEntryBannerIdentity(
      index,
      bannerId,
      imageUrl,
      mediaEpoch
    );
    const currentIdentity = this.getHomeEntryBannerIdentity(index);
    return Boolean(eventIdentity && eventIdentity === currentIdentity);
  },

  settleHomeEntryBanner(index, bannerId, imageUrl, mediaEpoch) {
    if (!Number.isInteger(index) || index < 0) return false;
    const identity = this.getHomeEntryBannerIdentity(
      index,
      bannerId,
      imageUrl,
      mediaEpoch
    );
    if (!identity) return false;
    if (!this._homeEntrySettledBannerIdentities) {
      this._homeEntrySettledBannerIdentities = new Set();
    }
    this._homeEntrySettledBannerIdentities.add(identity);
    if (!this._homeEntryContentCommitted || this._homeEntryAwaitingFreshFeed) {
      return false;
    }
    const activeIndex = Number(this.data.activeBannerIndex) || 0;
    if (index !== activeIndex) return false;
    if (identity !== this.getHomeEntryBannerIdentity(activeIndex)) return false;
    return this.finishHomeEntryLoading();
  },

  markBootMilestone(name, value) {
    if (!this._bootMilestones || !Object.prototype.hasOwnProperty.call(
      this._bootMilestones,
      name
    )) {
      return null;
    }
    if (this._bootMilestones[name] !== null) {
      return this._bootMilestones[name];
    }
    this._bootMilestones[name] = value === "not_applicable"
      ? value
      : Math.max(0, Date.now() - (this._bootStartedAt || Date.now()));
    return this._bootMilestones[name];
  },

  reportClientBoot(result, source) {
    if (this._bootReported) return false;
    this._bootReported = true;
    if (this._bootTimer) {
      clearTimeout(this._bootTimer);
      this._bootTimer = null;
    }
    const durationMs = Date.now() - (this._bootStartedAt || Date.now());
    const milestones = this._bootMilestones || {};
    return safeReportEvent("client_boot_result", {
      route: "pages/index/index",
      stage: result,
      durationMs,
      duration_bucket: getDurationBucket(durationMs),
      shell_bucket: getMilestoneBucket(milestones.shell),
      on_ready_bucket: getMilestoneBucket(milestones.onReady),
      hero_bucket: getMilestoneBucket(milestones.hero),
      data_bucket: getMilestoneBucket(milestones.data),
      success: ["cache", "timeline_cache", "timeline_empty", "success"].includes(result),
      requestKind: source,
      cacheState: this._cacheState || "unknown",
      action: "home_boot",
      result,
      source,
      cache_state: this._cacheState || "unknown",
    });
  },

  hasRenderableActiveBanner() {
    const activeIndex = Number(this.data.activeBannerIndex) || 0;
    const activeBanner = this.data.banners[activeIndex];
    return Boolean(activeBanner && activeBanner.renderImageUrl);
  },

  reportBootAfterContentIfNoBanner() {
    if (this.hasRenderableActiveBanner()) return false;
    this.markBootMilestone("hero", "not_applicable");
    return this.reportClientBoot(
      this._bootResult || "success",
      this._bootRequestKind || "network"
    );
  },

  scheduleCachedHydration() {
    if (
      !this.isAlive() ||
      !this._ready ||
      !this._cacheStageCommitted ||
      !this._homeCache ||
      this._cacheHydrationScheduled
    ) {
      return false;
    }
    this._cacheHydrationScheduled = true;
    runAfterViewFlush(() => {
      if (!this.isAlive() || !this._homeCache) return;
      this.applyHomeFeed(this._homeCache.data, {
        revision: this._homeCache.revision,
        mediaEpoch: this._homeMediaEpoch,
      }, () => {
        this._fullCacheApplied = true;
        this.reportBootAfterContentIfNoBanner();
        if (!this._timelinePreview) {
          if (areHomeImageUrlsFresh(this._homeCache.data)) {
            this.loadData({ silent: true });
          } else {
            this.refreshHomeImages({
              automatic: true,
              reason: "stale_cache",
            });
          }
        }
      });
    });
    return true;
  },

  applyHomeFeed(feed, options = {}, callback) {
    const activeBannerIndex = Number(this.data.activeBannerIndex) || 0;
    const mediaEpoch = Number.isInteger(options.mediaEpoch)
      ? options.mediaEpoch
      : this._homeMediaEpoch || 0;
    const decorated = decorateHomeFeed(feed, activeBannerIndex, mediaEpoch);
    const safeActiveBannerIndex = activeBannerIndex < decorated.banners.length
      ? activeBannerIndex
      : 0;
    return this.commitData({
      ...decorated,
      caseDataVersion: getCaseDataVersion(),
      catalogRevision: getValidRevision(options.revision),
      loading: false,
      homeContentReady: true,
      activeBannerIndex: safeActiveBannerIndex,
      errorMessage: "",
    }, () => {
      if (options.imageUrlsRefreshed === true) {
        this._homeMediaEpoch = mediaEpoch;
        this._homeEntryAwaitingFreshFeed = false;
        this._homeImagesNeedRefresh = false;
        this._homeMediaState = this.hasRenderableActiveBanner()
          ? "waiting_image"
          : "ready";
      }
      this.markBootMilestone("data");
      this.markHomeEntryContentCommitted();
      if (typeof callback === "function") callback();
    });
  },

  scheduleCacheWrite(requestToken, revision, feed) {
    const numericRevision = Number(revision);
    if (!Number.isFinite(numericRevision) || numericRevision < 0) return false;
    setTimeout(() => {
      if (!this.isRequestCurrent(requestToken)) return;
      if (typeof catalogCache.writeCacheAsync === "function") {
        void catalogCache.writeCacheAsync(HOME_CACHE_KEY, numericRevision, feed);
        return;
      }
      writeCache(HOME_CACHE_KEY, numericRevision, feed);
    }, 0);
    return true;
  },

  touchHomeCache(requestToken, revision) {
    if (!this.isRequestCurrent(requestToken) || !this._homeCache) return;
    this._homeCache = {
      ...this._homeCache,
      revision: getValidRevision(revision) || this._homeCache.revision,
      cachedAt: Date.now(),
      fresh: true,
    };
    setTimeout(() => {
      if (!this.isRequestCurrent(requestToken) || !this._homeCache) return;
      if (typeof catalogCache.touchCacheAsync === "function") {
        void catalogCache.touchCacheAsync(
          HOME_CACHE_KEY,
          this._homeCache.revision
        );
        return;
      }
      if (typeof catalogCache.touchCache === "function") {
        try {
          catalogCache.touchCache(HOME_CACHE_KEY, this._homeCache.revision);
          return;
        } catch (error) {
          console.warn("首页缓存时间更新失败，使用兼容写入", error);
        }
      }
      writeCache(
        HOME_CACHE_KEY,
        this._homeCache.revision,
        this._homeCache.data
      );
    }, 0);
  },

  handleLoadFailure(requestToken, error) {
    try {
      if (!this.isRequestCurrent(requestToken)) {
        return { ok: false, cancelled: true, status: "stale" };
      }
      console.error("首页数据读取失败", error);
      const cachedStatus = this._homeCache && this._homeCache.fresh
        ? "cache"
        : "stale";
      reportHomeFault("load_final", error, {
        action: "home_load",
        cacheState: this._homeCache ? cachedStatus : "miss",
        fallbackUsed: Boolean(this._homeCache),
      });
      if (this._homeCache) {
        if (this._fullCacheApplied) {
          return { ok: false, cached: true, error, status: cachedStatus };
        }
        this.applyHomeFeed(this._homeCache.data, {
          revision: this._homeCache.revision,
        }, () => {
          this._fullCacheApplied = true;
        });
        return { ok: false, cached: true, error, status: cachedStatus };
      }
      this.commitData({
        loading: false,
        homeContentReady: false,
        errorMessage: "暂时读取不到案例数据，请检查云环境和数据库权限。",
      }, () => {
        this.markBootMilestone("data");
        this.markBootMilestone("hero", "not_applicable");
        this.reportClientBoot("error", "network");
        this.finishHomeEntryLoading();
      });
      return { ok: false, error, status: "error" };
    } catch (recoveryError) {
      console.error("首页失败恢复逻辑异常", recoveryError);
      return { ok: false, error: recoveryError, status: "error" };
    }
  },

  loadData(options = {}) {
    if (this._timelinePreview) {
      return Promise.resolve({ ok: true, skipped: true, status: "success" });
    }
    if (this._loadPromise && !options.forceRefresh) {
      return this._loadPromise;
    }
    if (typeof this._requestToken !== "number") this._requestToken = 0;
    const requestToken = this._requestToken + 1;
    this._requestToken = requestToken;

    if (!options.silent) {
      this.commitData({
        loading: true,
        errorMessage: "",
      });
    } else if (this.data.errorMessage) {
      this.commitData({
        errorMessage: "",
      });
    }

    const run = async () => {
      try {
        const {
          fetchHomeFeed,
          isLegacyCatalogFallbackAllowed,
        } = getCatalogService();
        const cachedRevision = getValidRevision(
          this._homeCache && this._homeCache.revision
        );
        const imageUrlsAreFresh = areHomeImageUrlsFresh(
          this._homeCache && this._homeCache.data
        );
        const knownRevision = !options.forceRefresh
          && imageUrlsAreFresh
          && cachedRevision
          ? cachedRevision
          : undefined;
        const knownFeedMode = knownRevision
          && this._homeCache
          && typeof this._homeCache.data.feedModeUsed === "string"
          ? this._homeCache.data.feedModeUsed
          : undefined;
        let result;
        try {
          const requestOptions = {};
          if (knownRevision) requestOptions.knownRevision = knownRevision;
          if (knownFeedMode) requestOptions.knownFeedMode = knownFeedMode;
          result = await fetchHomeFeed(requestOptions);
        } catch (catalogError) {
          if (!this.isRequestCurrent(requestToken)) {
            return { ok: false, cancelled: true, status: "stale" };
          }
          if (!isLegacyCatalogFallbackAllowed(catalogError)) {
            throw catalogError;
          }
          console.warn("首页聚合接口不可用，使用兼容读取", catalogError);
          reportHomeFault("catalog_fallback", catalogError, {
            action: "getHomeFeed",
            requestKind: "fallback",
            cacheState: this._cacheState || "unknown",
            fallbackUsed: true,
          });
          const fallback = getLegacyHomeData();
          const cases = await fallback.fetchVisibleCases({
            includeImageUrls: false,
            forceRefresh: options.forceRefresh,
          });
          if (!this.isRequestCurrent(requestToken)) {
            return { ok: false, cancelled: true, status: "stale" };
          }
          const [banners, sections] = await Promise.all([
            fallback.fetchVisibleBanners(cases, {
              forceRefresh: options.forceRefresh,
            }),
            attachHomeSectionImages(
              buildHomeSections(cases, fallback.HOME_SECTION_VALUES),
              fallback.attachCaseImageUrls,
              { forceRefresh: options.forceRefresh === true }
            ),
          ]);
          result = {
            revision: getValidRevision(getCaseDataVersion()),
            notModified: false,
            feedModeUsed: "legacy",
            banners,
            ...sections,
          };
        }
        if (!this.isRequestCurrent(requestToken)) {
          return { ok: false, cancelled: true, status: "stale" };
        }
        if (result.notModified) {
          if (!this._homeCache) {
            throw createHomeError(
              "CATALOG_NOT_MODIFIED_WITHOUT_CACHE",
              "首页目录未返回内容，且本地没有可用缓存"
            );
          }
          if (options.forceRefresh || !imageUrlsAreFresh) {
            throw createHomeError(
              "CATALOG_NOT_MODIFIED_DURING_IMAGE_REFRESH",
              "首页图片链接刷新未返回完整内容"
            );
          }
          this.touchHomeCache(requestToken, result.revision);
          return { ok: true, notModified: true, status: "cache" };
        }
        const feed = {
          feedModeUsed: result.feedModeUsed || "legacy",
          banners: result.banners || [],
          popularCases: result.popularCases || [],
          latestCases: result.latestCases || [],
        };
        if (hasUnresolvedHomeImageUrls(feed)) {
          throw createHomeError(
            "HOME_IMAGE_URLS_INCOMPLETE",
            "首页图片链接未完整获取"
          );
        }
        feed.imageUrlsFetchedAt = Date.now();
        const validRevision = getValidRevision(result.revision);
        const nextMediaEpoch = (this._homeMediaEpoch || 0) + 1;
        this._homeCache = {
          revision: validRevision,
          cachedAt: Date.now(),
          fresh: true,
          data: feed,
        };
        const committed = this.applyHomeFeed(feed, {
          revision: result.revision,
          mediaEpoch: nextMediaEpoch,
          imageUrlsRefreshed: true,
        }, () => {
          this._fullCacheApplied = true;
          this.scheduleCacheWrite(requestToken, validRevision, feed);
          this.reportBootAfterContentIfNoBanner();
        });
        return committed
          ? { ok: true, notModified: false, status: "success" }
          : { ok: false, cancelled: true, status: "stale" };
      } catch (error) {
        return this.handleLoadFailure(requestToken, error);
      }
    };

    const safePromise = Promise.resolve()
      .then(run)
      .catch((error) => this.handleLoadFailure(requestToken, error));
    const trackedPromise = safePromise.then(
      (result) => {
        if (this._loadPromise === trackedPromise) this._loadPromise = null;
        return result;
      },
      (error) => {
        if (this._loadPromise === trackedPromise) this._loadPromise = null;
        return this.handleLoadFailure(requestToken, error);
      }
    );
    this._loadPromise = trackedPromise;
    return trackedPromise;
  },

  refreshHomeImages(options = {}) {
    const automatic = options.automatic === true;
    if (
      !this.isAlive()
      || this._timelinePreview
      || (automatic && !this._homePageVisible)
    ) {
      return Promise.resolve({ ok: false, skipped: true, status: "stale" });
    }
    if (this._homeImageRecoveryPromise) {
      return this._homeImageRecoveryPromise;
    }
    const visibilityEpoch = this._homeVisibilityEpoch || 1;
    if (automatic && this._homeAutoRefreshEpoch === visibilityEpoch) {
      return Promise.resolve({ ok: false, skipped: true, status: "budget_used" });
    }
    if (automatic) this._homeAutoRefreshEpoch = visibilityEpoch;

    this._homeEntryAwaitingFreshFeed = true;
    this._homeEntryContentCommitted = false;
    this._homeEntrySettledBannerIdentities = new Set();
    this._homeMediaState = "refreshing";
    this.restartHomeEntryLoading();

    const startingMediaEpoch = this._homeMediaEpoch || 0;
    const requestPromise = this.loadData({
      silent: true,
      forceRefresh: true,
    });
    let trackedPromise;
    trackedPromise = Promise.resolve(requestPromise)
      .then((result) => {
        if (
          result
          && result.cancelled
          && this._loadPromise
          && this._loadPromise !== requestPromise
        ) {
          return this._loadPromise;
        }
        return result;
      })
      .then((result) => {
        const refreshedByThisRequest = Boolean(
          result
          && result.ok
          && result.notModified === false
        );
        const refreshedByNewerRequest = Boolean(
          !this._homeEntryAwaitingFreshFeed
          && (this._homeMediaEpoch || 0) > startingMediaEpoch
          && areHomeImageUrlsFresh(this._homeCache && this._homeCache.data)
        );
        const refreshed = refreshedByThisRequest || refreshedByNewerRequest;
        if (!refreshed && this.isAlive()) {
          this._homeEntryAwaitingFreshFeed = false;
          this._homeEntryContentCommitted = Boolean(this.data.homeContentReady);
          this._homeMediaState = "failed";
          this.finishHomeEntryLoading();
          if (!this._bootReported) {
            this.markBootMilestone("hero", "not_applicable");
            this.reportClientBoot("error", "network");
          }
        }
        return result;
      })
      .finally(() => {
        if (this._homeImageRecoveryPromise === trackedPromise) {
          this._homeImageRecoveryPromise = null;
        }
      });
    this._homeImageRecoveryPromise = trackedPromise;
    return trackedPromise;
  },

  retryHomeImages() {
    return this.refreshHomeImages({
      automatic: false,
      reason: "manual_retry",
    });
  },

  retryHomeData() {
    if (!this.isAlive() || this._timelinePreview || this.data.loading) {
      return Promise.resolve({ ok: false, skipped: true, status: "stale" });
    }
    return this.loadData({ forceRefresh: true });
  },

  navigateToCase(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/detail/index?id=${encodeURIComponent(id)}`,
    });
  },

  navigateToCategory(event) {
    const sort = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.sort
      : "";
    const app = typeof getApp === "function" ? getApp() : null;
    if (sort) {
      if (app && app.globalData) {
        app.globalData[PENDING_CATEGORY_SORT_KEY] = sort;
      }
      try {
        wx.setStorageSync(PENDING_CATEGORY_SORT_KEY, sort);
      } catch (error) {
        console.warn("首页分类排序暂存失败", error);
      }
    }
    wx.switchTab({
      url: "/pages/category/index",
    });
  },

  onBannerTap(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/detail/index?id=${encodeURIComponent(id)}`,
    });
  },

  onBannerImageLoad(event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset || {};
    const bannerIndex = Number(dataset.index);
    if (!Number.isInteger(bannerIndex) || bannerIndex < 0) return false;
    const bannerId = dataset.bannerId || "";
    const imageUrl = dataset.url || "";
    const mediaEpoch = dataset.mediaEpoch === undefined
      ? undefined
      : Number(dataset.mediaEpoch);
    const isCurrentBanner = this.isCurrentHomeEntryBanner(
      bannerIndex,
      bannerId,
      imageUrl,
      mediaEpoch
    );
    if (!isCurrentBanner) return false;
    if (this._homeEntryAwaitingFreshFeed) return false;
    const settled = this.settleHomeEntryBanner(
      bannerIndex,
      bannerId,
      imageUrl,
      mediaEpoch
    );
    if (bannerIndex !== this.data.activeBannerIndex) {
      return settled;
    }
    this._homeMediaState = "ready";
    this.markBootMilestone("hero");
    const reported = this.reportClientBoot(
      this._bootResult || "success",
      this._bootRequestKind || "network"
    );
    return reported;
  },

  onBannerImageError(event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset || {};
    const bannerIndex = Number(dataset.index);
    const bannerId = dataset.bannerId || "";
    const imageUrl = dataset.url || "";
    const mediaEpoch = dataset.mediaEpoch === undefined
      ? undefined
      : Number(dataset.mediaEpoch);
    if (!this.isCurrentHomeEntryBanner(
      bannerIndex,
      bannerId,
      imageUrl,
      mediaEpoch
    )) {
      return false;
    }
    const banners = this.data.banners.map((banner, index) =>
      index === bannerIndex
        ? {
            ...banner,
            renderImageUrl: "",
            imageLoadState: IMAGE_LOAD_STATE_FAILED,
          }
        : banner
    );
    this.commitData({ banners });
    if (!this._timelinePreview) this._homeImagesNeedRefresh = true;
    if (this._timelinePreview || !this._homePageVisible) {
      if (bannerIndex === this.data.activeBannerIndex) {
        this.finishHomeEntryLoading();
      }
      return true;
    }
    const recovery = this.refreshHomeImages({
      automatic: true,
      reason: "banner_error",
    });
    if (this._homeAutoRefreshEpoch === (this._homeVisibilityEpoch || 1)) {
      const recoveryInFlight = Boolean(this._homeImageRecoveryPromise);
      if (!recoveryInFlight && bannerIndex === this.data.activeBannerIndex) {
        this._homeMediaState = "failed";
        this.finishHomeEntryLoading();
      }
    }
    return recovery;
  },

  onProductImageError(event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset || {};
    const section = dataset.section;
    const index = Number(dataset.index);
    const caseId = dataset.caseId || "";
    const imageUrl = dataset.url || "";
    const mediaEpoch = Number(dataset.mediaEpoch);
    if (
      !["popularCases", "latestCases"].includes(section)
      || !Number.isInteger(index)
      || index < 0
    ) {
      return false;
    }
    const cards = Array.isArray(this.data[section]) ? this.data[section] : [];
    const currentCard = cards[index];
    if (
      !currentCard
      || currentCard.id !== caseId
      || currentCard.coverImageUrl !== imageUrl
      || Number(currentCard.mediaEpoch) !== mediaEpoch
    ) {
      return false;
    }
    const nextCards = cards.map((card, cardIndex) =>
      cardIndex === index
        ? {
            ...card,
            coverImageUrl: "",
            imageLoadState: IMAGE_LOAD_STATE_FAILED,
          }
        : card
    );
    this.commitData({ [section]: nextCards });
    if (!this._timelinePreview) this._homeImagesNeedRefresh = true;
    if (this._timelinePreview || !this._homePageVisible) return true;
    return this.refreshHomeImages({
      automatic: true,
      reason: "product_error",
    });
  },

  onBannerChange(event) {
    const current = Number(event && event.detail && event.detail.current);
    if (
      !Number.isInteger(current) ||
      current < 0 ||
      current >= this.data.banners.length
    ) {
      return;
    }
    const banners = buildBannerCards(
      this.data.banners,
      current,
      this._homeMediaEpoch || 0
    );
    this.commitData({
      activeBannerIndex: current,
      banners,
    }, () => {
      const settled = this._homeEntrySettledBannerIdentities || new Set();
      const identity = this.getHomeEntryBannerIdentity(current);
      if (
        !this._homeEntryAwaitingFreshFeed
        && identity
        && settled.has(identity)
      ) {
        this.finishHomeEntryLoading();
      }
    });
  },
});
