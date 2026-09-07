import cloudbase from "@cloudbase/js-sdk";
import type {
  AdminActivityItem,
  AdminActivitySubscription,
  AdminApi,
  AdminConfig,
  AuthSession,
  BatchPatchRequest,
  CaseDraft,
  CaseRecord,
  CleanupUnreferencedFilesResult,
  CreateCaseResult,
  FileUploadProgress,
  HomeSectionOrders,
  ListPendingPurgeJobsRequest,
  ListCasesRequest,
  ListCasesResponse,
  MutationResult,
  PendingPurgeJob,
  PermanentDeleteResult,
  RegisterUploadItemInput,
  SharedUploadItem,
  UploadedCaseImages,
  UploadedCaseVideo,
  UploadedVideoPoster,
  UploadItemStatusPatch,
  UploadProgress,
  VideoFileMetadata,
  VideoPatch,
} from "../types";
import { assertAdminAccess } from "./accessLogic";
import { buildStoragePath } from "./caseLogic";
import { AdminApiError } from "./errors";
import { normalizeAdminConfig, normalizeCaseRecord, toCasePayload } from "./normalizers";

type ResultEnvelope = {
  ok?: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
};

type AuthLike = {
  getSession: () => Promise<{
    data?: { session?: { user?: Record<string, unknown> } | null };
    error?: { code?: string; message?: string } | null;
  }>;
  signInWithPassword: (
    input: Record<string, string>,
  ) => Promise<{
    data?: { user?: Record<string, unknown>; session?: unknown };
    error?: { code?: string; message?: string } | null;
  }>;
  signOut: () => Promise<{ error?: { code?: string; message?: string } | null } | void>;
};

type StorageLike = {
  upload: (
    path: string,
    file: File,
    options?: Record<string, unknown>,
  ) => Promise<{
    data?: { id?: string; path?: string; fullPath?: string } | null;
    error?: { code?: string; message?: string } | null;
  }>;
};

type RealtimeSnapshotLike = {
  docs?: Record<string, unknown>[];
};

type RealtimeQueryLike = {
  where: (query: Record<string, unknown>) => RealtimeQueryLike;
  orderBy: (field: string, order: "asc" | "desc") => RealtimeQueryLike;
  limit: (count: number) => RealtimeQueryLike;
  watch: (options: {
    onChange: (snapshot: RealtimeSnapshotLike) => void;
    onError: (error: unknown) => void;
  }) => AdminActivitySubscription;
};

type DatabaseLike = {
  collection: (name: string) => RealtimeQueryLike;
};

type CloudbaseAppLike = {
  auth: AuthLike;
  callFunction: (input: {
    name: string;
    data: Record<string, unknown>;
    parse?: boolean;
  }) => Promise<Record<string, unknown>>;
  storage: {
    from: () => StorageLike;
  };
  uploadFile: (input: {
    cloudPath: string;
    filePath: File;
    method?: "post" | "put";
    onUploadProgress?: (event: { loaded?: number; total?: number }) => void;
  }) => Promise<{ fileID?: string }>;
  database: () => DatabaseLike;
};

const cloudConfig = {
  env: import.meta.env.VITE_CLOUDBASE_ENV_ID?.trim() || "",
  region: import.meta.env.VITE_CLOUDBASE_REGION?.trim() || "ap-shanghai",
  accessKey: import.meta.env.VITE_CLOUDBASE_PUBLISHABLE_KEY?.trim() || "",
};

