export type HomeSection = "banner" | "popular" | "latest";
export type TagField = "packageTypes" | "styles" | "priceLevel" | "scenes" | "statuses";
export type TagMode = "append" | "remove" | "replace";
export type QueueStatus =
  | "waiting"
  | "uploading"
  | "processing"
  | "creating"
  | "needs_tags"
  | "done"
  | "failed";

export interface HomeSectionOrders {
  banner: string[];
  popular: string[];
  latest: string[];
}

export interface AdminActor {
  type: "wechat_openid" | "cloudbase_uid";
  id: string;
}

export interface CaseRecord {
  _id: string;
  id: string;
  title: string;
  caseId: string;
  coverImage: string;
  coverThumbnail: string;
  coverBanner: string;
  coverImageUrl: string;
  galleryImages: string[];
  sourceGalleryImages: string[];
  galleryThumbnails: string[];
  galleryBanners: string[];
  galleryImageUrls: string[];
  imageVariantVersion: number;
  wineType: string;
  packageTypes: string[];
  styles: string[];
  priceLevel: string;
  scenes: string[];
  statuses: string[];
  homeSections: HomeSection[];
  homeSectionOrder: Partial<Record<HomeSection, number>>;
  sortOrder: number;
  notes: string;
  isVisible: boolean;
  isPinned: boolean;
  version: number;
  deletedAt: string | null;
  deletedBy?: AdminActor | null;
  createdAt: string;
  updatedAt: string;
  clientMutationId?: string;
}

export type CaseDraft = Omit<
  CaseRecord,
  | "_id"
  | "id"
  | "coverImageUrl"
  | "galleryImageUrls"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
  | "version"
> & {
  version?: number;
};

export interface AdminConfig {
  options: {
    wineTypes: string[];
    packageTypes: string[];
    styles: string[];
    priceLevels: string[];
    scenes: string[];
    statuses: string[];
  };
  limits: {
    gallery: number;
    batch: number;
    uploadBytes: number;
    homepage: Record<HomeSection, number>;
  };
  writeEnabled: boolean;
  permanentDeleteEnabled: boolean;
  activitySyncEnabled: boolean;
  homeSectionOrders: HomeSectionOrders;
}

export interface CaseFilters {
  keyword: string;
  packageTypes: string[];
  styles: string[];
  priceLevel: string[];
  scenes: string[];
  statuses: string[];
  homeSections: HomeSection[];
  visibility: "all" | "visible" | "hidden";
  isPinned: "all" | "pinned" | "unpinned";
  trash: boolean;
}

export interface ListCasesRequest {
  page: number;
  pageSize: number;
  filters: CaseFilters;
  sort?: {
    field: "sortOrder" | "updatedAt" | "createdAt";
    direction: "asc" | "desc";
  };
}

