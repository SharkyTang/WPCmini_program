const { fetchCaseById } = require("../../utils/cloudData");
const {
  fetchCaseDetail,
  fetchCaseDetailPatch,
  isLegacyCatalogFallbackAllowed,
} = require("../../utils/caseCatalogService");
const { formatJoined } = require("../../utils/caseData");
const {
  CUSTOMER_SERVICE_SOURCE,
  buildCustomerMessageCard,
  buildCustomerSessionFrom,
} = require("../../utils/customerServiceData");
const {
  fetchFavoriteForCase,
  toggleFavorite,
} = require("../../utils/favoriteService");
const { recordCaseView } = require("../../utils/historyService");
const {
  clearPendingLibraryAction,
  requestLibraryAccess,
  resumePendingLibraryAction,
} = require("../../utils/libraryAccessService");
const { resumePendingProfileAction } = require("../../utils/userService");
const {
  reportClientFault,
  reportPerformanceEvent,
} = require("../../utils/errorTelemetry");

function reportDetailFault(stage, error, options = {}) {
  return reportClientFault({
    type: "catalog_error",
    route: "pages/detail/index",
    stage,
    error,
    action: options.action || "load_case",
    requestKind: options.requestKind || "initial_v2",
    cacheState: "none",
    fallbackUsed: options.fallbackUsed === true,
    disposed: options.disposed === true,
  });
}

function buildInfoRows(caseItem) {
  return [
    {
      label: "包装内容",
      value: formatJoined(caseItem.packageTypes),
    },
    {
      label: "适用场景",
      value: formatJoined(caseItem.scenes),
    },
    {
      label: "价位感",
      value: formatJoined(caseItem.priceLevel),
    },
    {
      label: "风格",
      value: formatJoined(caseItem.styles),
    },
    {
      label: "酒类",
      value: formatJoined(caseItem.wineType),
    },
  ];
}

function buildDetailHeading(caseItem) {
  const packageLabel = caseItem.packageTypes && caseItem.packageTypes[0];
  const wineLabel = caseItem.wineType || "白酒";
  return `${packageLabel || caseItem.title} · ${wineLabel}品牌视觉组合`;
}

function buildDetailSubtitle(caseItem) {
  return formatJoined(
    [caseItem.wineType, ...(caseItem.packageTypes || []), ...(caseItem.styles || [])].filter(Boolean),
    "酒包装设计参考"
  );
}

function buildGalleryItems(caseItem = {}) {
  const gallery = Array.isArray(caseItem.gallery) && caseItem.gallery.length
    ? caseItem.gallery
    : [{ fileID: caseItem.coverImage, url: caseItem.coverImageUrl }];
  return gallery
    .map((item, index) => ({
      ...(item && typeof item === "object" ? item : {}),
      displayUrl: item.displayUrl || item.url || "",
      heroUrl: item.heroUrl || "",
      thumbnailUrl:
        item.thumbnailUrl || item.heroUrl || item.displayUrl || item.url || "",
      renderUrl:
        index === 0
          ? item.displayUrl || item.url || item.heroUrl || item.thumbnailUrl || ""
          : item.thumbnailUrl || item.displayUrl || item.url || item.heroUrl || "",
      downloadUrl: item.downloadUrl || item.displayUrl || item.url || "",
      loaded: Boolean(item.displayUrl || item.url),
      hydrated: item.hydrated === true || Boolean(item.displayUrl || item.url),
      patchLoading: false,
      patchError: false,
      imageRetryCount: 0,
      imageFailed: false,
      index: Number.isInteger(item.index) ? item.index : index,
      positionLabel: `第 ${index + 1} 张`,
    }));
}

function buildCaseView(caseItem = {}) {
  return {
    id: caseItem.id || caseItem._id || "",
    caseId: caseItem.caseId || "",
    title: caseItem.title || "",
    wineType: caseItem.wineType || "",
    packageTypes: caseItem.packageTypes || [],
    styles: caseItem.styles || [],
    priceLevel: caseItem.priceLevel || "",
    scenes: caseItem.scenes || [],
    notes: caseItem.notes || "",
  };
}