function userFromRaw(raw: Record<string, unknown> | undefined): AuthSession {
  const user = raw || {};
  const id = String(user.id || user.uid || user.user_id || "");
  const email = String(user.email || "");
  const username = String(user.username || "");
  return {
    user: {
      id,
      email: email || undefined,
      label: username || email || "管理员",
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function normalizeCleanupFileIDs(value: unknown, requested: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((fileID) => String(fileID || ""))
    .filter((fileID) => fileID && requested.has(fileID)))];
}

function normalizeCleanupResult(
  requestedFileIDs: string[],
  value: Record<string, unknown>,
): CleanupUnreferencedFilesResult {
  const requested = [...new Set(requestedFileIDs.filter(Boolean))];
  const requestedSet = new Set(requested);
  const explicitFailed = new Set(normalizeCleanupFileIDs(value.failedFileIds, requestedSet));
  const deleted = new Set(
    normalizeCleanupFileIDs(value.deletedFileIds, requestedSet)
      .filter((fileID) => !explicitFailed.has(fileID)),
  );
  const skipped = new Set(
    normalizeCleanupFileIDs(value.skippedFileIds, requestedSet)
      .filter((fileID) => !explicitFailed.has(fileID) && !deleted.has(fileID)),
  );
  const failed = new Set(explicitFailed);
  requested.forEach((fileID) => {
    if (!deleted.has(fileID) && !skipped.has(fileID)) failed.add(fileID);
  });
  return {
    deletedFileIds: requested.filter((fileID) => deleted.has(fileID)),
    skippedFileIds: requested.filter((fileID) => skipped.has(fileID)),
    failedFileIds: requested.filter((fileID) => failed.has(fileID)),
  };
}

function parseFunctionValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function dateText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  const record = asRecord(value);
  if (!record) return "";
  const candidate = record.$date ?? record.timestamp ?? record.seconds;
  if (typeof candidate !== "number") return "";
  return new Date(candidate < 10_000_000_000 ? candidate * 1000 : candidate).toISOString();
}

function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const record = asRecord(value);
  return Array.isArray(record?.values) ? record.values.map(String).filter(Boolean) : [];
}

function normalizeSharedUploadItem(value: unknown): SharedUploadItem {
  const raw = asRecord(value) || {};
  const actor = asRecord(raw.actor);
  return {
    id: String(raw._id || raw.id || raw.mutationId || ""),
    mutationId: String(raw.mutationId || ""),
    uploadBatchId: String(raw.uploadBatchId || raw.batchId || ""),
    ownerUid: String(raw.ownerUid || raw.actorId || actor?.id || ""),
    ownerLabel: String(
      raw.ownerLabel || raw.ownerDisplayName || raw.actorDisplayName || raw.actorLabel || "管理员",
    ),
    title: String(raw.title || "未命名案例"),
    imageCount: Math.max(0, Number(raw.imageCount || 0)),
    packageTypes: textArray(raw.packageTypes),
    scenes: textArray(raw.scenes),
    status: String(raw.status || "waiting") as SharedUploadItem["status"],
    updatedAt: dateText(raw.updatedAt || raw.createdAt),
  };
}

function normalizeAdminActivity(value: unknown): AdminActivityItem {
  const raw = asRecord(value) || {};
  const actor = asRecord(raw.actor);
  return {
    id: String(
      raw._id || raw.id || raw.eventId || `${raw.action || "activity"}-${raw.createdAt || ""}`,
    ),
    actorId: String(raw.actorId || raw.ownerUid || actor?.id || ""),
    actorLabel: String(
      raw.actorDisplayName || raw.actorLabel || raw.ownerLabel || "管理员",
    ),
    action: String(raw.action || "upload_queued") as AdminActivityItem["action"],
    title: String(raw.title || raw.targetTitle || "未命名案例"),
    caseId: raw.caseId ? String(raw.caseId) : undefined,
    mutationId: raw.mutationId ? String(raw.mutationId) : undefined,
    uploadBatchId: raw.uploadBatchId || raw.batchId
      ? String(raw.uploadBatchId || raw.batchId)
      : undefined,
    imageCount: raw.imageCount === undefined ? undefined : Math.max(0, Number(raw.imageCount || 0)),
    status: raw.status ? String(raw.status) as AdminActivityItem["status"] : undefined,
    createdAt: dateText(raw.createdAt || raw.updatedAt),
  };
}

function normalizePermanentDeleteResult(
  value: Partial<PermanentDeleteResult> & Record<string, unknown>,
): PermanentDeleteResult {
  return {
    deleted: Number(value.deleted || 0),
    cleanupJobId: String(value.cleanupJobId || value.jobId || ""),
    deletedFileCount: Number(value.deletedFileCount || 0),
    retainedReferencedCount: Number(value.retainedReferencedCount || 0),
    pendingFileCount: Number(value.pendingFileCount || 0),
  };
}

function normalizePendingPurgeJob(value: unknown): PendingPurgeJob {
  const raw = asRecord(value) || {};
  return {
    ...normalizePermanentDeleteResult(raw),
    clientMutationId: String(raw.clientMutationId || ""),
    status: String(raw.status || "cleanup_pending"),
    createdAt: dateText(raw.createdAt) || undefined,
    updatedAt: dateText(raw.updatedAt || raw.createdAt) || undefined,
  };
}

