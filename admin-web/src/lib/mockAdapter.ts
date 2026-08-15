import { DEFAULT_CONFIG } from "../constants";
import type {
  AdminApi,
  AdminConfig,
  AuthSession,
  BatchPatchRequest,
  CaseDraft,
  CaseFilters,
  CaseRecord,
  CreateCaseResult,
  HomeSection,
  HomeSectionOrders,
  ListCasesRequest,
  ListCasesResponse,
  MutationResult,
  UploadedCaseImages,
  UploadProgress,
} from "../types";
import { mergeTagValues, normalizeValues } from "./caseLogic";
import { AdminApiError } from "./errors";
import { getDemoCredentials } from "./demoConfig";
import { createMockCases, createMockOrders } from "./mockFixtures";
import { getSceneLabel } from "./sceneOptions";

const STORE_KEY = "wine-admin-demo-cases-v2";
const ORDER_KEY = "wine-admin-demo-home-orders-v2";
const SESSION_KEY = "wine-admin-demo-session-v1";

function readCases(): CaseRecord[] {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) return JSON.parse(saved) as CaseRecord[];
  } catch {
    // Corrupt local demo data is replaced by the deterministic fixture.
  }
  const seeded = createMockCases();
  writeCases(seeded);
  return seeded;
}

function writeCases(cases: CaseRecord[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(cases));
}

function readOrders(cases = readCases()): HomeSectionOrders {
  try {
    const saved = localStorage.getItem(ORDER_KEY);
    if (saved) return JSON.parse(saved) as HomeSectionOrders;
  } catch {
    // Fall back to order derived from fixtures.
  }
  const orders = createMockOrders(cases);
  writeOrders(orders);
  return orders;
}

function writeOrders(orders: HomeSectionOrders): void {
  localStorage.setItem(ORDER_KEY, JSON.stringify(orders));
}

function delay(ms = 180): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function ensureSession(): AuthSession {
  const session = localStorage.getItem(SESSION_KEY);
  if (!session) throw new AdminApiError("UNAUTHENTICATED", "登录已过期，请重新登录");
  return JSON.parse(session) as AuthSession;
}

function matchesFilters(item: CaseRecord, filters: CaseFilters): boolean {
  if (filters.trash !== Boolean(item.deletedAt)) return false;
  if (filters.visibility === "visible" && !item.isVisible) return false;
  if (filters.visibility === "hidden" && item.isVisible) return false;
  if (filters.isPinned === "pinned" && !item.isPinned) return false;
  if (filters.isPinned === "unpinned" && item.isPinned) return false;

  const keyword = filters.keyword.trim().toLowerCase();
  const searchable = [
    item.title,
    item.caseId,
    item.wineType,
    item.priceLevel,
    item.notes,
    ...item.packageTypes,
    ...item.styles,
    ...item.scenes,
    ...item.scenes.map(getSceneLabel),
    ...item.statuses,
  ]
    .join(" ")
    .toLowerCase();
  if (keyword && !searchable.includes(keyword)) return false;

  const includesAny = (selected: string[], values: string[]) =>
    !selected.length || selected.some((value) => values.includes(value));
  return (
    includesAny(filters.packageTypes, item.packageTypes) &&
    includesAny(filters.styles, item.styles) &&
    includesAny(filters.priceLevel, [item.priceLevel]) &&
    includesAny(filters.scenes, item.scenes) &&
    includesAny(filters.statuses, item.statuses) &&
    includesAny(filters.homeSections, item.homeSections)
  );
}

function checkVersions(items: CaseRecord[], versions: Record<string, number> = {}): void {
  items.forEach((item) => {
    if (versions[item._id] !== undefined && versions[item._id] !== item.version) {
      throw new AdminApiError("VERSION_CONFLICT", `“${item.title}”已被其他管理员更新，请刷新后重试`, {
        item,
      });
    }
  });
}

function assertReady(item: CaseRecord): void {
  if (item.isVisible && (!item.title.trim() || !item.galleryImages.length || !item.packageTypes.length)) {
    throw new AdminApiError("CASE_NOT_READY", "案例上架前需补齐标题、图片和至少一个包装标签");
  }
}

async function filePreview(file: File): Promise<string> {
  return URL.createObjectURL(file);
}

export class MockAdminApi implements AdminApi {
  readonly mode = "mock" as const;
  readonly configured = true;

