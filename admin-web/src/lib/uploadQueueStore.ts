import type { QueueStatus, UploadQueueItem } from "../types";

const DATABASE_NAME = "wine-admin-upload-queue";
const DATABASE_VERSION = 1;
const STORE_NAME = "queue";
const SNAPSHOT_KEY = "current";
const INTERRUPTED_STATUSES: QueueStatus[] = [
  "uploading",
  "processing",
  "creating",
];
const FILE_FREE_STATUSES: QueueStatus[] = ["done", "needs_tags"];

export interface PersistedUploadQueueItem
  extends Omit<UploadQueueItem, "previews"> {
  previews?: never;
}

interface QueueSnapshot {
  id: string;
  items: PersistedUploadQueueItem[];
  savedAt: string;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) {
    return Promise.reject(new Error("当前浏览器不支持 IndexedDB"));
  }
  if (databasePromise) return databasePromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("上传队列存储打开失败"));
    request.onblocked = () => reject(new Error("上传队列存储被其他页面占用"));
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });
  databasePromise = opening;
  return opening;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("上传队列存储操作失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("上传队列存储事务失败"));
    transaction.onabort = () =>
      reject(transaction.error || new Error("上传队列存储事务已取消"));
  });
}

export function toPersistedUploadQueue(
  items: UploadQueueItem[],
): PersistedUploadQueueItem[] {
  return items.map(({ previews: _previews, ...item }) => ({
    ...item,
    files: FILE_FREE_STATUSES.includes(item.status) ? [] : item.files,
  }));
}

export function restoreUploadQueue(
  items: PersistedUploadQueueItem[],
  createObjectUrl: (file: File) => string = URL.createObjectURL,
): UploadQueueItem[] {
  return items.map((item) => {
    const interrupted = INTERRUPTED_STATUSES.includes(item.status);
    const files = Array.isArray(item.files) ? item.files : [];
    return {
      ...item,
      files,
      previews: files.map((file) => createObjectUrl(file)),
      scenes: Array.isArray((item as { scenes?: unknown }).scenes)
        ? (item as { scenes: unknown[] }).scenes.map(String).filter(Boolean)
        : [],
      status: interrupted ? "failed" : item.status,
      progress: interrupted ? 0 : Number(item.progress || 0),
      error: interrupted
        ? "页面刷新中断了处理，可使用原文件安全重试"
        : String(item.error || ""),
    };
  });
}

export function uploadQueueSnapshotKey(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) throw new Error("缺少当前管理员 UID，无法读取上传队列");
  return `${SNAPSHOT_KEY}:${encodeURIComponent(normalized)}`;
}

export function revokeQueuePreviews(
  items: Pick<UploadQueueItem, "previews">[],
  revokeObjectUrl: (url: string) => void = URL.revokeObjectURL,
): void {
  items.forEach((item) => {
    item.previews.forEach((preview) => {
      if (preview.startsWith("blob:")) revokeObjectUrl(preview);
    });
  });
}

export async function loadPersistedUploadQueue(userId: string): Promise<UploadQueueItem[]> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const scopedKey = uploadQueueSnapshotKey(userId);
  const [scopedSnapshot, legacySnapshot] = await Promise.all([
    requestResult(store.get(scopedKey)) as Promise<QueueSnapshot | undefined>,
    requestResult(store.get(SNAPSHOT_KEY)) as Promise<QueueSnapshot | undefined>,
  ]);
  let snapshot = scopedSnapshot;
  if (!snapshot && legacySnapshot) {
    snapshot = { ...legacySnapshot, id: scopedKey };
    store.put(snapshot);
  }
  // The unscoped snapshot is claimed by the first authenticated account only.
  // Removing it also prevents a later account from seeing the same local files.
  if (legacySnapshot) store.delete(SNAPSHOT_KEY);
  await completed;
  return restoreUploadQueue(snapshot?.items || []);
}

export async function savePersistedUploadQueue(
  items: UploadQueueItem[],
  userId: string,
): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).put({
    id: uploadQueueSnapshotKey(userId),
    items: toPersistedUploadQueue(items),
    savedAt: new Date().toISOString(),
  } satisfies QueueSnapshot);
  await transactionDone(transaction);
}