function cloudFunctionError(
  value: unknown,
  fallbackCode = "FUNCTIONS_INVOCATION_FAILED",
  fallbackMessage = "云函数调用失败",
): AdminApiError {
  const raw = asRecord(value) || {};
  return new AdminApiError(
    String(raw.code || raw.error || fallbackCode),
    String(raw.message || raw.error_description || fallbackMessage),
    raw,
  );
}

function unwrapFunctionResponse(response: unknown): ResultEnvelope {
  const wrapper = asRecord(response);
  if (!wrapper) {
    throw new AdminApiError("INVALID_RESPONSE", "云函数返回格式无效", response);
  }

  if (wrapper.error) throw cloudFunctionError(wrapper.error);

  const topLevelCode = String(wrapper.code ?? "").trim();
  if (
    topLevelCode &&
    !["0", "OK", "SUCCESS"].includes(topLevelCode.toUpperCase())
  ) {
    throw cloudFunctionError(wrapper);
  }

  let candidate: unknown;
  if (Object.prototype.hasOwnProperty.call(wrapper, "result")) {
    candidate = wrapper.result;
  } else if (Object.prototype.hasOwnProperty.call(wrapper, "data")) {
    const data = asRecord(wrapper.data);
    if (data?.error) throw cloudFunctionError(data.error);
    candidate = data && Object.prototype.hasOwnProperty.call(data, "result")
      ? data.result
      : wrapper.data;
  } else if (Object.prototype.hasOwnProperty.call(wrapper, "ok")) {
    candidate = wrapper;
  }

  const result = asRecord(parseFunctionValue(candidate));
  if (!result) {
    throw new AdminApiError(
      "INVALID_RESPONSE",
      "云函数未返回可识别的数据",
      {
        responseKeys: Object.keys(wrapper),
        requestId: wrapper.requestId,
      },
    );
  }
  if (!Object.prototype.hasOwnProperty.call(result, "ok")) {
    if (result.code || result.message) throw cloudFunctionError(result);
    throw new AdminApiError(
      "INVALID_RESPONSE",
      "云函数返回内容不完整",
      {
        resultKeys: Object.keys(result),
        requestId: wrapper.requestId,
      },
    );
  }
  return result as ResultEnvelope;
}

export class CloudbaseAdminApi implements AdminApi {
  readonly mode = "cloudbase" as const;
  readonly configured = Boolean(cloudConfig.env && cloudConfig.accessKey);
  private app: CloudbaseAppLike | null = null;

  private getApp(): CloudbaseAppLike {
    if (!this.configured) {
      throw new AdminApiError(
        "CONFIG_MISSING",
        "缺少 CloudBase 环境 ID 或 Publishable Key，请检查环境变量",
      );
    }
    if (!this.app) {
      this.app = cloudbase.init({
        env: cloudConfig.env,
        region: cloudConfig.region,
        accessKey: cloudConfig.accessKey,
        auth: { detectSessionInUrl: true },
      }) as unknown as CloudbaseAppLike;
    }
    return this.app;
  }

  private getAuth(): AuthLike {
    return this.getApp().auth;
  }

  private async call<T extends ResultEnvelope>(
    functionName: string,
    data: Record<string, unknown>,
  ): Promise<T> {
    let response: Record<string, unknown>;
    try {
      response = await this.getApp().callFunction({
        name: functionName,
        data,
        // Publishable Key requests use CloudBase's gateway endpoint. Without
        // parse=true, object return values can be exposed as an empty/raw
        // response and the admin config silently falls back to read-only.
        parse: true,
      });
    } catch (error) {
      if (error instanceof AdminApiError) throw error;
      const raw = error && typeof error === "object"
        ? error as Record<string, unknown>
        : {};
      const message = error instanceof Error
        ? error.message
        : String(raw.message || raw.error_description || "网络连接失败");
      console.error(
        `[case-admin] cloud function request failed ${JSON.stringify({
          functionName,
          action: String(data.action || ""),
          code: String(raw.code || raw.error || "NETWORK_ERROR"),
          message,
        })}`,
      );
      throw new AdminApiError("NETWORK_ERROR", message, error);
    }
    let result: ResultEnvelope;
    try {
      result = unwrapFunctionResponse(response);
    } catch (error) {
      const normalized = error instanceof AdminApiError
        ? error
        : cloudFunctionError(error);
      console.error(
        `[case-admin] cloud function response failed ${JSON.stringify({
          functionName,
          action: String(data.action || ""),
          code: normalized.code,
          message: normalized.message,
        })}`,
      );
      throw normalized;
    }
    if (result.ok === false) {
      throw new AdminApiError(
        String(result.code || "SERVER_ERROR"),
        String(result.message || "服务暂不可用"),
        result,
      );
    }
    return result as T;
  }