function buildCaseShare(pageData = {}) {
  const caseItem = pageData.caseItem;
  const caseId =
    caseItem && (caseItem.id || caseItem._id || caseItem.caseId);
  if (!caseItem || !caseId) {
    return {
      title: "金亿诚包装科技｜酒包装灵感库",
      path: "/pages/index/index",
      query: "",
    };
  }

  const imageUrl =
    (pageData.galleryItems &&
      pageData.galleryItems[0] &&
      pageData.galleryItems[0].displayUrl) ||
    pageData.currentImageUrl ||
    "";
  return {
    title: `${caseItem.title || "酒包装设计案例"}｜金亿诚包装科技`,
    path: `/pages/detail/index?id=${encodeURIComponent(caseId)}`,
    query: `id=${encodeURIComponent(caseId)}`,
    imageUrl,
  };
}

function beginCaseLoading(page) {
  const requestId = (page._caseLoadSequence || 0) + 1;
  page._caseLoadSequence = requestId;
  page._activeCaseLoadRequestId = requestId;
  return requestId;
}

function isCurrentCaseLoad(page, requestId) {
  return page._activeCaseLoadRequestId === requestId;
}

function cancelCaseLoading(page) {
  page._caseLoadSequence = (page._caseLoadSequence || 0) + 1;
  page._activeCaseLoadRequestId = 0;
}

function isPageAlive(page) {
  return page._alive !== false;
}

function canCommitCase(page, requestId) {
  return isPageAlive(page) && isCurrentCaseLoad(page, requestId);
}

function safeSetData(page, patch, callback) {
  if (!isPageAlive(page)) return false;
  try {
    page.setData(patch, () => {
      if (isPageAlive(page) && typeof callback === "function") callback();
    });
    return true;
  } catch (error) {
    console.error("详情页状态更新失败", error);
    return false;
  }
}

function runNextTick(callback) {
  if (wx && typeof wx.nextTick === "function") {
    wx.nextTick(callback);
    return;
  }
  Promise.resolve().then(callback);
}

function getCurrentCaseItem(page) {
  return page._caseItem || page.data.caseItem;
}