export interface ListCasesResponse {
  items: CaseRecord[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface BatchPatchRequest {
  ids: string[];
  patch?: Partial<
    Pick<
      CaseRecord,
      "isVisible" | "isPinned" | "packageTypes" | "styles" | "priceLevel" | "scenes" | "statuses"
    >
  >;
  tags?: Partial<Record<TagField, string[]>>;
  tagMode?: TagMode;
  expectedVersions?: Record<string, number>;
}

export interface ImageVariant {
  sourceFileID: string;
  displayFileID: string;
  thumbnailFileID: string;
  bannerFileID: string;
}

export interface UploadedCaseImages {
  sources: string[];
  variants: ImageVariant[];
}

export interface UploadProgress {
  completed: number;
  total: number;
  stage: "uploading" | "processing";
}

export interface AdminUser {
  id: string;
  label: string;
  email?: string;
}

export interface AuthSession {
  user: AdminUser;
}

export interface CreateCaseResult {
  id: string;
  caseId: string;
  version: number;
  duplicate?: boolean;
}

export interface MutationResult {
  updated?: number;
  restored?: number;
  moved?: number;
}

export interface PermanentDeleteResult {
  deleted: number;
  cleanupJobId: string;
  deletedFileCount: number;
  retainedReferencedCount: number;
  pendingFileCount: number;
}

export interface PendingPurgeJob extends PermanentDeleteResult {
  clientMutationId: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ListPendingPurgeJobsRequest {
  clientMutationId?: string;
}

export interface RegisterUploadItemInput {
  mutationId: string;
  uploadBatchId: string;
  title: string;
  imageCount: number;
  packageTypes: string[];
  scenes: string[];
  status: QueueStatus;
}

export interface UploadItemStatusPatch {
  status: QueueStatus;
  title?: string;
  imageCount?: number;
  packageTypes?: string[];
  scenes?: string[];
  caseId?: string;
  error?: string;
}

export interface SharedUploadItem extends RegisterUploadItemInput {
  id: string;
  ownerUid: string;
  ownerLabel: string;
  updatedAt: string;
}

export type AdminActivityAction =
  | "upload_queued"
  | "upload_started"
  | "upload_processing"
  | "case_creating"
  | "upload_completed"
  | "case_created"
  | "upload_failed"
  | "upload_removed"
  | "case_moved_to_trash"
  | "case_restored"
  | "case_permanently_deleted";

export interface AdminActivityItem {
  id: string;
  actorId: string;
  actorLabel: string;
  action: AdminActivityAction;
  title: string;
  caseId?: string;
  mutationId?: string;
  uploadBatchId?: string;
  imageCount?: number;
  status?: QueueStatus;
  createdAt: string;
}

export interface AdminActivitySubscription {
  close(): void;
}

export interface AdminApi {
  readonly mode: "mock" | "cloudbase";
  readonly configured: boolean;
  getSession(): Promise<AuthSession | null>;
  signIn(account: string, password: string): Promise<AuthSession>;
  signOut(): Promise<void>;
  checkAccess(): Promise<void>;
  getAdminConfig(): Promise<AdminConfig>;
  listCases(request: ListCasesRequest): Promise<ListCasesResponse>;
  getCase(id: string): Promise<CaseRecord>;
  createCase(
    data: Partial<CaseDraft>,
    clientMutationId: string,
    uploadBatchId?: string,
  ): Promise<CreateCaseResult>;
  updateCase(
    id: string,
    data: Partial<CaseDraft>,
    expectedVersion: number,
    clientMutationId: string,
  ): Promise<CaseRecord>;
  batchPatchCases(request: BatchPatchRequest): Promise<MutationResult>;
  moveCasesToTrash(ids: string[], expectedVersions: Record<string, number>): Promise<MutationResult>;
  restoreCases(ids: string[], expectedVersions: Record<string, number>): Promise<MutationResult>;
  permanentlyDeleteCases?(
    ids: string[],
    expectedVersions: Record<string, number>,
    clientMutationId: string,
  ): Promise<PermanentDeleteResult>;
  retryPurgeCleanup?(jobId: string): Promise<PermanentDeleteResult>;
  listPendingPurgeJobs?(
    request?: ListPendingPurgeJobsRequest,
  ): Promise<PendingPurgeJob[]>;
  reorderCases(orderedIds: string[], expectedVersions: Record<string, number>): Promise<void>;
  setHomeSectionOrder(
    orders: HomeSectionOrders,
    expectedVersions: Record<string, number>,
  ): Promise<void>;
  uploadCaseImages(
    files: File[],
    batchId: string,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<UploadedCaseImages>;
  cleanupUnreferencedFiles(fileIDs: string[]): Promise<void>;
  registerUploadItems?(items: RegisterUploadItemInput[]): Promise<void>;
  updateUploadItemStatus?(
    mutationId: string,
    patch: UploadItemStatusPatch,
  ): Promise<void>;
  removeUploadItem?(mutationId: string): Promise<void>;
  listSharedUploadItems?(limit?: number): Promise<SharedUploadItem[]>;
  listAdminActivity?(limit?: number): Promise<AdminActivityItem[]>;
  subscribeAdminActivity?(
    viewerUid: string,
    onChange: (items: AdminActivityItem[]) => void,
    onError: (error: unknown) => void,
  ): AdminActivitySubscription;
}

export interface UploadQueueItem {
  id: string;
  mutationId: string;
  uploadBatchId: string;
  files: File[];
  previews: string[];
  title: string;
  packageTypes: string[];
  scenes: string[];
  status: QueueStatus;
  progress: number;
  error: string;
  createdId?: string;
  createdCaseId?: string;
}