  private callAdmin<T extends ResultEnvelope>(
    data: Record<string, unknown>,
  ): Promise<T> {
    return this.call<T>(
      import.meta.env.VITE_CASE_ADMIN_FUNCTION?.trim() || "caseAdmin",
      data,
    );
  }

  async getSession(): Promise<AuthSession | null> {
    if (!this.configured) return null;
    const { data, error } = await this.getAuth().getSession();
    if (error) throw new AdminApiError(error.code || "AUTH_ERROR", error.message || "读取登录状态失败");
    if (!data?.session?.user) return null;
    return userFromRaw(data.session.user);
  }

  async signIn(account: string, password: string): Promise<AuthSession> {
    const trimmed = account.trim();
    const identity: Record<string, string> = trimmed.includes("@")
      ? { email: trimmed }
      : /^1[3-9]\d{9}$/.test(trimmed)
        ? { phone: trimmed }
        : { username: trimmed };
    // JS SDK v3 的密码登录签名不提供 shouldCreateUser；生产环境必须在
    // CloudBase 控制台关闭公开注册，后台这里只负责登录预建账号。
    const { data, error } = await this.getAuth().signInWithPassword({
      ...identity,
      password,
    });
    if (error) {
      throw new AdminApiError(error.code || "AUTH_ERROR", error.message || "账号或密码不正确");
    }
    if (!data?.user) throw new AdminApiError("AUTH_ERROR", "登录成功但未返回用户信息");
    const session = userFromRaw(data.user);
    try {
      await this.checkAccess();
    } catch (error) {
      try {
        await this.getAuth().signOut();
      } catch {
        // Keep the original authorization error.
      }
      throw error;
    }
    return session;
  }

  async signOut(): Promise<void> {
    const response = await this.getAuth().signOut();
    if (response && "error" in response && response.error) {
      throw new AdminApiError(
        response.error.code || "AUTH_ERROR",
        response.error.message || "退出登录失败",
      );
    }
  }

  async checkAccess(): Promise<void> {
    const result = await this.callAdmin<
      ResultEnvelope & { isAdmin?: boolean; authenticated?: boolean }
    >({ action: "checkAccess" });
    assertAdminAccess(result);
  }

  async getAdminConfig(): Promise<AdminConfig> {
    const result = await this.callAdmin<ResultEnvelope>({
      action: "getAdminConfig",
    });
    const rawConfig = result.config || result;
    const config = normalizeAdminConfig(rawConfig);
    console.info(
      `[case-admin] admin config loaded ${JSON.stringify({
        resultKeys: Object.keys(result).slice(0, 12),
        rawWriteEnabled:
          rawConfig && typeof rawConfig === "object"
            ? (rawConfig as Record<string, unknown>).writeEnabled
            : undefined,
        aliasWriteEnabled: result.webWriteEnabled,
        normalizedWriteEnabled: config.writeEnabled,
      })}`,
    );
    return config;
  }

  private async hydrate(items: CaseRecord[], includeGallery = false): Promise<CaseRecord[]> {
    const fileIDs = [
      ...new Set(
        items
          .flatMap((item) => [
            item.coverThumbnail || item.coverImage,
            ...(includeGallery ? item.galleryImages : []),
          ])
          .filter((fileID) => fileID.startsWith("cloud://")),
      ),
    ];
    if (!fileIDs.length) return items;
    const urls: Record<string, string> = {};
    for (let index = 0; index < fileIDs.length; index += 50) {
      const result = await this.callAdmin<ResultEnvelope & { urls?: Record<string, string> }>({
        action: "getCaseImageUrls",
        fileIDs: fileIDs.slice(index, index + 50),
      });
      Object.assign(urls, result.urls || {});
    }
    const safeUrl = (value: string) => {
      if (!value || value.startsWith("cloud://")) return "";
      return value;
    };
    return items.map((item) => ({
      ...item,
      coverImageUrl: safeUrl(
        urls[item.coverThumbnail] || urls[item.coverImage] || item.coverImageUrl,
      ),
      galleryImageUrls: includeGallery
        ? item.galleryImages.map((fileID) => safeUrl(urls[fileID] || fileID))
        : item.galleryImageUrls,
    }));
  }

