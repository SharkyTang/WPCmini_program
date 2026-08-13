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

function buildProductCard(caseItem, homeBadge) {
  const id = caseItem.id || caseItem._id || caseItem.caseId || "";
  return {
    id,
    caseId: caseItem.caseId || id,
    title: caseItem.title || "未命名案例",
    coverImageUrl: caseItem.coverImageUrl || caseItem.thumbnailUrl || "",
    tagSummary: summarizeTags(caseItem),
    homeBadge,
  };
}

function buildBannerCard(banner = {}, index = 0) {
  return {
    id: banner.id || banner.caseId || `home-banner-${index}`,
    caseId: banner.caseId || banner.id || "",
    title: banner.title || "",
    imageUrl: banner.imageUrl || "",
    renderImageUrl: "",
  };
}

function isBannerInRenderWindow(index, activeIndex, count) {
  if (!count) return false;
  if (count <= 3) return true;
  const previous = (activeIndex - 1 + count) % count;
  const next = (activeIndex + 1) % count;
  return index === activeIndex || index === previous || index === next;
}

function buildBannerCards(banners = [], activeIndex = 0) {
  const cards = banners.map(buildBannerCard);
  const safeActiveIndex = activeIndex >= 0 && activeIndex < cards.length
    ? activeIndex
    : 0;
  return cards.map((card, index) => ({
    ...card,
    renderImageUrl: isBannerInRenderWindow(index, safeActiveIndex, cards.length)
      ? card.imageUrl
      : "",
  }));
}

function decorateHomeFeed(feed = {}, activeBannerIndex = 0) {
  return {
    banners: buildBannerCards(feed.banners || [], activeBannerIndex),
    popularCases: (feed.popularCases || []).map((item) =>
      buildProductCard(item, "近期热门")
    ),
    latestCases: (feed.latestCases || []).map((item) =>
      buildProductCard(item, "最近上新")
    ),
  };
}

function decorateStagedHomeFeed(feed = {}) {
  return {
    banners: buildBannerCards((feed.banners || []).slice(0, 1), 0),
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

async function attachHomeSectionImages(sections, attachCaseImageUrls) {
  const cards = [...sections.popularCases, ...sections.latestCases];
  const cardsWithImages = await attachCaseImageUrls(cards, { preferBanner: true });
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
    this._bootTimer = setTimeout(() => {
      if (this.isAlive()) this.reportClientBoot("timeout", "network");
    }, CLIENT_BOOT_TIMEOUT_MS);
    this._timelinePreview = isTimelineSinglePage(wx);
    this._homeCache = readCache(HOME_CACHE_KEY);
    this._cacheState = this._homeCache
      ? this._homeCache.fresh
        ? "fresh"
        : "stale"
      : "miss";

    if (this._homeCache) {
      this._bootResult = this._timelinePreview ? "timeline_cache" : "cache";
      this._bootRequestKind = this._timelinePreview ? "timeline" : "cache";
      const staged = decorateStagedHomeFeed(this._homeCache.data);
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
    if (this._timelinePreview || !this._ready) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    if (!this.data.loading && shouldRefreshCaseData(this.data.caseDataVersion)) {
      return this.loadData({ silent: true, forceRefresh: true });
    }
    return this._loadPromise || Promise.resolve({ ok: true, skipped: true });
  },

  onUnload() {
    if (!this._bootReported) this.reportClientBoot("unloaded", "lifecycle");
    this._alive = false;
    this._requestToken = (this._requestToken || 0) + 1;
    this._loadPromise = null;
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
      }, () => {
        this._fullCacheApplied = true;
        this.reportBootAfterContentIfNoBanner();
        if (!this._timelinePreview) {
          this.loadData({ silent: true });
        }
      });
    });
    return true;
  },

  applyHomeFeed(feed, options = {}, callback) {
    const activeBannerIndex = Number(this.data.activeBannerIndex) || 0;
    const decorated = decorateHomeFeed(feed, activeBannerIndex);
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
      this.markBootMilestone("data");
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
        const knownRevision = !options.forceRefresh && cachedRevision
          ? cachedRevision
          : undefined;
        const knownFeedMode = !options.forceRefresh
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
              fallback.attachCaseImageUrls
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
          this.touchHomeCache(requestToken, result.revision);
          return { ok: true, notModified: true, status: "cache" };
        }
        const feed = {
          feedModeUsed: result.feedModeUsed || "legacy",
          banners: result.banners || [],
          popularCases: result.popularCases || [],
          latestCases: result.latestCases || [],
        };
        const validRevision = getValidRevision(result.revision);
        this._homeCache = {
          revision: validRevision,
          cachedAt: Date.now(),
          fresh: true,
          data: feed,
        };
        const committed = this.applyHomeFeed(feed, {
          revision: result.revision,
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
    const sort = event.currentTarget.dataset.sort;
    const app = typeof getApp === "function" ? getApp() : null;
    if (app && app.globalData) {
      app.globalData[PENDING_CATEGORY_SORT_KEY] = sort || "";
    }
    try {
      wx.setStorageSync(PENDING_CATEGORY_SORT_KEY, sort || "");
    } catch (error) {
      console.warn("首页分类排序暂存失败", error);
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
    const bannerIndex = Number(
      event && event.currentTarget && event.currentTarget.dataset.index
    );
    if (!Number.isInteger(bannerIndex) || bannerIndex !== this.data.activeBannerIndex) {
      return false;
    }
    this.markBootMilestone("hero");
    return this.reportClientBoot(
      this._bootResult || "success",
      this._bootRequestKind || "network"
    );
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
    const banners = buildBannerCards(this.data.banners, current);
    this.commitData({
      activeBannerIndex: current,
      banners,
    });
  },
});