  async getSession(): Promise<AuthSession | null> {
    await delay(80);
    const saved = localStorage.getItem(SESSION_KEY);
    return saved ? (JSON.parse(saved) as AuthSession) : null;
  }

  async signIn(account: string, password: string): Promise<AuthSession> {
    await delay(420);
    const demoCredentials = getDemoCredentials();
    if (
      !demoCredentials.account ||
      !demoCredentials.password ||
      account.trim() !== demoCredentials.account ||
      password !== demoCredentials.password
    ) {
      throw new AdminApiError("INVALID_PASSWORD", "演示账号或密码不正确");
    }
    const session = {
      user: {
        id: "demo-admin",
        label: "演示管理员",
        email: demoCredentials.account,
      },
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  async signOut(): Promise<void> {
    localStorage.removeItem(SESSION_KEY);
  }

  async checkAccess(): Promise<void> {
    ensureSession();
    await delay(80);
  }

  async getAdminConfig(): Promise<AdminConfig> {
    ensureSession();
    await delay();
    return {
      ...DEFAULT_CONFIG,
      homeSectionOrders: readOrders(),
    };
  }

  async listCases(request: ListCasesRequest): Promise<ListCasesResponse> {
    ensureSession();
    await delay();
    const sort = request.sort || { field: "sortOrder", direction: "asc" as const };
    const filtered = readCases()
      .filter((item) => matchesFilters(item, request.filters))
      .sort((left, right) => {
        const a = left[sort.field];
        const b = right[sort.field];
        const result =
          typeof a === "number" && typeof b === "number"
            ? a - b
            : String(a || "").localeCompare(String(b || ""));
        return sort.direction === "desc" ? -result : result;
      });
    const start = (request.page - 1) * request.pageSize;
    return {
      items: filtered.slice(start, start + request.pageSize),
      total: filtered.length,
      page: request.page,
      pageSize: request.pageSize,
      hasMore: start + request.pageSize < filtered.length,
    };
  }

  async getCase(id: string): Promise<CaseRecord> {
    ensureSession();
    await delay();
    const item = readCases().find((candidate) => candidate._id === id);
    if (!item) throw new AdminApiError("CASE_NOT_FOUND", "案例不存在或已被移入回收站");
    return structuredClone(item);
  }

  async createCase(
    data: Partial<CaseDraft>,
    clientMutationId: string,
    _uploadBatchId?: string,
  ): Promise<CreateCaseResult> {
    ensureSession();
    await delay(260);
    const cases = readCases();
    const existing = cases.find((item) => item.clientMutationId === clientMutationId);
    if (existing) {
      return {
        id: existing._id,
        caseId: existing.caseId,
        version: existing.version,
        duplicate: true,
      };
    }
    const maxCaseNumber = cases.reduce((max, item) => {
      const match = /^case_(\d+)$/.exec(item.caseId);
      return Math.max(max, match ? Number(match[1]) : 0);
    }, 0);
    const id = `mock-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const galleryImages = normalizeValues(data.galleryImages);
    const item: CaseRecord = {
      _id: id,
      id,
      title: String(data.title || "未命名案例").trim(),
      caseId: `case_${String(maxCaseNumber + 1).padStart(3, "0")}`,
      coverImage: String(data.coverImage || galleryImages[0] || ""),
      coverThumbnail: String(data.coverThumbnail || ""),
      coverBanner: String(data.coverBanner || ""),
      coverImageUrl: String(data.coverImage || galleryImages[0] || ""),
      galleryImages,
      sourceGalleryImages: normalizeValues(data.sourceGalleryImages),
      galleryThumbnails: normalizeValues(data.galleryThumbnails),
      galleryBanners: normalizeValues(data.galleryBanners),
      galleryImageUrls: galleryImages,
      imageVariantVersion: Number(data.imageVariantVersion || 2),
      wineType: String(data.wineType || "白酒"),
      packageTypes: normalizeValues(data.packageTypes),
      styles: normalizeValues(data.styles),
      priceLevel: String(data.priceLevel || ""),
      scenes: normalizeValues(data.scenes),
      statuses: normalizeValues(data.statuses),
      homeSections: normalizeValues(data.homeSections) as HomeSection[],
      homeSectionOrder: {},
      sortOrder: cases.filter((candidate) => !candidate.deletedAt).length + 1,
      notes: String(data.notes || ""),
      isVisible: data.isVisible === true,
      isPinned: data.isPinned === true,
      version: 1,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      clientMutationId,
    };
    assertReady(item);
    cases.push(item);
    writeCases(cases);
    return { id, caseId: item.caseId, version: 1 };
  }

  async updateCase(
    id: string,
    data: Partial<CaseDraft>,
    expectedVersion: number,
    clientMutationId: string,
  ): Promise<CaseRecord> {
    ensureSession();
    await delay(260);
    const cases = readCases();
    const index = cases.findIndex((item) => item._id === id);
    if (index < 0) throw new AdminApiError("CASE_NOT_FOUND", "案例不存在");
    if (cases[index].clientMutationId === clientMutationId) {
      return structuredClone(cases[index]);
    }
    checkVersions([cases[index]], { [id]: expectedVersion });
    const next: CaseRecord = {
      ...cases[index],
      ...data,
      _id: id,
      id,
      packageTypes:
        data.packageTypes === undefined ? cases[index].packageTypes : normalizeValues(data.packageTypes),
      styles: data.styles === undefined ? cases[index].styles : normalizeValues(data.styles),
      scenes: data.scenes === undefined ? cases[index].scenes : normalizeValues(data.scenes),
      statuses: data.statuses === undefined ? cases[index].statuses : normalizeValues(data.statuses),
      homeSections:
        data.homeSections === undefined
          ? cases[index].homeSections
          : (normalizeValues(data.homeSections) as HomeSection[]),
      galleryImages:
        data.galleryImages === undefined ? cases[index].galleryImages : normalizeValues(data.galleryImages),
      sourceGalleryImages:
        data.sourceGalleryImages === undefined
          ? cases[index].sourceGalleryImages
          : normalizeValues(data.sourceGalleryImages),
      galleryThumbnails:
        data.galleryThumbnails === undefined
          ? cases[index].galleryThumbnails
          : normalizeValues(data.galleryThumbnails),
      galleryBanners:
        data.galleryBanners === undefined
          ? cases[index].galleryBanners
          : normalizeValues(data.galleryBanners),
      version: cases[index].version + 1,
      updatedAt: new Date().toISOString(),
      clientMutationId,
    };
    next.coverImage = next.galleryImages[0] || next.coverImage;
    next.coverImageUrl = next.galleryImages[0] || next.coverImageUrl;
    next.galleryImageUrls = next.galleryImages;
    assertReady(next);
    cases[index] = next;
    writeCases(cases);
    return structuredClone(next);
  }

  async batchPatchCases(request: BatchPatchRequest): Promise<MutationResult> {
    ensureSession();
    await delay(260);
    if (!request.ids.length || request.ids.length > 50) {
      throw new AdminApiError("INVALID_BATCH", "每次请选择 1–50 个案例");
    }
    const cases = readCases();
    const selected = cases.filter((item) => request.ids.includes(item._id) && !item.deletedAt);
    if (selected.length !== request.ids.length) {
      throw new AdminApiError("CASE_NOT_FOUND", "部分案例不存在，请刷新列表");
    }
    checkVersions(selected, request.expectedVersions);
    const tagMode = request.tagMode || "append";
    const nextItems = selected.map((item) => {
      const next = { ...item, ...(request.patch || {}) };
      (["packageTypes", "styles", "scenes", "statuses"] as const).forEach((field) => {
        const incoming = request.tags?.[field] ?? request.patch?.[field];
        if (incoming !== undefined) {
          next[field] = mergeTagValues(item[field], incoming, tagMode);
        }
      });
      const incomingPriceLevel = request.tags?.priceLevel;
      if (incomingPriceLevel !== undefined) {
        if (incomingPriceLevel.length > 1) {
          throw new AdminApiError("INVALID_BATCH_PATCH", "价位每次只能选择一个值");
        }
        const requestedPriceLevel = String(incomingPriceLevel[0] || "").trim();
        if (tagMode === "replace") {
          next.priceLevel = requestedPriceLevel;
        } else if (tagMode === "remove") {
          next.priceLevel =
            requestedPriceLevel && item.priceLevel === requestedPriceLevel
              ? ""
              : item.priceLevel;
        } else {
          next.priceLevel = item.priceLevel || requestedPriceLevel;
        }
      }
      next.version += 1;
      next.updatedAt = new Date().toISOString();
      assertReady(next);
      return next;
    });
    nextItems.forEach((next) => {
      cases[cases.findIndex((item) => item._id === next._id)] = next;
    });
    writeCases(cases);
    return { updated: nextItems.length };
  }

  async moveCasesToTrash(
    ids: string[],
    expectedVersions: Record<string, number>,
  ): Promise<MutationResult> {
    ensureSession();
    await delay(240);
    const cases = readCases();
    const selected = cases.filter((item) => ids.includes(item._id) && !item.deletedAt);
    checkVersions(selected, expectedVersions);
    selected.forEach((item) => {
      item.deletedAt = new Date().toISOString();
      item.deletedBy = { type: "cloudbase_uid", id: "demo-admin" };
      item.isVisible = false;
      item.isPinned = false;
      item.homeSections = [];
      item.version += 1;
      item.updatedAt = new Date().toISOString();
    });
    writeCases(cases);
    return { moved: selected.length };
  }

  async restoreCases(
    ids: string[],
    expectedVersions: Record<string, number>,
  ): Promise<MutationResult> {
    ensureSession();
    await delay(240);
    const cases = readCases();
    const selected = cases.filter((item) => ids.includes(item._id) && item.deletedAt);
    checkVersions(selected, expectedVersions);
    selected.forEach((item) => {
      item.deletedAt = null;
      item.deletedBy = null;
      item.isVisible = false;
      item.version += 1;
      item.updatedAt = new Date().toISOString();
    });
    writeCases(cases);
    return { restored: selected.length };
  }

  async reorderCases(
    orderedIds: string[],
    expectedVersions: Record<string, number>,
  ): Promise<void> {
    ensureSession();
    await delay(260);
    const cases = readCases();
    const selected = cases.filter((item) => orderedIds.includes(item._id));
    checkVersions(selected, expectedVersions);
    orderedIds.forEach((id, index) => {
      const item = cases.find((candidate) => candidate._id === id);
      if (item) {
        item.sortOrder = index + 1;
        item.version += 1;
        item.updatedAt = new Date().toISOString();
      }
    });
    writeCases(cases);
  }

  async setHomeSectionOrder(
    orders: HomeSectionOrders,
    expectedVersions: Record<string, number>,
  ): Promise<void> {
    ensureSession();
    await delay(300);
    const cases = readCases();
    const allIds = Object.values(orders).flat();
    (Object.keys(orders) as HomeSection[]).forEach((section) => {
      if (orders[section].length > DEFAULT_CONFIG.limits.homepage[section]) {
        throw new AdminApiError(
          "HOME_DISPLAY_LIMIT_REACHED",
          `${section} 区域超出容量限制`,
        );
      }
    });
    const selected = allIds.map((id) => cases.find((candidate) => candidate._id === id));
    if (selected.some((item) => !item || item.deletedAt || !item.isVisible)) {
      throw new AdminApiError("INVALID_HOME_CASE", "首页只能编排存在且已上架的案例");
    }
    const affected = cases.filter(
      (item) => item.homeSections.length > 0 || allIds.includes(item._id),
    );
    checkVersions(affected, expectedVersions);
    cases.forEach((item) => {
      item.homeSections = [];
      item.homeSectionOrder = {};
    });
    (Object.keys(orders) as HomeSection[]).forEach((section) => {
      orders[section].forEach((id, index) => {
        const item = cases.find((candidate) => candidate._id === id)!;
        item.homeSections.push(section);
        item.homeSectionOrder[section] = index + 1;
      });
    });
    affected.forEach((item) => {
      item.version += 1;
      item.updatedAt = new Date().toISOString();
    });
    writeCases(cases);
    writeOrders(structuredClone(orders));
  }

  async uploadCaseImages(
    files: File[],
    _batchId: string,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<UploadedCaseImages> {
    ensureSession();
    const sources: string[] = [];
    for (let index = 0; index < files.length; index += 1) {
      await delay(220);
      sources.push(await filePreview(files[index]));
      onProgress?.({ completed: index + 1, total: files.length, stage: "uploading" });
    }
    await delay(420);
    onProgress?.({ completed: files.length, total: files.length, stage: "processing" });
    return {
      sources,
      variants: sources.map((sourceFileID) => ({
        sourceFileID,
        displayFileID: sourceFileID,
        thumbnailFileID: sourceFileID,
        bannerFileID: sourceFileID,
      })),
    };
  }

  async cleanupUnreferencedFiles(_fileIDs: string[]): Promise<void> {
    // Blob URLs are released by the browser when the demo session ends.
  }
}