  async listCases(request: ListCasesRequest): Promise<ListCasesResponse> {
    const result = await this.callAdmin<
      ResultEnvelope & {
        items?: unknown[];
        total?: number;
        page?: number;
        pageSize?: number;
        hasMore?: boolean;
      }
    >({
      action: "listCasesV2",
      page: request.page,
      pageSize: request.pageSize,
      filters: request.filters,
      sort: request.sort || { field: "sortOrder", direction: "asc" },
    });
    const items = await this.hydrate((result.items || []).map(normalizeCaseRecord));
    return {
      items,
      total: Number(result.total ?? items.length),
      page: Number(result.page ?? request.page),
      pageSize: Number(result.pageSize ?? request.pageSize),
      hasMore:
        result.hasMore === true ||
        request.page * request.pageSize < Number(result.total ?? items.length),
    };
  }

  async getCase(id: string): Promise<CaseRecord> {
    const result = await this.callAdmin<ResultEnvelope & { item?: unknown }>({
      action: "getCase",
      id,
    });
    if (!result.item) throw new AdminApiError("CASE_NOT_FOUND", "案例不存在");
    const [item] = await this.hydrate([normalizeCaseRecord(result.item)], true);
    return item;
  }

  async createCase(
    data: Partial<CaseDraft>,
    clientMutationId: string,
    uploadBatchId?: string,
  ): Promise<CreateCaseResult> {
    const result = await this.callAdmin<
      ResultEnvelope & {
        id?: string;
        caseId?: string;
        version?: number;
        duplicate?: boolean;
      }
    >({
      action: "createCase",
      case: toCasePayload(data),
      clientMutationId,
      ...(uploadBatchId ? { uploadBatchId } : {}),
    });
    return {
      id: String(result.id || ""),
      caseId: String(result.caseId || ""),
      version: Number(result.version || 1),
      duplicate: result.duplicate === true,
    };
  }

  async updateCase(
    id: string,
    data: Partial<CaseDraft>,
    expectedVersion: number,
    clientMutationId: string,
    videoPatch?: VideoPatch,
  ): Promise<CaseRecord> {
    const result = await this.callAdmin<ResultEnvelope & { item?: unknown }>({
      action: "updateCase",
      id,
      case: toCasePayload(data),
      expectedVersion,
      clientMutationId,
      ...(videoPatch ? { videoPatch } : {}),
    });
    if (result.item) {
      const [item] = await this.hydrate([normalizeCaseRecord(result.item)], true);
      return item;
    }
    return this.getCase(id);
  }

  async batchPatchCases(request: BatchPatchRequest): Promise<MutationResult> {
    const result = await this.callAdmin<ResultEnvelope & MutationResult>({
      action: "batchPatchCases",
      ...request,
    });
    return {
      updated: Number(result.updated ?? request.ids.length),
    };
  }

  async moveCasesToTrash(
    ids: string[],
    expectedVersions: Record<string, number>,
  ): Promise<MutationResult> {
    const result = await this.callAdmin<ResultEnvelope & MutationResult>({
      action: "moveCasesToTrash",
      ids,
      expectedVersions,
    });
    return { moved: Number(result.moved ?? ids.length) };
  }

  async restoreCases(
    ids: string[],
    expectedVersions: Record<string, number>,
  ): Promise<MutationResult> {
    const result = await this.callAdmin<ResultEnvelope & MutationResult>({
      action: "restoreCases",
      ids,
      expectedVersions,
    });
    return { restored: Number(result.restored ?? ids.length) };
  }

  async permanentlyDeleteCases(
    ids: string[],
    expectedVersions: Record<string, number>,
    clientMutationId: string,
  ): Promise<PermanentDeleteResult> {
    const result = await this.callAdmin<ResultEnvelope & PermanentDeleteResult>({
      action: "permanentlyDeleteCases",
      ids,
      expectedVersions,
      clientMutationId,
    });
    return normalizePermanentDeleteResult(result);
  }

