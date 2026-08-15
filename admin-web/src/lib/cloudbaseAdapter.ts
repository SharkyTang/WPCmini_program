import cloudbase from "@cloudbase/js-sdk";
import type {
  AdminApi,
  AdminConfig,
  AuthSession,
  BatchPatchRequest,
  CaseDraft,
  CaseRecord,
  CreateCaseResult,
  HomeSectionOrders,
  ListCasesRequest,
  ListCasesResponse,
  MutationResult,
  UploadedCaseImages,
  UploadProgress,
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
  ): Promise<CaseRecord> {
    const result = await this.callAdmin<ResultEnvelope & { item?: unknown }>({
      action: "updateCase",
      id,
      case: toCasePayload(data),
      expectedVersion,
      clientMutationId,
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

  async cleanupUnreferencedFiles(fileIDs: string[]): Promise<void> {
    if (!fileIDs.length) return;
    await this.callAdmin({
      action: "cleanupUnreferencedFiles",
      fileIDs,
    });
  }
}
