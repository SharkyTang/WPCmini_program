import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  FileImageOutlined,
  InboxOutlined,
  LinkOutlined,
  LoadingOutlined,
  MergeCellsOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  message,
  Progress,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useNavigate } from "react-router-dom";
import { QUEUE_STATUS_META } from "../constants";
import { useAdminConfig } from "../context/AdminConfigContext";
import { useAuth } from "../context/AuthContext";
import { adminApi } from "../lib/api";
import { isSupportedImage } from "../lib/caseLogic";
import { getErrorMessage } from "../lib/errors";
import { getSceneOptions } from "../lib/sceneOptions";
import {
  createLatestAsyncSaver,
  type LatestAsyncSaver,
} from "../lib/latestAsyncSaver";
import {
  loadPersistedUploadQueue,
  revokeQueuePreviews,
  savePersistedUploadQueue,
} from "../lib/uploadQueueStore";
import type {
  AdminActivityAction,
  AdminActivityItem,
  CaseDraft,
  QueueStatus,
  RegisterUploadItemInput,
  SharedUploadItem,
  UploadedCaseImages,
  UploadItemStatusPatch,
  UploadQueueItem,
} from "../types";
import { PageLoading, WriteDisabledAlert } from "../components/PageStates";

const LEGACY_QUEUE_STORE_KEY = "wine-admin-upload-queue-v2";
const TITLE_DRAFT_STORE_KEY = "wine-admin-upload-title-drafts-v1";
const CONCURRENCY = 3;
const SYNC_POLL_INTERVAL_MS = 5_000;
let uploadPageSessionGeneration = 0;

export interface UploadPageSessionGuard {
  readonly uid: string;
  readonly generation: number;
  isActive: () => boolean;
  activate: () => void;
  deactivate: () => void;
}

export function createUploadPageSessionGuard(uid: string): UploadPageSessionGuard {
  let active = true;
  const generation = ++uploadPageSessionGeneration;
  return {
    uid,
    generation,
    isActive: () => active,
    activate: () => {
      active = true;
    },
    deactivate: () => {
      active = false;
    },
  };
}

export class UploadPageSessionInactiveError extends Error {
  constructor() {
    super("管理员账号已切换，旧上传任务同步已停止");
    this.name = "UploadPageSessionInactiveError";
  }
}

function assertUploadPageSessionActive(isActive: () => boolean): void {
  if (!isActive()) throw new UploadPageSessionInactiveError();
}

export function uploadTitleDraftStoreKey(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) throw new Error("缺少当前管理员 UID，无法读取标题草稿");
  return `${TITLE_DRAFT_STORE_KEY}:${encodeURIComponent(normalized)}`;
}

