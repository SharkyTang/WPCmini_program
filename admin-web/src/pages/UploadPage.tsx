import {
  CheckCircleFilled,
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
  CaseDraft,
  QueueStatus,
  UploadedCaseImages,
  UploadQueueItem,
} from "../types";
import { PageLoading, WriteDisabledAlert } from "../components/PageStates";

const LEGACY_QUEUE_STORE_KEY = "wine-admin-upload-queue-v2";
const TITLE_DRAFT_STORE_KEY = "wine-admin-upload-title-drafts-v1";
const CONCURRENCY = 3;
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
    super("管理员账号已切换，旧上传任务已停止");
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

export function UploadPage() {
  const { session } = useAuth();
  if (!session?.user.id) return <PageLoading rows={5} />;
  // The key isolates local queue refs and pending savers between administrator UIDs.
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
  const [running, setRunning] = useState(false);
  const [addingFiles, setAddingFiles] = useState(false);
  const [dragging, setDragging] = useState(false);
  const mountedRef = useRef(true);
  const addingFilesRef = useRef(false);
  const queueLoadedRef = useRef(false);
  const persistenceFailedRef = useRef(false);
  const queueRef = useRef<UploadQueueItem[]>([]);
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

  const removeItem = useCallback((id: string) => {
    updateQueue((current) => {
      const removed = current.filter((candidate) => candidate.id === id);
      revokeQueuePreviews(removed);
      return current.filter((candidate) => candidate.id !== id);
    });
    titleDraftsRef.current?.delete(id);
    if (titleDraftsRef.current) writeTitleDrafts(sessionUid, titleDraftsRef.current);
    setSelectedIds((current) => current.filter((candidate) => candidate !== id));
  }, [sessionUid, updateQueue]);

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
      return;
    }
    updateItem(source.id, { status: "uploading", progress: 4, error: "" });
    let uploaded: UploadedCaseImages | null = null;
    try {
      uploaded = await adminApi.uploadCaseImages(
        source.files,
        source.uploadBatchId,
        (progress) => {
          if (!isSessionActive()) return;
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
    }
  }, [isSessionActive, updateItem]);

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
    </div>
  );
}