  async retryPurgeCleanup(jobId: string): Promise<PermanentDeleteResult> {
    const result = await this.callAdmin<ResultEnvelope & PermanentDeleteResult>({
      action: "retryPurgeCleanup",
      jobId,
    });
    return normalizePermanentDeleteResult(result);
  }

  async listPendingPurgeJobs(
    request: ListPendingPurgeJobsRequest = {},
  ): Promise<PendingPurgeJob[]> {
    const result = await this.callAdmin<ResultEnvelope & { items?: unknown[] }>({
      action: "listPendingPurgeJobs",
      ...(request.clientMutationId
        ? { clientMutationId: request.clientMutationId }
        : {}),
    });
    return (Array.isArray(result.items) ? result.items : [])
      .map(normalizePendingPurgeJob)
      .filter((job) => Boolean(job.cleanupJobId) && job.pendingFileCount > 0);
  }

  async registerUploadItems(items: RegisterUploadItemInput[]): Promise<void> {
    if (!items.length) return;
    await this.callAdmin({
      action: "registerUploadItems",
      items,
    });
  }

  async updateUploadItemStatus(
    mutationId: string,
    patch: UploadItemStatusPatch,
  ): Promise<void> {
    await this.callAdmin({
      action: "updateUploadItemStatus",
      mutationId,
      patch,
      ...patch,
    });
  }

  async removeUploadItem(mutationId: string): Promise<void> {
    await this.callAdmin({
      action: "removeUploadItem",
      mutationId,
    });
  }

  async listSharedUploadItems(limit = 50): Promise<SharedUploadItem[]> {
    const result = await this.callAdmin<
      ResultEnvelope & { items?: unknown[]; jobs?: unknown[] }
    >({
      action: "listSharedUploadItems",
      limit: Math.min(50, Math.max(1, limit)),
    });
    return (result.items || result.jobs || []).map(normalizeSharedUploadItem);
  }

  async listAdminActivity(limit = 50): Promise<AdminActivityItem[]> {
    const result = await this.callAdmin<
      ResultEnvelope & { items?: unknown[]; activities?: unknown[] }
    >({
      action: "listAdminActivity",
      limit: Math.min(50, Math.max(1, limit)),
    });
    return (result.items || result.activities || []).map(normalizeAdminActivity);
  }

  subscribeAdminActivity(
    viewerUid: string,
    onChange: (items: AdminActivityItem[]) => void,
    onError: (error: unknown) => void,
  ): AdminActivitySubscription {
    return this.getApp()
      .database()
      .collection(
        import.meta.env.VITE_ADMIN_ACTIVITY_COLLECTION?.trim() ||
          "case_admin_activity_feed",
      )
      .where({ viewerUid })
      .orderBy("createdAt", "desc")
      .limit(50)
      .watch({
        onChange: (snapshot) => {
          onChange((snapshot.docs || []).map(normalizeAdminActivity).slice(0, 50));
        },
        onError,
      });
  }

  async reorderCases(
    orderedIds: string[],
    expectedVersions: Record<string, number>,
  ): Promise<void> {
    await this.callAdmin({
      action: "reorderCases",
      ids: orderedIds,
      orderedIds,
      expectedVersions,
    });
  }

  async setHomeSectionOrder(
    orders: HomeSectionOrders,
    expectedVersions: Record<string, number>,
  ): Promise<void> {
    await this.callAdmin({
      action: "setHomeSectionOrder",
      orders,
      expectedVersions,
    });
  }