function readTitleDrafts(userId: string): Map<string, string> {
  try {
    const scopedKey = uploadTitleDraftStoreKey(userId);
    let raw = localStorage.getItem(scopedKey);
    const legacyRaw = localStorage.getItem(TITLE_DRAFT_STORE_KEY);
    if (!raw && legacyRaw) {
      raw = legacyRaw;
      localStorage.setItem(scopedKey, legacyRaw);
    }
    if (legacyRaw) localStorage.removeItem(TITLE_DRAFT_STORE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return new Map();
  }
}

function writeTitleDrafts(userId: string, drafts: Map<string, string>): void {
  try {
    const key = uploadTitleDraftStoreKey(userId);
    if (!drafts.size) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(
      key,
      JSON.stringify(Object.fromEntries(drafts)),
    );
  } catch {
    // IndexedDB remains the primary queue persistence if storage is unavailable.
  }
}

function applyTitleDrafts(
  items: UploadQueueItem[],
  drafts: Map<string, string>,
): UploadQueueItem[] {
  let changed = false;
  const next = items.map((item) => {
    const title = drafts.get(item.id);
    if (title === undefined || title === item.title) return item;
    changed = true;
    return { ...item, title };
  });
  return changed ? next : items;
}

function clearMatchingTitleDrafts(
  items: UploadQueueItem[],
  drafts: Map<string, string>,
  userId: string,
): void {
  let changed = false;
  items.forEach((item) => {
    if (drafts.get(item.id) === item.title) {
      drafts.delete(item.id);
      changed = true;
    }
  });
  if (changed) writeTitleDrafts(userId, drafts);
}

function fileTitle(fileName: string): string {
  return fileName.replace(/\.(jpe?g|png|webp)$/i, "").trim() || "未命名案例";
}

function makeQueueItem(
  files: File[],
  packageTypes: string[] = [],
  scenes: string[] = [],
  uploadBatchId = `batch-${crypto.randomUUID()}`,
): UploadQueueItem {
  return {
    id: crypto.randomUUID(),
    mutationId: crypto.randomUUID(),
    uploadBatchId,
    files,
    previews: files.map((file) => URL.createObjectURL(file)),
    title: fileTitle(files[0]?.name || ""),
    packageTypes,
    scenes,
    status: "waiting",
    progress: 0,
    error: "",
  };
}

function toUploadRegistration(item: UploadQueueItem): RegisterUploadItemInput {
  return {
    mutationId: item.mutationId,
    uploadBatchId: item.uploadBatchId,
    title: item.title.trim() || "未命名案例",
    imageCount: item.files.length || item.previews.length,
    packageTypes: item.packageTypes,
    scenes: item.scenes,
    status: item.status,
  };
}

export async function ensureUploadItemRegistered(
  register: (items: RegisterUploadItemInput[]) => Promise<unknown>,
  item: UploadQueueItem,
  registeredMutationIds: Set<string>,
  isActive: () => boolean = () => true,
): Promise<void> {
  assertUploadPageSessionActive(isActive);
  if (registeredMutationIds.has(item.mutationId)) return;
  // Registration is the queue event. A restored/failed local item may already
  // be in a later stage, so always create the remote job at the baseline and
  // let the separately acknowledged status update advance it exactly once.
  await register([{ ...toUploadRegistration(item), status: "waiting" }]);
  assertUploadPageSessionActive(isActive);
  registeredMutationIds.add(item.mutationId);
}

export async function reportRegisteredUploadItemStatus(
  register: (items: RegisterUploadItemInput[]) => Promise<unknown>,
  update: (mutationId: string, patch: UploadItemStatusPatch) => Promise<unknown>,
  item: UploadQueueItem,
  patch: UploadItemStatusPatch,
  registeredMutationIds: Set<string>,
  isActive: () => boolean = () => true,
): Promise<void> {
  assertUploadPageSessionActive(isActive);
  await ensureUploadItemRegistered(register, item, registeredMutationIds, isActive);
  assertUploadPageSessionActive(isActive);
  await update(item.mutationId, patch);
  assertUploadPageSessionActive(isActive);
}

export async function removeRegisteredUploadItem(
  register: (items: RegisterUploadItemInput[]) => Promise<unknown>,
  remove: (mutationId: string) => Promise<unknown>,
  item: UploadQueueItem,
  registeredMutationIds: Set<string>,
  isActive: () => boolean = () => true,
): Promise<void> {
  assertUploadPageSessionActive(isActive);
  await ensureUploadItemRegistered(register, item, registeredMutationIds, isActive);
  assertUploadPageSessionActive(isActive);
  await remove(item.mutationId);
  assertUploadPageSessionActive(isActive);
}

export function createLatestRequestGuard() {
  let issuedSequence = 0;
  let appliedSequence = 0;
  return {
    issue(): number {
      issuedSequence += 1;
      return issuedSequence;
    },
    canApply(sequence: number): boolean {
      if (sequence < appliedSequence) return false;
      appliedSequence = sequence;
      return true;
    },
  };
}

export function createUploadRegistrationReconciler({
  getItems,
  register,
  registeredMutationIds,
  registeringMutationIds,
  batchSize = 50,
  intervalMs = SYNC_POLL_INTERVAL_MS,
  isActive = () => true,
  onError,
  onSuccess,
}: {
  getItems: () => UploadQueueItem[];
  register: (items: RegisterUploadItemInput[]) => Promise<unknown>;
  registeredMutationIds: Set<string>;
  registeringMutationIds: Set<string>;
  batchSize?: number;
  intervalMs?: number;
  isActive?: () => boolean;
  onError?: (reason: unknown) => void;
  onSuccess?: () => void;
}) {
  let stopped = false;
  let running = false;
  const ownedRegisteringMutationIds = new Set<string>();

  const reconcileNow = async () => {
    if (stopped || running || !isActive()) return;
    const candidates = getItems().filter(
      (item) =>
        item.status === "waiting" &&
        !registeredMutationIds.has(item.mutationId) &&
        !registeringMutationIds.has(item.mutationId),
    );
    if (!candidates.length) return;

    running = true;
    let completedAny = false;
    try {
      const safeBatchSize = Math.max(1, Math.min(50, batchSize));
      for (
        let index = 0;
        index < candidates.length && !stopped && isActive();
        index += safeBatchSize
      ) {
        const chunk = candidates.slice(index, index + safeBatchSize);
        chunk.forEach((item) => {
          registeringMutationIds.add(item.mutationId);
          ownedRegisteringMutationIds.add(item.mutationId);
        });
        try {
          assertUploadPageSessionActive(isActive);
          await register(chunk.map(toUploadRegistration));
          if (!stopped && isActive()) {
            chunk.forEach((item) => registeredMutationIds.add(item.mutationId));
            completedAny = true;
          }
        } catch (reason) {
          if (!stopped && isActive()) onError?.(reason);
        } finally {
          if (!stopped && isActive()) {
            chunk.forEach((item) => {
              registeringMutationIds.delete(item.mutationId);
              ownedRegisteringMutationIds.delete(item.mutationId);
            });
          }
        }
      }
      if (!stopped && isActive() && completedAny) onSuccess?.();
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void reconcileNow();
  }, intervalMs);

  return {
    reconcileNow,
    stop() {
      stopped = true;
      clearInterval(timer);
      ownedRegisteringMutationIds.forEach((mutationId) => {
        registeringMutationIds.delete(mutationId);
      });
      ownedRegisteringMutationIds.clear();
    },
  };
}

export interface PendingUploadStatusSync {
  item: UploadQueueItem;
  patch: UploadItemStatusPatch;
  attemptId: number;
}

export function createUploadStatusReconciler({
  getPending,
  replay,
  acknowledge,
  intervalMs = SYNC_POLL_INTERVAL_MS,
  isActive = () => true,
  onError,
  onSuccess,
}: {
  getPending: () => PendingUploadStatusSync[];
  replay: (entry: PendingUploadStatusSync) => Promise<void>;
  acknowledge: (entry: PendingUploadStatusSync) => void;
  intervalMs?: number;
  isActive?: () => boolean;
  onError?: (reason: unknown) => void;
  onSuccess?: () => void;
}) {
  let stopped = false;
  const inFlightMutationIds = new Set<string>();

  const reconcileNow = async () => {
    if (stopped || !isActive()) return;
    const candidates = getPending().filter(
      (entry) => !inFlightMutationIds.has(entry.item.mutationId),
    );
    await Promise.all(candidates.map(async (entry) => {
      const mutationId = entry.item.mutationId;
      inFlightMutationIds.add(mutationId);
      try {
        assertUploadPageSessionActive(isActive);
        await replay(entry);
        if (stopped || !isActive()) return;
        acknowledge(entry);
        onSuccess?.();
      } catch (reason) {
        if (!stopped && isActive()) onError?.(reason);
      } finally {
        inFlightMutationIds.delete(mutationId);
      }
    }));
  };

  const timer = setInterval(() => {
    void reconcileNow();
  }, intervalMs);

  return {
    reconcileNow,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function buildUploadedCaseDraft(
  source: UploadQueueItem,
  uploaded: UploadedCaseImages,
): Partial<CaseDraft> {
  return {
    title: source.title.trim() || "未命名案例",
    wineType: "白酒",
    packageTypes: source.packageTypes,
    styles: [],
    priceLevel: "",
    scenes: source.scenes,
    statuses: [],
    homeSections: [],
    notes: "",
    isVisible: false,
    isPinned: false,
    sourceGalleryImages: uploaded.sources,
    galleryImages: uploaded.variants.map((variant) => variant.displayFileID),
    galleryThumbnails: uploaded.variants.map((variant) => variant.thumbnailFileID),
    galleryBanners: uploaded.variants.map((variant) => variant.bannerFileID),
    coverImage: uploaded.variants[0].displayFileID,
    coverThumbnail: uploaded.variants[0].thumbnailFileID,
    coverBanner: uploaded.variants[0].bannerFileID,
    imageVariantVersion: 2,
  };
}

interface QueueItemRowProps {
  item: UploadQueueItem;
  packageOptions: Array<{ value: string; label: string }>;
  sceneOptions: Array<{ value: string; label: string }>;
  running: boolean;
  selected: boolean;
  onOpenCreated: (id: string) => void;
  onDraftTitleChange: (id: string, title: string) => void;
  onPatch: (id: string, patch: Partial<UploadQueueItem>) => void;
  onRemove: (id: string) => void;
  onRetry: (item: UploadQueueItem) => void;
  onToggleSelected: (id: string, checked: boolean) => void;
}

export const QueueItemRow = memo(function QueueItemRow({
  item,
  packageOptions,
  sceneOptions,
  running,
  selected,
  onOpenCreated,
  onDraftTitleChange,
  onPatch,
  onRemove,
  onRetry,
  onToggleSelected,
}: QueueItemRowProps) {
  const [draftTitle, setDraftTitle] = useState(item.title);

  useEffect(() => {
    setDraftTitle(item.title);
  }, [item.title]);

  const meta = QUEUE_STATUS_META[item.status];
  const processing = ["uploading", "processing", "creating"].includes(item.status);
  const editable = ["waiting", "failed"].includes(item.status) && !running;

  return (
    <div className="queue-item">
      <Checkbox
        checked={selected}
        disabled={item.status !== "waiting" || running}
        onChange={(event) => onToggleSelected(item.id, event.target.checked)}
      />
      <div className="queue-preview-stack">
        {item.previews.slice(0, 3).map((preview, index) => (
          <img
            key={`${preview}-${index}`}
            src={preview}
            alt={`${draftTitle} ${index + 1}`}
            width={54}
            height={64}
            loading="lazy"
            decoding="async"
            style={{ zIndex: 3 - index }}
          />
        ))}
        {item.previews.length > 1 ? <span>{item.previews.length} 图</span> : null}
      </div>
      <div className="queue-item-main">
        <Input
          variant="borderless"
          className="queue-title-input"
          value={draftTitle}
          disabled={!editable}
          onChange={(event) => {
            const title = event.target.value;
            setDraftTitle(title);
            onDraftTitleChange(item.id, title);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraftTitle(item.title);
              onDraftTitleChange(item.id, item.title);
            }
          }}
          prefix={<EditOutlined />}
        />
        <Space size={6} wrap>
          <Tag color={meta.color}>
            {processing ? <LoadingOutlined /> : null} {meta.label}
          </Tag>
          <span className="secondary-text">
            {item.files.length || item.previews.length} 张图片
          </span>
          {item.createdCaseId ? <Tag>{item.createdCaseId}</Tag> : null}
        </Space>
        {processing || item.progress ? (
          <Progress
            percent={item.progress}
            size="small"
            status={item.status === "failed" ? "exception" : undefined}
            showInfo={processing}
          />
        ) : null}
        {item.error ? <span className="queue-error">{item.error}</span> : null}
      </div>
      <div className="queue-label-fields">
        <div className="queue-label-field">
          <Select
            mode="multiple"
            maxTagCount={1}
            placeholder="包装标签"
            value={item.packageTypes}
            disabled={!editable}
            options={packageOptions}
            onChange={(values) => onPatch(item.id, { packageTypes: values })}
          />
        </div>
        <div className="queue-label-field">
          <Select
            mode="multiple"
            maxTagCount={1}
            placeholder="使用场景"
            value={item.scenes}
            disabled={!editable}
            options={sceneOptions}
            onChange={(values) => onPatch(item.id, { scenes: values })}
          />
        </div>
      </div>
      <Space size={4} className="queue-actions">
        {item.status === "failed" && item.files.length ? (
          <Button
            icon={<RedoOutlined />}
            disabled={running}
            onClick={() => onRetry(item)}
          >
            重试
          </Button>
        ) : null}
        {item.createdId ? (
          <Button
            icon={<LinkOutlined />}
            onClick={() => onOpenCreated(item.createdId || "")}
          >
            {item.status === "needs_tags" ? "补标签" : "查看"}
          </Button>
        ) : null}
        {!processing ? (
          <Button
            type="text"
            danger
            icon={<CloseOutlined />}
            aria-label="移除队列项"
            disabled={running}
            onClick={() => onRemove(item.id)}
          />
        ) : null}
      </Space>
    </div>
  );
});

const ACTIVITY_ACTION_LABELS: Record<AdminActivityAction, string> = {
  upload_queued: "加入上传队列",
  upload_started: "开始上传",
  upload_processing: "正在处理图片",
  case_creating: "正在创建案例",
  upload_completed: "上传任务完成",
  case_created: "完成建档",
  upload_failed: "上传失败",
  upload_removed: "移出上传队列",
  case_moved_to_trash: "移入回收站",
  case_restored: "恢复案例",
  case_permanently_deleted: "永久删除案例",
};

const ACTIVE_REMOTE_STATUSES: QueueStatus[] = [
  "waiting",
  "uploading",
  "processing",
  "creating",
];

function activityTime(value: string): string {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function AdminActivityPanel({
  activities,
  sharedJobs,
  currentUid,
  loading,
}: {
  activities: AdminActivityItem[];
  sharedJobs: SharedUploadItem[];
  currentUid: string;
  loading: boolean;
}) {
  const remoteJobs = sharedJobs
    .filter(
      (item) =>
        item.ownerUid !== currentUid && ACTIVE_REMOTE_STATUSES.includes(item.status),
    )
    .slice(0, 10);

  return (
    <Card className="admin-activity-card">
      <div className="admin-activity-header">
        <div>
          <Typography.Title level={4}>管理员实时动态</Typography.Title>
          <Typography.Text className="secondary-text">
            仅同步任务阶段和操作记录，不同步原图或本机文件。
          </Typography.Text>
        </div>
        <Tag icon={<SyncOutlined spin={loading} />} color="green">
          {loading ? "同步中" : "实时同步"}
        </Tag>
      </div>

      {remoteJobs.length ? (
        <div className="admin-activity-list" aria-label="其他管理员进行中的任务">
          {remoteJobs.map((item) => {
            const meta = QUEUE_STATUS_META[item.status];
            return (
              <div className="admin-activity-item" key={`job-${item.id || item.mutationId}`}>
                <div className="admin-activity-main">
                  <strong>{item.ownerLabel}</strong>
                  <span>{item.title}</span>
                  <Tag color={meta.color}>{meta.label}</Tag>
                </div>
                <div className="admin-activity-meta">
                  <span>{item.imageCount} 张图片</span>
                  <span>只读，需由发起电脑继续</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {activities.length ? (
        <div className="admin-activity-list" aria-live="polite">
          {activities.slice(0, 50).map((item) => (
            <div className="admin-activity-item" key={item.id}>
              <div className="admin-activity-main">
                <strong>{item.actorLabel}</strong>
                <span>{ACTIVITY_ACTION_LABELS[item.action] || item.action}</span>
                <span>{item.title}</span>
                {item.caseId ? <Tag>{item.caseId}</Tag> : null}
              </div>
              <div className="admin-activity-meta">
                <ClockCircleOutlined />
                <span>{activityTime(item.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
      ) : !remoteJobs.length ? (
        <div className="admin-activity-empty">暂时还没有管理员操作动态</div>
      ) : null}
    </Card>
  );
}

export function UploadPage() {
  const { session } = useAuth();
  if (!session?.user.id) return <PageLoading rows={5} />;
  // The key forces all local queue refs, pending savers and realtime listeners
  // to be torn down before another authenticated UID can reuse this route.
  return <UploadPageForUser key={session.user.id} sessionUid={session.user.id} />;
}

function UploadPageForUser({ sessionUid }: { sessionUid: string }) {
  const { config, loading: configLoading } = useAdminConfig();
  const navigate = useNavigate();
  const sessionGuardRef = useRef<UploadPageSessionGuard | null>(null);
  if (!sessionGuardRef.current || sessionGuardRef.current.uid !== sessionUid) {
    sessionGuardRef.current?.deactivate();
    sessionGuardRef.current = createUploadPageSessionGuard(sessionUid);
  }
  const sessionGuard = sessionGuardRef.current;
  const isSessionActive = useCallback(
    () => sessionGuard.isActive(),
    [sessionGuard],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [queueHydrated, setQueueHydrated] = useState(false);
  const [persistenceError, setPersistenceError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [defaultPackages, setDefaultPackages] = useState<string[]>([]);
  const [defaultScenes, setDefaultScenes] = useState<string[]>([]);
  const [activities, setActivities] = useState<AdminActivityItem[]>([]);
  const [sharedJobs, setSharedJobs] = useState<SharedUploadItem[]>([]);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [running, setRunning] = useState(false);
  const [addingFiles, setAddingFiles] = useState(false);
  const [dragging, setDragging] = useState(false);
  const mountedRef = useRef(true);
  const addingFilesRef = useRef(false);
  const queueLoadedRef = useRef(false);
  const persistenceFailedRef = useRef(false);
  const queueRef = useRef<UploadQueueItem[]>([]);
  const syncChainsRef = useRef<Map<string, Promise<void>>>(new Map());
  const syncRegisteredRef = useRef<Set<string>>(new Set());
  const syncRegisteringRef = useRef<Set<string>>(new Set());
  const syncAcknowledgedStatusRef = useRef<Map<string, QueueStatus>>(new Map());
  const syncPendingStatusRef = useRef<Map<string, PendingUploadStatusSync>>(new Map());
  const syncStatusAttemptSequenceRef = useRef(0);
  const syncStatusReconcilerRef = useRef<ReturnType<
    typeof createUploadStatusReconciler
  > | null>(null);
  const alreadyPersistedQueueRef = useRef<UploadQueueItem[] | null>(null);
  const titleDraftsRef = useRef<Map<string, string> | null>(null);
  if (!titleDraftsRef.current) titleDraftsRef.current = readTitleDrafts(sessionUid);
  const queueSaverRef = useRef<LatestAsyncSaver<UploadQueueItem[]> | null>(null);
  if (!queueSaverRef.current) {
    queueSaverRef.current = createLatestAsyncSaver(
      async (items) => {
        await savePersistedUploadQueue(items, sessionUid);
        persistenceFailedRef.current = false;
        const drafts = titleDraftsRef.current;
        if (!drafts) return;
        clearMatchingTitleDrafts(items, drafts, sessionUid);
      },
      {
        debounceMs: 500,
        onError: (reason) => {
          persistenceFailedRef.current = true;
          if (!mountedRef.current) return;
          setPersistenceError(
            getErrorMessage(reason, "上传队列无法持久保存，刷新前请先处理完"),
          );
        },
      },
    );
  }
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const packageOptions = useMemo(
    () => config.options.packageTypes.map((value) => ({ value, label: value })),
    [config.options.packageTypes],
  );
  const sceneOptions = useMemo(
    () => getSceneOptions(config.options.scenes),
    [config.options.scenes],
  );
  const navigationBlocker = useBlocker(running || addingFiles);

  useEffect(() => {
    // React StrictMode intentionally performs setup -> cleanup -> setup once
    // during development. Reactivate this component instance's guard on every
    // setup, while the keyed UID boundary guarantees another account receives
    // a different guard that cannot revive this one.
    sessionGuard.activate();
    return () => {
      sessionGuard.deactivate();
    };
  }, [sessionGuard]);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    queueLoadedRef.current = false;
    void loadPersistedUploadQueue(sessionUid)
      .then((items) => {
        if (cancelled) {
          revokeQueuePreviews(items);
          return;
        }
        const restored = applyTitleDrafts(
          items,
          titleDraftsRef.current || new Map(),
        );
        localStorage.removeItem(LEGACY_QUEUE_STORE_KEY);
        queueLoadedRef.current = true;
        if (restored === items) alreadyPersistedQueueRef.current = restored;
        queueRef.current = restored;
        setQueue(restored);
        setQueueHydrated(true);
      })
      .catch((reason) => {
        if (cancelled) return;
        queueLoadedRef.current = false;
        setPersistenceError(
          getErrorMessage(reason, "上传队列无法持久保存，刷新前请先处理完"),
        );
        setQueueHydrated(true);
      });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (queueLoadedRef.current) {
        if (!addingFilesRef.current) {
          const latest = applyTitleDrafts(
            queueRef.current,
            titleDraftsRef.current || new Map(),
          );
          queueSaverRef.current?.schedule(latest);
        }
        void queueSaverRef.current?.flush();
      }
      revokeQueuePreviews(queueRef.current);
    };
  }, [sessionUid]);

  useEffect(() => {
    queueRef.current = queue;
    if (!queueHydrated || !queueLoadedRef.current) return;
    if (alreadyPersistedQueueRef.current === queue) {
      alreadyPersistedQueueRef.current = null;
      return;
    }
    queueSaverRef.current?.schedule(queue);
  }, [queue, queueHydrated]);

  useEffect(() => {
    const flushWhenHidden = () => {
      if (
        document.visibilityState === "hidden" &&
        queueLoadedRef.current
      ) {
        if (!addingFilesRef.current) {
          queueSaverRef.current?.schedule(
            applyTitleDrafts(
              queueRef.current,
              titleDraftsRef.current || new Map(),
            ),
          );
        }
        void queueSaverRef.current?.flush();
      }
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => document.removeEventListener("visibilitychange", flushWhenHidden);
  }, []);

  useEffect(() => {
    if (navigationBlocker.state !== "blocked") return;
    message.warning("图片正在保存或上传，请等待本批处理完成后再离开");
    navigationBlocker.reset();
  }, [navigationBlocker]);

  useEffect(() => {
    const hasActive = queue.some((item) =>
      ["uploading", "processing", "creating"].includes(item.status),
    );
    const warn = (event: BeforeUnloadEvent) => {
      if (!hasActive && !addingFiles) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [addingFiles, queue]);

  const updateQueue = useCallback(
    (updater: (current: UploadQueueItem[]) => UploadQueueItem[]) => {
      setQueue((current) => {
        const next = updater(current);
        queueRef.current = next;
        return next;
      });
    },
    [],
  );

  const updateItem = useCallback((id: string, patch: Partial<UploadQueueItem>) => {
    updateQueue((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, [updateQueue]);

  const updateDraftTitle = useCallback((id: string, title: string) => {
    const drafts = titleDraftsRef.current;
    if (!drafts || drafts.get(id) === title) return;
    drafts.set(id, title);
    writeTitleDrafts(sessionUid, drafts);
  }, [sessionUid]);

  const toggleSelected = useCallback((id: string, checked: boolean) => {
    setSelectedIds((current) => {
      if (checked) return current.includes(id) ? current : [...current, id];
      return current.filter((candidate) => candidate !== id);
    });
  }, []);

  const trackSyncChain = useCallback((mutationId: string, promise: Promise<void>) => {
    const tracked = promise.finally(() => {
      if (!isSessionActive()) return;
      if (syncChainsRef.current.get(mutationId) === tracked) {
        syncChainsRef.current.delete(mutationId);
      }
    });
    if (isSessionActive()) syncChainsRef.current.set(mutationId, tracked);
    return tracked;
  }, [isSessionActive]);

  const registerForSync = useCallback((items: UploadQueueItem[]) => {
    if (
      !isSessionActive() ||
      !config.activitySyncEnabled ||
      !items.length ||
      !adminApi.registerUploadItems
    ) return;
    const candidates = items.filter(
      (item) =>
        !syncRegisteredRef.current.has(item.mutationId) &&
        !syncRegisteringRef.current.has(item.mutationId),
    );
    const batchSize = Math.max(1, Math.min(50, config.limits.batch));
    for (let index = 0; index < candidates.length; index += batchSize) {
      const chunk = candidates.slice(index, index + batchSize);
      chunk.forEach((item) => syncRegisteringRef.current.add(item.mutationId));
      const registration = Promise.resolve()
        .then(() => {
          assertUploadPageSessionActive(isSessionActive);
          return adminApi.registerUploadItems!(chunk.map(toUploadRegistration));
        })
        .then(() => {
          assertUploadPageSessionActive(isSessionActive);
          chunk.forEach((item) => {
            syncRegisteredRef.current.add(item.mutationId);
            if (item.status === "waiting") {
              syncAcknowledgedStatusRef.current.set(item.mutationId, "waiting");
            }
          });
          setSyncError("");
        })
        .catch((reason) => {
          if (isSessionActive() && mountedRef.current) {
            setSyncError(getErrorMessage(reason, "管理员动态暂时无法同步"));
          }
        })
        .finally(() => {
          if (isSessionActive()) {
            chunk.forEach((item) => syncRegisteringRef.current.delete(item.mutationId));
          }
        });
      chunk.forEach((item) => {
        void trackSyncChain(item.mutationId, registration);
      });
    }
  }, [
    config.activitySyncEnabled,
    config.limits.batch,
    isSessionActive,
    trackSyncChain,
  ]);

  useEffect(() => {
    if (
      !config.activitySyncEnabled ||
      !queueHydrated ||
      !adminApi.registerUploadItems
    ) return;
    const reconciler = createUploadRegistrationReconciler({
      getItems: () => queueRef.current,
      register: (items) => {
        assertUploadPageSessionActive(isSessionActive);
        return adminApi.registerUploadItems!(items);
      },
      registeredMutationIds: syncRegisteredRef.current,
      registeringMutationIds: syncRegisteringRef.current,
      batchSize: config.limits.batch,
      isActive: isSessionActive,
      onError: (reason) => {
        if (isSessionActive() && mountedRef.current) {
          setSyncError(getErrorMessage(reason, "管理员动态暂时无法同步"));
        }
      },
      onSuccess: () => {
        if (isSessionActive() && mountedRef.current) setSyncError("");
      },
    });
    return () => reconciler.stop();
  }, [
    config.activitySyncEnabled,
    config.limits.batch,
    isSessionActive,
    queueHydrated,
    sessionUid,
  ]);

  const performStatusSync = useCallback((entry: PendingUploadStatusSync) => {
    if (!isSessionActive()) {
      return Promise.reject(new UploadPageSessionInactiveError());
    }
    if (!adminApi.registerUploadItems || !adminApi.updateUploadItemStatus) {
      return Promise.reject(new Error("当前后台版本不支持上传状态同步"));
    }
    const previous = syncChainsRef.current.get(entry.item.mutationId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => reportRegisteredUploadItemStatus(
        (items) => adminApi.registerUploadItems!(items),
        (mutationId, statusPatch) => adminApi.updateUploadItemStatus!(
          mutationId,
          statusPatch,
        ),
        entry.item,
        entry.patch,
        syncRegisteredRef.current,
        isSessionActive,
      ));
    return trackSyncChain(entry.item.mutationId, next);
  }, [isSessionActive, trackSyncChain]);

  const acknowledgeStatusSync = useCallback((entry: PendingUploadStatusSync) => {
    if (!isSessionActive()) return;
    syncAcknowledgedStatusRef.current.set(
      entry.item.mutationId,
      entry.patch.status,
    );
    const pending = syncPendingStatusRef.current.get(entry.item.mutationId);
    if (pending?.attemptId === entry.attemptId) {
      syncPendingStatusRef.current.delete(entry.item.mutationId);
    }
  }, [isSessionActive]);

  const makePendingStatusSync = useCallback((
    item: UploadQueueItem,
    status: QueueStatus,
    extra: Partial<UploadItemStatusPatch> = {},
  ): PendingUploadStatusSync => ({
    item,
    patch: {
      status,
      title: item.title.trim() || "未命名案例",
      imageCount: item.files.length || item.previews.length,
      packageTypes: item.packageTypes,
      scenes: item.scenes,
      ...extra,
    },
    attemptId: ++syncStatusAttemptSequenceRef.current,
  }), []);

  const updateSyncStatus = useCallback((
    item: UploadQueueItem,
    status: QueueStatus,
    extra: Partial<UploadItemStatusPatch> = {},
  ) => {
    if (
      !config.activitySyncEnabled ||
      !adminApi.registerUploadItems ||
      !adminApi.updateUploadItemStatus
    ) return;
    const entry = makePendingStatusSync(item, status, extra);
    syncPendingStatusRef.current.set(item.mutationId, entry);
    void performStatusSync(entry)
      .then(() => {
        acknowledgeStatusSync(entry);
        if (isSessionActive() && mountedRef.current) setSyncError("");
      })
      .catch((reason) => {
        if (isSessionActive() && mountedRef.current) {
          setSyncError(getErrorMessage(reason, "管理员动态暂时无法同步"));
        }
      });
  }, [
    acknowledgeStatusSync,
    config.activitySyncEnabled,
    isSessionActive,
    makePendingStatusSync,
    performStatusSync,
  ]);

  useEffect(() => {
    if (
      !config.activitySyncEnabled ||
      !queueHydrated ||
      !adminApi.registerUploadItems ||
      !adminApi.updateUploadItemStatus
    ) return;

    queueRef.current.forEach((item) => {
      if (item.status === "waiting") return;
      if (syncAcknowledgedStatusRef.current.get(item.mutationId) === item.status) return;
      const pending = syncPendingStatusRef.current.get(item.mutationId);
      if (pending?.patch.status === item.status) return;
      syncPendingStatusRef.current.set(
        item.mutationId,
        makePendingStatusSync(item, item.status, {
          ...(item.createdCaseId ? { caseId: item.createdCaseId } : {}),
          ...(item.status === "failed" && item.error ? { error: item.error } : {}),
        }),
      );
    });

    const reconciler = createUploadStatusReconciler({
      getPending: () => Array.from(syncPendingStatusRef.current.values()),
      replay: performStatusSync,
      acknowledge: acknowledgeStatusSync,
      isActive: isSessionActive,
      onError: (reason) => {
        if (isSessionActive() && mountedRef.current) {
          setSyncError(getErrorMessage(reason, "管理员动态暂时无法同步"));
        }
      },
      onSuccess: () => {
        if (isSessionActive() && mountedRef.current) setSyncError("");
      },
    });
    syncStatusReconcilerRef.current = reconciler;
    void reconciler.reconcileNow();
    return () => {
      reconciler.stop();
      if (syncStatusReconcilerRef.current === reconciler) {
        syncStatusReconcilerRef.current = null;
      }
    };
  }, [
    acknowledgeStatusSync,
    config.activitySyncEnabled,
    isSessionActive,
    makePendingStatusSync,
    performStatusSync,
    queueHydrated,
    sessionUid,
  ]);

  const removeFromSync = useCallback((item: UploadQueueItem) => {
    if (!isSessionActive()) return;
    syncPendingStatusRef.current.delete(item.mutationId);
    syncAcknowledgedStatusRef.current.delete(item.mutationId);
    if (
      !config.activitySyncEnabled ||
      !adminApi.registerUploadItems ||
      !adminApi.removeUploadItem
    ) return;
    const previous = syncChainsRef.current.get(item.mutationId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => removeRegisteredUploadItem(
        (items) => adminApi.registerUploadItems!(items),
        (mutationId) => adminApi.removeUploadItem!(mutationId),
        item,
        syncRegisteredRef.current,
        isSessionActive,
      ))
      .then(() => {
        if (isSessionActive()) setSyncError("");
      })
      .catch((reason) => {
        if (isSessionActive() && mountedRef.current) {
          setSyncError(getErrorMessage(reason, "管理员动态暂时无法同步"));
        }
      });
    void trackSyncChain(item.mutationId, next);
  }, [config.activitySyncEnabled, isSessionActive, trackSyncChain]);

  useEffect(() => {
    if (!config.activitySyncEnabled || !sessionUid) {
      setActivities([]);
      setSharedJobs([]);
      setSyncLoading(false);
      return;
    }

    let disposed = false;
    let watcher: ReturnType<NonNullable<typeof adminApi.subscribeAdminActivity>> | null = null;
    let activityPollTimer: ReturnType<typeof setInterval> | null = null;
    let jobPollTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const activityRequests = createLatestRequestGuard();
    const jobRequests = createLatestRequestGuard();
    let activityFailure = "";
    let jobFailure = "";

    const publishFailures = () => {
      if (disposed) return;
      setSyncError([activityFailure, jobFailure].filter(Boolean).join("；"));
    };

    const refreshActivities = async () => {
      if (!adminApi.listAdminActivity) {
        throw new Error("当前后台版本不支持管理员动态同步");
      }
      const sequence = activityRequests.issue();
      try {
        const nextActivities = await adminApi.listAdminActivity(50);
        if (disposed || !activityRequests.canApply(sequence)) return false;
        setActivities(nextActivities.slice(0, 50));
        return true;
      } catch (reason) {
        if (disposed || !activityRequests.canApply(sequence)) return false;
        throw reason;
      }
    };

    const refreshJobs = async () => {
      if (!adminApi.listSharedUploadItems) {
        throw new Error("当前后台版本不支持共享上传任务");
      }
      const sequence = jobRequests.issue();
      try {
        const nextJobs = await adminApi.listSharedUploadItems(50);
        if (disposed || !jobRequests.canApply(sequence)) return false;
        setSharedJobs(nextJobs.slice(0, 50));
        return true;
      } catch (reason) {
        if (disposed || !jobRequests.canApply(sequence)) return false;
        throw reason;
      }
    };

    const pollActivities = () => {
      void refreshActivities()
        .then((applied) => {
          if (!applied) return;
          activityFailure = "";
          publishFailures();
        })
        .catch((reason) => {
          activityFailure = getErrorMessage(reason, "管理员动态暂时无法同步");
          publishFailures();
        });
    };

    const pollJobs = () => {
      void refreshJobs()
        .then((applied) => {
          if (!applied) return;
          jobFailure = "";
          publishFailures();
        })
        .catch((reason) => {
          jobFailure = getErrorMessage(reason, "任务状态暂时无法同步");
          publishFailures();
        });
    };

    const stopActivityPolling = () => {
      if (!activityPollTimer) return;
      clearInterval(activityPollTimer);
      activityPollTimer = null;
    };

    const startActivityPolling = () => {
      if (activityPollTimer || disposed) return;
      activityPollTimer = setInterval(pollActivities, SYNC_POLL_INTERVAL_MS);
    };

    const startJobPolling = () => {
      if (jobPollTimer || disposed) return;
      jobPollTimer = setInterval(pollJobs, SYNC_POLL_INTERVAL_MS);
    };

    const scheduleReconnect = () => {
      if (
        reconnectTimer ||
        watcher ||
        disposed ||
        !adminApi.subscribeAdminActivity
      ) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWatch();
      }, SYNC_POLL_INTERVAL_MS);
    };

    const connectWatch = () => {
      if (disposed || watcher || !adminApi.subscribeAdminActivity) return;
      try {
        watcher = adminApi.subscribeAdminActivity(
          sessionUid,
          (nextActivities) => {
            if (disposed) return;
            const sequence = activityRequests.issue();
            if (activityRequests.canApply(sequence)) {
              setActivities(nextActivities.slice(0, 50));
            }
            stopActivityPolling();
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
            setSyncLoading(false);
            activityFailure = "";
            publishFailures();
          },
          (reason) => {
            if (disposed) return;
            watcher?.close();
            watcher = null;
            activityFailure = getErrorMessage(
              reason,
              "实时连接已断开，已切换为定时同步",
            );
            publishFailures();
            startActivityPolling();
            scheduleReconnect();
          },
        );
      } catch (reason) {
        watcher = null;
        activityFailure = getErrorMessage(
          reason,
          "实时连接不可用，已切换为定时同步",
        );
        publishFailures();
        startActivityPolling();
        scheduleReconnect();
      }
    };

    setSyncLoading(true);
    void Promise.allSettled([refreshActivities(), refreshJobs()]).then((results) => {
      if (disposed) return;
      if (results[0].status === "rejected") {
        activityFailure = getErrorMessage(
          results[0].reason,
          "管理员动态暂时无法同步",
        );
      }
      if (results[1].status === "rejected") {
        jobFailure = getErrorMessage(results[1].reason, "任务状态暂时无法同步");
      }
      publishFailures();
      setSyncLoading(false);
    });
    startJobPolling();
    if (adminApi.subscribeAdminActivity) {
      connectWatch();
    } else {
      startActivityPolling();
    }

    return () => {
      disposed = true;
      watcher?.close();
      stopActivityPolling();
      if (jobPollTimer) clearInterval(jobPollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [config.activitySyncEnabled, sessionUid]);

  const removeItem = useCallback((id: string) => {
    const item = queueRef.current.find((candidate) => candidate.id === id);
    if (item && ["waiting", "failed"].includes(item.status)) removeFromSync(item);
    updateQueue((current) => {
      const removed = current.filter((candidate) => candidate.id === id);
      revokeQueuePreviews(removed);
      return current.filter((candidate) => candidate.id !== id);
    });
    titleDraftsRef.current?.delete(id);
    if (titleDraftsRef.current) writeTitleDrafts(sessionUid, titleDraftsRef.current);
    setSelectedIds((current) => current.filter((candidate) => candidate !== id));
  }, [removeFromSync, sessionUid, updateQueue]);

  const openCreated = useCallback((id: string) => {
    if (id) navigate(`/cases/${id}/edit`);
  }, [navigate]);

  const addFiles = async (incoming: File[]) => {
    if (!config.writeEnabled) {
      message.warning("当前为只读模式，暂不能加入上传队列");
      return;
    }
    if (!queueLoadedRef.current) {
      message.error("上传队列尚未安全读取，请刷新页面后重试");
      return;
    }
    if (addingFilesRef.current || running) {
      message.info("正在保存或上传上一批图片，请稍候");
      return;
    }
    if (inputRef.current) inputRef.current.value = "";
    const currentQueue = applyTitleDrafts(
      queueRef.current,
      titleDraftsRef.current || new Map(),
    );
    const valid: File[] = [];
    const failures: string[] = [];
    const signatures = new Set(
      currentQueue.flatMap((item) =>
        item.files.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
      ),
    );
    incoming.forEach((file) => {
      const issue = isSupportedImage(file, config.limits.uploadBytes);
      const signature = `${file.name}:${file.size}:${file.lastModified}`;
      if (issue) {
        failures.push(`${file.name}：${issue}`);
      } else if (signatures.has(signature)) {
        failures.push(`${file.name}：已在队列中`);
      } else {
        signatures.add(signature);
        valid.push(file);
      }
    });
    if (valid.length) {
      addingFilesRef.current = true;
      setAddingFiles(true);
      const uploadBatchId = `batch-${crypto.randomUUID()}`;
      const added = valid.map((file) =>
        makeQueueItem([file], defaultPackages, defaultScenes, uploadBatchId),
      );
      const next = [...currentQueue, ...added];
      let persisted = false;
      try {
        await queueSaverRef.current?.flush();
        persistenceFailedRef.current = false;
        queueSaverRef.current?.schedule(next);
        await queueSaverRef.current?.flush();
        persisted = !persistenceFailedRef.current;
      } catch (reason) {
        if (mountedRef.current) {
          setPersistenceError(
            getErrorMessage(reason, "上传队列无法持久保存，刷新前请先处理完"),
          );
        }
      }
      if (!mountedRef.current) {
        revokeQueuePreviews(added);
        return;
      }
      if (persisted) alreadyPersistedQueueRef.current = next;
      queueRef.current = next;
      updateQueue(() => next);
      registerForSync(added);
      message.success(`已加入 ${valid.length} 张图片，默认一图一个隐藏案例`);
      addingFilesRef.current = false;
      setAddingFiles(false);
    }
    if (failures.length) message.warning(failures.slice(0, 3).join("；"));
  };

  const mergeSelected = () => {
    const currentQueue = applyTitleDrafts(
      queueRef.current,
      titleDraftsRef.current || new Map(),
    );
    const selected = currentQueue.filter(
      (item) => selectedIdSet.has(item.id) && item.status === "waiting",
    );
    if (selected.length < 2) {
      message.info("请至少选择 2 个等待中的单图案例");
      return;
    }
    const files = selected.flatMap((item) => item.files);
    if (files.length > config.limits.gallery) {
      message.error(`一个案例最多合并 ${config.limits.gallery} 张图片`);
      return;
    }
    const firstIndex = Math.min(
      ...selected.map((item) => currentQueue.indexOf(item)),
    );
    const merged = makeQueueItem(
      files,
      selected[0].packageTypes,
      selected[0].scenes,
      `batch-${crypto.randomUUID()}`,
    );
    merged.title = selected[0].title;
    updateQueue(() => {
      revokeQueuePreviews(
        currentQueue.filter((item) => selectedIdSet.has(item.id)),
      );
      const remaining = currentQueue.filter(
        (item) => !selectedIdSet.has(item.id),
      );
      remaining.splice(firstIndex, 0, merged);
      return remaining;
    });
    selected.forEach(removeFromSync);
    registerForSync([merged]);
    selected.forEach((item) => titleDraftsRef.current?.delete(item.id));
    if (titleDraftsRef.current) writeTitleDrafts(sessionUid, titleDraftsRef.current);
    setSelectedIds([]);
    message.success(`已合并为一个 ${files.length} 图案例，第一张为封面`);
  };

  const processItem = useCallback(async (source: UploadQueueItem) => {
    if (!isSessionActive()) return;
    if (!source.files.length) {
      updateItem(source.id, {
        status: "failed",
        error: "本地文件不可用，请移除后重新选择图片",
      });
      updateSyncStatus(source, "failed", { error: "本地文件不可用" });
      return;
    }
    updateItem(source.id, { status: "uploading", progress: 4, error: "" });
    updateSyncStatus(source, "uploading");
    let reportedStage: QueueStatus = "uploading";
    let uploaded: UploadedCaseImages | null = null;
    try {
      uploaded = await adminApi.uploadCaseImages(
        source.files,
        source.uploadBatchId,
        (progress) => {
          if (!isSessionActive()) return;
          if (progress.stage === "processing" && reportedStage !== "processing") {
            reportedStage = "processing";
            updateSyncStatus(source, "processing");
          }
          const ratio = progress.total ? progress.completed / progress.total : 0;
          updateItem(source.id, {
            status: progress.stage === "uploading" ? "uploading" : "processing",
            progress:
              progress.stage === "uploading"
                ? Math.round(5 + ratio * 55)
                : Math.round(65 + ratio * 20),
          });
        },
      );
      assertUploadPageSessionActive(isSessionActive);
      updateItem(source.id, { status: "creating", progress: 90 });
      updateSyncStatus(source, "creating");
      const result = await adminApi.createCase(
        buildUploadedCaseDraft(source, uploaded),
        source.mutationId,
        source.uploadBatchId,
      );
      assertUploadPageSessionActive(isSessionActive);
      revokeQueuePreviews([source]);
      const completedStatus: QueueStatus = source.packageTypes.length
        ? "done"
        : "needs_tags";
      updateItem(source.id, {
        status: completedStatus,
        progress: 100,
        files: [],
        previews: [],
        createdId: result.id,
        createdCaseId: result.caseId,
      });
      updateSyncStatus(source, completedStatus, { caseId: result.caseId });
    } catch (reason) {
      if (!isSessionActive() || reason instanceof UploadPageSessionInactiveError) return;
      if (uploaded) {
        const generatedFileIDs = uploaded.variants.flatMap((variant) => [
          variant.displayFileID,
          variant.thumbnailFileID,
          variant.bannerFileID,
        ]);
        try {
          assertUploadPageSessionActive(isSessionActive);
          await adminApi.cleanupUnreferencedFiles(generatedFileIDs);
        } catch {
          // Preserve the create/upload error; cleanup is best effort and server-side reference safe.
        }
      }
      if (!isSessionActive()) return;
      updateItem(source.id, {
        status: "failed",
        error: getErrorMessage(reason, "上传失败，请重试"),
      });
      updateSyncStatus(source, "failed", { error: "上传失败" });
    }
  }, [isSessionActive, updateItem, updateSyncStatus]);

  const runPool = async (items: UploadQueueItem[]) => {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, items.length) },
      async () => {
        while (cursor < items.length && isSessionActive()) {
          const index = cursor;
          cursor += 1;
          await processItem(items[index]);
        }
      },
    );
    await Promise.all(workers);
  };

  const startUpload = async () => {
    if (!isSessionActive()) return;
    const currentQueue = applyTitleDrafts(
      queueRef.current,
      titleDraftsRef.current || new Map(),
    );
    const waiting = currentQueue.filter((item) => item.status === "waiting");
    if (!waiting.length) {
      message.info("队列中没有等待上传的案例");
      return;
    }
    updateQueue(() => currentQueue);
    setRunning(true);
    await runPool(waiting);
    if (!isSessionActive()) return;
    setRunning(false);
    message.success("本批次处理完成，可查看失败项或补充标签");
  };

  const retry = useCallback(async (item: UploadQueueItem) => {
    if (!isSessionActive()) return;
    const current = applyTitleDrafts(
      queueRef.current,
      titleDraftsRef.current || new Map(),
    ).find((candidate) => candidate.id === item.id) || item;
    setRunning(true);
    await processItem(current);
    if (!isSessionActive()) return;
    setRunning(false);
  }, [isSessionActive, processItem]);

  const applyDefaultPackages = (values: string[]) => {
    if (running || addingFiles) return;
    setDefaultPackages(values);
    updateQueue((current) =>
      current.map((item) =>
        item.status === "waiting" ? { ...item, packageTypes: values } : item,
      ),
    );
  };

  const applyDefaultScenes = (values: string[]) => {
    if (running || addingFiles) return;
    setDefaultScenes(values);
    updateQueue((current) =>
      current.map((item) =>
        item.status === "waiting" ? { ...item, scenes: values } : item,
      ),
    );
  };

  const stats = useMemo(() => queue.reduce(
    (current, item) => {
      if (item.status === "waiting") current.waiting += 1;
      if (["uploading", "processing", "creating"].includes(item.status)) {
        current.active += 1;
      }
      if (["done", "needs_tags"].includes(item.status)) current.done += 1;
      if (item.status === "failed") current.failed += 1;
      return current;
    },
    { total: queue.length, waiting: 0, active: 0, done: 0, failed: 0 },
  ), [queue]);

  if (configLoading || !queueHydrated) return <PageLoading rows={5} />;

  return (
    <div className="page-stack">
      {!config.writeEnabled ? <WriteDisabledAlert /> : null}
      {persistenceError ? (
        <Alert
          type="warning"
          showIcon
          closable
          title="上传队列刷新恢复不可用"
          description={persistenceError}
          onClose={() => setPersistenceError("")}
        />
      ) : null}
      {config.activitySyncEnabled && syncError ? (
        <Alert
          type="warning"
          showIcon
          closable
          title="管理员动态同步暂时不可用"
          description={`${syncError}。本机上传不受影响。`}
          onClose={() => setSyncError("")}
        />
      ) : null}

      <div className="upload-intro-grid">
        <Card className="upload-drop-card">
          <div
            className={`upload-dropzone ${dragging ? "is-dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void addFiles(Array.from(event.dataTransfer.files));
            }}
          >
            <InboxOutlined />
            <Typography.Title level={4}>拖入一批案例图片</Typography.Title>
            <Typography.Paragraph>
              默认一张图片生成一个隐藏案例；支持 JPEG、PNG、WebP，单张不超过 20MB。
            </Typography.Paragraph>
            <Button
              type="primary"
              icon={<CloudUploadOutlined />}
              loading={addingFiles}
              disabled={!config.writeEnabled || running || addingFiles}
              onClick={() => inputRef.current?.click()}
            >
              选择图片
            </Button>
            <input
              ref={inputRef}
              hidden
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                void addFiles(Array.from(event.target.files || []));
              }}
            />
          </div>
        </Card>

        <Card className="upload-settings-card" title="本批次默认设置">
          <div className="upload-default-labels">
            <div>
              <Typography.Text className="field-label">包装标签（可暂不选择）</Typography.Text>
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                value={defaultPackages}
                disabled={running || addingFiles}
                placeholder="上传后再补充也可以"
                options={packageOptions}
                onChange={applyDefaultPackages}
                className="full-width"
              />
            </div>
            <div>
              <Typography.Text className="field-label">使用场景（可暂不选择）</Typography.Text>
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                value={defaultScenes}
                disabled={running || addingFiles}
                placeholder="同一场景可一次设置"
                options={sceneOptions}
                onChange={applyDefaultScenes}
                className="full-width"
              />
            </div>
          </div>
          <Alert
            type="info"
            showIcon
            title="新案例默认隐藏"
            description="未补包装标签的案例会标记为“待补标签”，补齐前无法上架。"
          />
          <div className="upload-rules">
            <span><CheckCircleFilled /> 并发处理 3 个案例</span>
            <span><CheckCircleFilled /> 单案例最多 9 张图片</span>
            <span><CheckCircleFilled /> 失败重试不会重复建档</span>
          </div>
        </Card>
      </div>

      <Card className="queue-card">
        <div className="queue-header">
          <div>
            <Typography.Title level={4}>上传队列</Typography.Title>
            <Typography.Text className="secondary-text">
              勾选多个等待项，可合并成一个多图案例。
            </Typography.Text>
          </div>
          <Space>
            <Button
              icon={<MergeCellsOutlined />}
              disabled={selectedIds.length < 2 || running || addingFiles}
              onClick={mergeSelected}
            >
              合并已选（{selectedIds.length}）
            </Button>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={running || addingFiles}
              disabled={!stats.waiting || !config.writeEnabled || addingFiles}
              onClick={() => void startUpload()}
            >
              开始上传
            </Button>
          </Space>
        </div>

        <div className="queue-stats">
          <Statistic title="队列案例" value={stats.total} />
          <Statistic title="等待" value={stats.waiting} />
          <Statistic title="处理中" value={stats.active} />
          <Statistic title="已建档" value={stats.done} />
          <Statistic
            title="失败"
            value={stats.failed}
            styles={{ content: { color: stats.failed ? "#a8493f" : undefined } }}
          />
        </div>

        {!queue.length ? (
          <div className="queue-empty">
            <FileImageOutlined />
            <strong>队列还是空的</strong>
            <span>从上方选择图片后，会在这里逐项显示处理进度。</span>
          </div>
        ) : (
          <div className="queue-list">
            {queue.map((item) => (
              <QueueItemRow
                key={item.id}
                item={item}
                packageOptions={packageOptions}
                sceneOptions={sceneOptions}
                running={running || addingFiles}
                selected={selectedIdSet.has(item.id)}
                onOpenCreated={openCreated}
                onDraftTitleChange={updateDraftTitle}
                onPatch={updateItem}
                onRemove={removeItem}
                onRetry={retry}
                onToggleSelected={toggleSelected}
              />
            ))}
          </div>
        )}

        {queue.some((item) => ["done", "needs_tags", "failed"].includes(item.status)) ? (
          <div className="queue-footer">
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              disabled={running || addingFiles}
              onClick={() => {
                const removeIds = queueRef.current
                  .filter((item) =>
                    ["done", "needs_tags", "failed"].includes(item.status),
                  )
                  .map((item) => item.id);
                removeIds.forEach((id) => titleDraftsRef.current?.delete(id));
                if (titleDraftsRef.current) {
                  writeTitleDrafts(sessionUid, titleDraftsRef.current);
                }
                updateQueue((current) => {
                  const keep = current.filter((item) =>
                    ["waiting", "uploading", "processing", "creating"].includes(item.status),
                  );
                  const keepIds = new Set(keep.map((item) => item.id));
                  revokeQueuePreviews(
                    current.filter((item) => !keepIds.has(item.id)),
                  );
                  return keep;
                });
              }}
            >
              清理已处理项
            </Button>
          </div>
        ) : null}
      </Card>

      {config.activitySyncEnabled ? (
        <AdminActivityPanel
          activities={activities}
          sharedJobs={sharedJobs}
          currentUid={sessionUid}
          loading={syncLoading}
        />
      ) : null}
    </div>
  );
}