Page({
  data: {
    loading: true,
    renderPhase: "skeleton",
    errorMessage: "",
    errorCanRetry: false,
    caseItem: null,
    infoRows: [],
    detailHeading: "",
    detailSubtitle: "",
    favorite: null,
    isFavorited: false,
    favoriteLoading: false,
    galleryItems: [],
    currentImageIndex: 0,
    currentImageUrl: "",
    customerServiceMessageCardEnabled: false,
    customerServiceMessageTitle: "",
    customerServiceMessagePath: "",
    customerServiceMessageImage: "",
    customerServiceSessionFrom: buildCustomerSessionFrom({
      source: CUSTOMER_SERVICE_SOURCE.DETAIL,
    }),
  },

  onLoad(options = {}) {
    this._alive = true;
    this._caseLoadSequence = 0;
    this._activeCaseLoadRequestId = 0;
    this._galleryPatchPromises = new Map();
    this._favoriteStateVersion = 0;
    this._caseItem = null;
    this._caseId = "";
    this._detailStartedAt = Date.now();
    void this.loadCase(options.id);
  },

  onShow() {
    if (!this.data.favoriteLoading) return Promise.resolve(false);
    return this.resumePendingFavoriteAction();
  },

  onUnload() {
    this._alive = false;
    cancelCaseLoading(this);
    this._favoriteStateVersion = (this._favoriteStateVersion || 0) + 1;
    this._galleryPatchPromises = new Map();
    clearPendingLibraryAction("detail_favorite");
  },

  onShareAppMessage() {
    const share = buildCaseShare(this.data);
    const result = {
      title: share.title,
      path: share.path,
    };
    if (share.imageUrl) {
      result.imageUrl = share.imageUrl;
    }
    return result;
  },

  onShareTimeline() {
    const share = buildCaseShare(this.data);
    const result = {
      title: share.title,
      query: share.query,
    };
    if (share.imageUrl) {
      result.imageUrl = share.imageUrl;
    }
    return result;
  },

  async loadCase(id) {
    if (!id) {
      cancelCaseLoading(this);
      safeSetData(this, {
        loading: false,
        renderPhase: "error",
        errorMessage: "没有找到这个案例的 ID。",
        errorCanRetry: false,
      });
      return false;
    }

    if (this._alive === undefined) this._alive = true;
    if (!this._galleryPatchPromises) this._galleryPatchPromises = new Map();
    const requestId = beginCaseLoading(this);
    this._favoriteStateVersion = (this._favoriteStateVersion || 0) + 1;
    safeSetData(this, {
      loading: true,
      renderPhase: "skeleton",
      errorMessage: "",
      errorCanRetry: false,
    });

    try {
      const decodedId = decodeURIComponent(id);
      if (this._caseId !== decodedId) {
        this._galleryMismatchReloaded = false;
      }
      this._caseId = decodedId;
      let caseItem;
      try {
        caseItem = await fetchCaseDetail(decodedId, { detailMode: "initial_v2" });
      } catch (catalogError) {
        if (!canCommitCase(this, requestId)) return false;
        if (!isLegacyCatalogFallbackAllowed(catalogError)) throw catalogError;
        reportDetailFault("catalog_fallback", catalogError, {
          action: "get_case_detail",
          requestKind: "initial_v2",
          fallbackUsed: true,
        });
        console.warn("详情聚合接口不可用，使用兼容读取", catalogError);
        caseItem = await fetchCaseById(decodedId);
      }
      if (!canCommitCase(this, requestId)) return false;
      const galleryItems = buildGalleryItems(caseItem);
      const customerServiceMessageCard = buildCustomerMessageCard({
        caseItem,
        imageUrl: galleryItems[0]
          ? galleryItems[0].displayUrl || galleryItems[0].heroUrl || galleryItems[0].renderUrl
          : "",
      });
      const caseView = buildCaseView(caseItem);
      this._caseItem = caseItem;
      let deferredStarted = false;
      const startDeferredWork = () => {
        if (deferredStarted || !canCommitCase(this, requestId)) return;
        deferredStarted = true;
        runNextTick(() => {
          if (!canCommitCase(this, requestId)) return;
          void this.loadFavoriteState(caseItem, requestId);
          void this.recordView(caseItem, requestId);
          this.reportDetailReady("success");
        });
      };
      safeSetData(this, {
        loading: false,
        renderPhase: "ready",
        errorCanRetry: false,
        caseItem: caseView,
        infoRows: buildInfoRows(caseItem),
        detailHeading: buildDetailHeading(caseItem),
        detailSubtitle: buildDetailSubtitle(caseItem),
        galleryItems,
        currentImageIndex: 0,
        currentImageUrl: galleryItems[0]
          ? galleryItems[0].displayUrl || galleryItems[0].heroUrl || galleryItems[0].renderUrl
          : "",
        customerServiceMessageCardEnabled: customerServiceMessageCard.enabled,
        customerServiceMessageTitle: customerServiceMessageCard.title,
        customerServiceMessagePath: customerServiceMessageCard.path,
        customerServiceMessageImage: customerServiceMessageCard.imageUrl,
        customerServiceSessionFrom: buildCustomerSessionFrom({
          source: CUSTOMER_SERVICE_SOURCE.DETAIL,
          caseItem,
        }),
      }, startDeferredWork);
      return true;
    } catch (error) {
      if (!canCommitCase(this, requestId)) return false;
      console.error("案例详情读取失败", error);
      reportDetailFault("load_error", error, {
        action: "load_case",
        requestKind: "initial_v2",
      });
      safeSetData(this, {
        loading: false,
        renderPhase: "error",
        errorMessage: "暂时读取不到这个案例，请返回后重试。",
        errorCanRetry: true,
      });
      this.reportDetailReady("error");
      return false;
    }
  },

  retryLoadCase() {
    if (!isPageAlive(this) || !this._caseId) return Promise.resolve(false);
    return this.loadCase(this._caseId);
  },

  async loadFavoriteState(
    caseItem,
    requestId = this._activeCaseLoadRequestId,
    favoriteStateVersion = this._favoriteStateVersion
  ) {
    try {
      const favorite = await fetchFavoriteForCase(caseItem);
      if (
        !canCommitCase(this, requestId)
        || favoriteStateVersion !== this._favoriteStateVersion
      ) return;
      safeSetData(this, {
        favorite,
        isFavorited: Boolean(favorite),
      });
    } catch (error) {
      console.warn("收藏状态读取失败", error);
    }
  },

  async recordView(caseItem, requestId = this._activeCaseLoadRequestId) {
    try {
      await recordCaseView(caseItem);
      if (!canCommitCase(this, requestId)) return;
    } catch (error) {
      console.warn("浏览记录写入失败", error);
    }
  },

  reportDetailReady(result) {
    if (this._detailReadyReported) return;
    this._detailReadyReported = true;
    reportPerformanceEvent("page_ready_result", {
      route: "pages/detail/index",
      stage: "detail_initial_v2",
      durationMs: Math.max(0, Date.now() - (this._detailStartedAt || Date.now())),
      success: result === "success",
      action: "getCaseDetail",
      requestKind: "initial_v2",
      cacheState: "none",
    });
  },

  async toggleFavorite() {
    if (!isPageAlive(this) || !getCurrentCaseItem(this) || this.data.favoriteLoading) return;

    safeSetData(this, {
      favoriteLoading: true,
    });

    try {
      const access = await requestLibraryAccess({
        kind: "favorites",
        source: "detail_favorite",
        resume: () =>
          this.performToggleFavorite({ resumedAfterProfileSetup: true }),
      });
      if (!isPageAlive(this)) return;
      if (access && access.status === "ready") {
        await this.performToggleFavorite();
        return;
      }

      if (access && access.status === "redirected") {
        return;
      }

      safeSetData(this, { favoriteLoading: false });
      if (access && access.status === "error") {
        wx.showToast({
          title:
            access.stage === "navigation"
              ? "暂时无法打开资料页，请重试"
              : "暂时无法验证资料，请重试",
          icon: "none",
        });
      }
    } catch (error) {
      if (!isPageAlive(this)) return;
      console.error("收藏访问检查失败", error);
      safeSetData(this, { favoriteLoading: false });
      wx.showToast({
        title: "暂时无法验证资料，请重试",
        icon: "none",
      });
    }
  },

  async resumePendingFavoriteAction() {
    if (!isPageAlive(this) || !this.data.favoriteLoading) return false;
    try {
      const resumeResult = await resumePendingLibraryAction("detail_favorite");
      if (!isPageAlive(this)) return false;
      const libraryResumed = resumeResult === true
        || Boolean(resumeResult && resumeResult.resumed);
      if (libraryResumed) return true;

      const legacyResumeResult = await resumePendingProfileAction();
      if (!isPageAlive(this)) return false;
      const legacyResumed = legacyResumeResult === true
        || Boolean(legacyResumeResult && legacyResumeResult.resumed);
      if (!legacyResumed && this.data.favoriteLoading) {
        safeSetData(this, { favoriteLoading: false });
      }
      return legacyResumed;
    } catch (error) {
      if (!isPageAlive(this)) return false;
      console.error("恢复收藏操作失败", error);
      safeSetData(this, { favoriteLoading: false });
      wx.showToast({
        title: "收藏操作失败",
        icon: "none",
      });
      return false;
    }
  },

  async performToggleFavorite(options = {}) {
    const caseItem = getCurrentCaseItem(this);
    if (!isPageAlive(this)) return false;
    if (!caseItem) {
      safeSetData(this, { favoriteLoading: false });
      if (options.resumedAfterProfileSetup) {
        wx.showToast({
          title: "资料已完成，收藏失败，请重试",
          icon: "none",
        });
      }
      return false;
    }

    const favoriteStateVersion = (this._favoriteStateVersion || 0) + 1;
    this._favoriteStateVersion = favoriteStateVersion;

    try {
      const result = await toggleFavorite(caseItem, this.data.favorite);
      if (
        !isPageAlive(this)
        || caseItem !== getCurrentCaseItem(this)
        || favoriteStateVersion !== this._favoriteStateVersion
      ) return false;
      safeSetData(this, {
        favoriteLoading: false,
        favorite: result.favorite,
        isFavorited: result.isFavorited,
      });

      if (result.action === "limitReached") {
        wx.showToast({
          title: "收藏已满，可先取消一些收藏",
          icon: "none",
        });
        return false;
      }

      if (result.action === "cancelled") {
        if (options.resumedAfterProfileSetup) {
          wx.showToast({
            title: "资料已完成，收藏失败，请重试",
            icon: "none",
          });
        }
        return false;
      }

      wx.showToast({
        title: result.isFavorited ? "已收藏" : "已取消收藏",
        icon: "success",
      });
      return true;
    } catch (error) {
      if (!isPageAlive(this)) return false;
      console.error("收藏操作失败", error);
      safeSetData(this, {
        favoriteLoading: false,
      });
      wx.showToast({
        title: options.resumedAfterProfileSetup
          ? "资料已完成，收藏失败，请重试"
          : "收藏操作失败",
        icon: "none",
      });
      return false;
    }
  },

  async hydrateGalleryIndexes(indexes = []) {
    if (!isPageAlive(this) || !this._caseId || typeof fetchCaseDetailPatch !== "function") {
      return false;
    }
    const requestedIndexes = Array.from(
      new Set(
        indexes
          .map(Number)
          .filter(
            (index) =>
              Number.isInteger(index)
              && index >= 0
              && index < (this.data.galleryItems || []).length
          )
      )
    );
    const missingIndexes = requestedIndexes.filter((index) => {
      const item = this.data.galleryItems[index];
      return item && item.fileID && !item.displayUrl;
    });
    if (!missingIndexes.length) return true;

    const existingTasks = missingIndexes
      .map((index) => this._galleryPatchPromises.get(index))
      .filter(Boolean);
    const newIndexes = missingIndexes.filter(
      (index) => !this._galleryPatchPromises.has(index)
    );
    let newTask = null;
    if (newIndexes.length) {
      const requestId = this._activeCaseLoadRequestId;
      const caseId = this._caseId;
      const loadingItems = this.data.galleryItems.map((item, index) =>
        newIndexes.includes(index)
          ? { ...item, patchLoading: true, patchError: false }
          : item
      );
      safeSetData(this, { galleryItems: loadingItems });
      newTask = (async () => {
        let succeeded = false;
        try {
          const patches = await fetchCaseDetailPatch(caseId, newIndexes);
          if (!canCommitCase(this, requestId) || caseId !== this._caseId) return false;
          let mismatch = false;
          const nextItems = this.data.galleryItems.map((item) => ({ ...item }));
          patches.forEach((patch) => {
            const current = nextItems[patch.index];
            if (!current) return;
            if (!patch.fileID || patch.fileID !== current.fileID) {
              mismatch = true;
              return;
            }
            current.displayUrl = patch.displayUrl || "";
            current.downloadUrl = patch.downloadUrl || patch.displayUrl || "";
            current.renderUrl = patch.displayUrl || current.renderUrl;
            current.loaded = Boolean(patch.displayUrl);
            current.hydrated = Boolean(patch.displayUrl);
            current.patchLoading = false;
            current.patchError = !patch.displayUrl;
          });
          newIndexes.forEach((index) => {
            const item = nextItems[index];
            if (!item) return;
            item.patchLoading = false;
            if (!item.displayUrl) item.patchError = true;
          });
          const selected = nextItems[this.data.currentImageIndex];
          safeSetData(this, {
            galleryItems: nextItems,
            currentImageUrl: selected
              ? selected.displayUrl || selected.heroUrl || selected.thumbnailUrl || ""
              : this.data.currentImageUrl,
          });
          succeeded = newIndexes.every(
            (index) => nextItems[index] && nextItems[index].displayUrl
          );
          if (mismatch && !this._galleryMismatchReloaded) {
            this._galleryMismatchReloaded = true;
            void this.loadCase(caseId);
          }
          return succeeded;
        } catch (error) {
          if (!canCommitCase(this, requestId) || caseId !== this._caseId) return false;
          console.warn("案例展示图读取失败", error);
          reportDetailFault("gallery_patch_error", error, {
            action: "gallery_patch",
            requestKind: "gallery_patch_v2",
          });
          const failedItems = this.data.galleryItems.map((item, index) =>
            newIndexes.includes(index)
              ? { ...item, patchLoading: false, patchError: true }
              : item
          );
          safeSetData(this, { galleryItems: failedItems });
          return false;
        } finally {
          newIndexes.forEach((index) => {
            if (this._galleryPatchPromises.get(index) === newTask) {
              this._galleryPatchPromises.delete(index);
            }
          });
        }
      })();
      newIndexes.forEach((index) => this._galleryPatchPromises.set(index, newTask));
    }
    const tasks = Array.from(new Set([...existingTasks, newTask].filter(Boolean)));
    await Promise.all(tasks);
    return requestedIndexes.every((index) => {
      const item = this.data.galleryItems[index];
      return item && item.displayUrl;
    });
  },

  async previewImage() {
    const missingIndexes = (this.data.galleryItems || [])
      .filter((item) => item && item.fileID && !item.displayUrl)
      .map((item) => item.index);
    if (missingIndexes.length) {
      await this.hydrateGalleryIndexes(missingIndexes);
    }
    if (!isPageAlive(this)) return;
    const urls = (this.data.galleryItems || [])
      .map((item) => item && item.displayUrl)
      .filter(Boolean);
    const selected = this.data.galleryItems[this.data.currentImageIndex];
    const current = selected && selected.displayUrl;
    if (!current || !urls.length) {
      wx.showToast({
        title: missingIndexes.length ? "图片加载失败" : "暂无图片",
        icon: "none",
      });
      return;
    }

    const page = this;
    wx.previewImage({
      current: urls.includes(current) ? current : urls[0],
      urls,
      showmenu: true,
      fail(error) {
        console.warn("案例图片预览失败", error);
        if (!isPageAlive(page)) return;
        wx.showToast({
          title: "图片预览失败",
          icon: "none",
        });
      },
    });
  },

  onGalleryChange(event) {
    const currentImageIndex = Number(event.detail && event.detail.current) || 0;
    void this.showGalleryImage(currentImageIndex);
  },

  selectGalleryImage(event) {
    const currentImageIndex = Number(event.currentTarget.dataset.index) || 0;
    void this.showGalleryImage(currentImageIndex);
  },

  async showGalleryImage(currentImageIndex) {
    const current = this.data.galleryItems[currentImageIndex];
    if (!current) return;
    const galleryItems = current.displayUrl && current.renderUrl !== current.displayUrl
      ? this.data.galleryItems.map((item, index) =>
          index === currentImageIndex
            ? { ...item, renderUrl: item.displayUrl, loaded: true, hydrated: true }
            : item
        )
      : this.data.galleryItems;
    safeSetData(this, {
      galleryItems,
      currentImageIndex,
      currentImageUrl:
        current.displayUrl || current.heroUrl || current.thumbnailUrl || current.renderUrl || "",
    });
    if (!current.displayUrl) {
      await this.hydrateGalleryIndexes([currentImageIndex]);
    }
    if (
      !isPageAlive(this)
      || this.data.currentImageIndex !== currentImageIndex
    ) return;
    const hydrated = this.data.galleryItems[currentImageIndex];
    if (!hydrated) return;
    safeSetData(this, {
      currentImageUrl:
        hydrated.displayUrl || hydrated.heroUrl || hydrated.thumbnailUrl || "",
    });
  },

  onHeroImageError(event) {
    const index = Number(event && event.currentTarget && event.currentTarget.dataset.index);
    if (!Number.isInteger(index)) return;
    const current = this.data.galleryItems[index];
    if (!current) return;
    const originalUrl = current.renderUrl;
    if (current.imageRetryCount < 1 && originalUrl) {
      const retryItems = this.data.galleryItems.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, renderUrl: "", imageRetryCount: 1 }
          : item
      );
      safeSetData(this, { galleryItems: retryItems });
      runNextTick(() => {
        if (!isPageAlive(this)) return;
        const nextItems = this.data.galleryItems.map((item, itemIndex) =>
          itemIndex === index
            ? { ...item, renderUrl: originalUrl }
            : item
        );
        safeSetData(this, { galleryItems: nextItems });
      });
      return;
    }
    const fallbackUrl = current.thumbnailUrl !== originalUrl
      ? current.thumbnailUrl
      : "";
    const failedItems = this.data.galleryItems.map((item, itemIndex) =>
      itemIndex === index
        ? { ...item, renderUrl: fallbackUrl, imageFailed: true }
        : item
    );
    safeSetData(this, { galleryItems: failedItems });
  },

  handleContact(event) {
    console.log("案例客服会话入口", event.detail || {});
  },

  openInquiryForm() {
    const caseItem = getCurrentCaseItem(this);
    if (!caseItem) return;

    const caseDocId = caseItem.id || caseItem._id || caseItem.caseId;
    wx.navigateTo({
      url: `/pages/inquiry/index?source=detail&id=${encodeURIComponent(caseDocId)}`,
    });
  },

  goBack() {
    wx.navigateBack({
      fail() {
        wx.switchTab({
          url: "/pages/category/index",
        });
      },
    });
  },
});