  async uploadCaseImages(
    files: File[],
    batchId: string,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<UploadedCaseImages> {
    const session = await this.getSession();
    if (!session) throw new AdminApiError("UNAUTHENTICATED", "请先登录");
    const storage = this.getApp().storage.from();
    const sources: string[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const path = buildStoragePath(session.user.id, batchId, file.name, index);
      const { data, error } = await storage.upload(path, file, {
        contentType: file.type,
        upsert: true,
      });
      if (error || !data?.id) {
        throw new AdminApiError(
          error?.code || "UPLOAD_FAILED",
          error?.message || `${file.name} 上传失败`,
        );
      }
      sources.push(data.id);
      onProgress?.({ completed: index + 1, total: files.length, stage: "uploading" });
    }

    onProgress?.({ completed: 0, total: files.length, stage: "processing" });
    const result = await this.call<
      ResultEnvelope & {
        variants?: Array<{
          sourceFileID?: string;
          displayFileID?: string;
          thumbnailFileID?: string;
          bannerFileID?: string;
        }>;
      }
    >(import.meta.env.VITE_IMAGE_PROCESSOR_FUNCTION?.trim() || "imageProcessor", {
      action: "generateCaseVariants",
      files: sources,
    });
    onProgress?.({ completed: files.length, total: files.length, stage: "processing" });
    const variants = (result.variants || []).map((variant) => ({
      sourceFileID: String(variant.sourceFileID || ""),
      displayFileID: String(variant.displayFileID || ""),
      thumbnailFileID: String(variant.thumbnailFileID || ""),
      bannerFileID: String(variant.bannerFileID || ""),
    }));
    if (
      variants.length !== files.length ||
      variants.some(
        (variant) =>
          !variant.sourceFileID ||
          !variant.displayFileID ||
          !variant.thumbnailFileID ||
          !variant.bannerFileID,
      )
    ) {
      throw new AdminApiError("IMAGE_PROCESSING_FAILED", "图片变体生成不完整，请重试");
    }
    return { sources, variants };
  }

  private async uploadPreparedVideoFile(
    caseId: string,
    kind: "video" | "poster",
    file: File,
    onProgress?: (progress: FileUploadProgress) => void,
  ): Promise<string> {
    const prepared = await this.callAdmin<
      ResultEnvelope & { uploadId?: string; cloudPath?: string; expiresAt?: string }
    >({
      action: "prepareVideoUpload",
      id: caseId,
      kind,
      fileName: file.name,
    });
    const cloudPath = String(prepared.cloudPath || "");
    if (!prepared.uploadId || !cloudPath) {
      throw new AdminApiError("INVALID_UPLOAD_TARGET", "服务端未返回有效的视频上传路径");
    }
    onProgress?.({ loadedBytes: 0, totalBytes: file.size, percent: 0 });
    const result = await this.getApp().uploadFile({
      cloudPath,
      filePath: file,
      method: "put",
      onUploadProgress: (event) => {
        const loadedBytes = Math.max(0, Number(event.loaded || 0));
        const totalBytes = Math.max(1, Number(event.total || file.size || 1));
        onProgress?.({
          loadedBytes,
          totalBytes,
          percent: Math.min(99, Math.max(0, Math.round((loadedBytes / totalBytes) * 100))),
        });
      },
    });
    const fileID = String(result.fileID || "");
    if (!fileID) throw new AdminApiError("UPLOAD_FAILED", `${kind === "video" ? "视频" : "封面"}上传失败`);
    onProgress?.({ loadedBytes: file.size, totalBytes: file.size, percent: 100 });
    return fileID;
  }

  async uploadCaseVideo(
    caseId: string,
    file: File,
    metadata: VideoFileMetadata,
    onProgress?: (progress: FileUploadProgress) => void,
  ): Promise<UploadedCaseVideo> {
    const fileID = await this.uploadPreparedVideoFile(caseId, "video", file, onProgress);
    return { fileID, ...metadata };
  }

  async uploadVideoPoster(
    caseId: string,
    file: File,
    onProgress?: (progress: FileUploadProgress) => void,
  ): Promise<UploadedVideoPoster> {
    const fileID = await this.uploadPreparedVideoFile(caseId, "poster", file, onProgress);
    return { fileID, fileSizeBytes: file.size };
  }

  async cleanupUnreferencedFiles(fileIDs: string[]): Promise<CleanupUnreferencedFilesResult> {
    const requestedFileIDs = [...new Set(fileIDs.filter(Boolean))];
    if (!requestedFileIDs.length) {
      return { deletedFileIds: [], skippedFileIds: [], failedFileIds: [] };
    }
    const result = await this.callAdmin<ResultEnvelope & Partial<CleanupUnreferencedFilesResult>>({
      action: "cleanupUnreferencedFiles",
      fileIDs: requestedFileIDs,
    });
    return normalizeCleanupResult(requestedFileIDs, result);
  }
}
