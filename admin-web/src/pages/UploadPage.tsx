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
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { QUEUE_STATUS_META } from "../constants";
import { useAdminConfig } from "../context/AdminConfigContext";
import { adminApi } from "../lib/api";
import { isSupportedImage } from "../lib/caseLogic";
import { getErrorMessage } from "../lib/errors";
import {
  loadPersistedUploadQueue,
  revokeQueuePreviews,
  savePersistedUploadQueue,
} from "../lib/uploadQueueStore";
import type { QueueStatus, UploadedCaseImages, UploadQueueItem } from "../types";
import { PageLoading, WriteDisabledAlert } from "../components/PageStates";

const LEGACY_QUEUE_STORE_KEY = "wine-admin-upload-queue-v2";
const CONCURRENCY = 3;

function fileTitle(fileName: string): string {
  return fileName.replace(/\.(jpe?g|png|webp)$/i, "").trim() || "未命名案例";
}

function makeQueueItem(
  files: File[],
  packageTypes: string[] = [],
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
    status: "waiting",
    progress: 0,
    error: "",
  };
}

export function UploadPage() {
  const { config, loading: configLoading } = useAdminConfig();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [queueHydrated, setQueueHydrated] = useState(false);
  const [persistenceError, setPersistenceError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [defaultPackages, setDefaultPackages] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const queueRef = useRef<UploadQueueItem[]>([]);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    void loadPersistedUploadQueue()
      .then((items) => {
        if (cancelled) {
          revokeQueuePreviews(items);
          return;
        }
        localStorage.removeItem(LEGACY_QUEUE_STORE_KEY);
        queueRef.current = items;
        setQueue(items);
        setQueueHydrated(true);
      })
      .catch((reason) => {
        if (cancelled) return;
        setPersistenceError(
          getErrorMessage(reason, "上传队列无法持久保存，刷新前请先处理完"),
        );
        setQueueHydrated(true);
      });
    return () => {
      cancelled = true;
      revokeQueuePreviews(queueRef.current);
    };
  }, []);

  useEffect(() => {
    queueRef.current = queue;
    if (!queueHydrated) return;
    saveChainRef.current = saveChainRef.current
      .catch(() => undefined)
      .then(() => savePersistedUploadQueue(queue))
      .catch((reason) => {
        setPersistenceError(
          getErrorMessage(reason, "上传队列无法持久保存，刷新前请先处理完"),
        );
      });
  }, [queue, queueHydrated]);

  useEffect(() => {
    const hasActive = queue.some((item) =>
      ["uploading", "processing", "creating"].includes(item.status),
    );
    const warn = (event: BeforeUnloadEvent) => {
      if (!hasActive) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queue]);

  const updateItem = (id: string, patch: Partial<UploadQueueItem>) => {
    setQueue((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const addFiles = (incoming: File[]) => {
    if (!config.writeEnabled) {
      message.warning("当前为只读模式，暂不能加入上传队列");
      return;
    }
    const valid: File[] = [];
    const failures: string[] = [];
    const signatures = new Set(
      queue.flatMap((item) =>
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
      const uploadBatchId = `batch-${crypto.randomUUID()}`;
      setQueue((current) => [
        ...current,
        ...valid.map((file) =>
          makeQueueItem([file], defaultPackages, uploadBatchId),
        ),
      ]);
      message.success(`已加入 ${valid.length} 张图片，默认一图一个隐藏案例`);
    }
    if (failures.length) message.warning(failures.slice(0, 3).join("；"));
    if (inputRef.current) inputRef.current.value = "";
  };

  const mergeSelected = () => {
    const selected = queue.filter(
      (item) => selectedIds.includes(item.id) && item.status === "waiting",
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
    const firstIndex = Math.min(...selected.map((item) => queue.indexOf(item)));
    const selectedSet = new Set(selectedIds);
    const merged = makeQueueItem(
      files,
      selected[0].packageTypes,
      `batch-${crypto.randomUUID()}`,
    );
    merged.title = selected[0].title;
    setQueue((current) => {
      revokeQueuePreviews(
        current.filter((item) => selectedSet.has(item.id)),
      );
      const remaining = current.filter((item) => !selectedSet.has(item.id));
      remaining.splice(firstIndex, 0, merged);
      return remaining;
    });
    setSelectedIds([]);
    message.success(`已合并为一个 ${files.length} 图案例，第一张为封面`);
  };

  const processItem = async (source: UploadQueueItem) => {
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
      updateItem(source.id, { status: "creating", progress: 90 });
      const result = await adminApi.createCase(
        {
          title: source.title.trim() || "未命名案例",
          wineType: "白酒",
          packageTypes: source.packageTypes,
          styles: [],
          priceLevel: "",
          scenes: [],
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
        },
        source.mutationId,
        source.uploadBatchId,
      );
      revokeQueuePreviews([source]);
      updateItem(source.id, {
        status: source.packageTypes.length ? "done" : "needs_tags",
        progress: 100,
        files: [],
        previews: [],
        createdId: result.id,
        createdCaseId: result.caseId,
      });
    } catch (reason) {
      if (uploaded) {
        const generatedFileIDs = uploaded.variants.flatMap((variant) => [
          variant.displayFileID,
          variant.thumbnailFileID,
          variant.bannerFileID,
        ]);
        try {
          await adminApi.cleanupUnreferencedFiles(generatedFileIDs);
        } catch {
          // Preserve the create/upload error; cleanup is best effort and server-side reference safe.
        }
      }
      updateItem(source.id, {
        status: "failed",
        error: getErrorMessage(reason, "上传失败，请重试"),
      });
    }
  };

  const runPool = async (items: UploadQueueItem[]) => {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, items.length) },
      async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          await processItem(items[index]);
        }
      },
    );
    await Promise.all(workers);
  };

  const startUpload = async () => {
    const waiting = queue.filter((item) => item.status === "waiting");
    if (!waiting.length) {
      message.info("队列中没有等待上传的案例");
      return;
    }
    setRunning(true);
    await runPool(waiting);
    setRunning(false);
    message.success("本批次处理完成，可查看失败项或补充标签");
  };

  const retry = async (item: UploadQueueItem) => {
    setRunning(true);
    await processItem(item);
    setRunning(false);
  };

  const applyDefaultPackages = (values: string[]) => {
    setDefaultPackages(values);
    setQueue((current) =>
      current.map((item) =>
        item.status === "waiting" ? { ...item, packageTypes: values } : item,
      ),
    );
  };

  const stats = useMemo(() => {
    const count = (statuses: QueueStatus[]) =>
      queue.filter((item) => statuses.includes(item.status)).length;
    return {
      total: queue.length,
      waiting: count(["waiting"]),
      active: count(["uploading", "processing", "creating"]),
      done: count(["done", "needs_tags"]),
      failed: count(["failed"]),
    };
  }, [queue]);

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
              addFiles(Array.from(event.dataTransfer.files));
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
              disabled={!config.writeEnabled || running}
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
              onChange={(event) => addFiles(Array.from(event.target.files || []))}
            />
          </div>
        </Card>

        <Card className="upload-settings-card" title="本批次默认设置">
          <Typography.Text className="field-label">包装标签（可暂不选择）</Typography.Text>
          <Select
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            value={defaultPackages}
            placeholder="上传后再补充也可以"
            options={config.options.packageTypes.map((value) => ({ value, label: value }))}
            onChange={applyDefaultPackages}
            className="full-width"
          />
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
              disabled={selectedIds.length < 2 || running}
              onClick={mergeSelected}
            >
              合并已选（{selectedIds.length}）
            </Button>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={running}
              disabled={!stats.waiting || !config.writeEnabled}
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
            {queue.map((item) => {
              const meta = QUEUE_STATUS_META[item.status];
              const processing = ["uploading", "processing", "creating"].includes(item.status);
              const selectable = item.status === "waiting";
              return (
                <div className="queue-item" key={item.id}>
                  <Checkbox
                    checked={selectedIds.includes(item.id)}
                    disabled={!selectable}
                    onChange={(event) =>
                      setSelectedIds((current) =>
                        event.target.checked
                          ? [...current, item.id]
                          : current.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <div className="queue-preview-stack">
                    {item.previews.slice(0, 3).map((preview, index) => (
                      <img
                        key={`${preview}-${index}`}
                        src={preview}
                        alt={`${item.title} ${index + 1}`}
                        style={{ zIndex: 3 - index }}
                      />
                    ))}
                    {item.previews.length > 1 ? (
                      <span>{item.previews.length} 图</span>
                    ) : null}
                  </div>
                  <div className="queue-item-main">
                    <Input
                      variant="borderless"
                      className="queue-title-input"
                      value={item.title}
                      disabled={!["waiting", "failed"].includes(item.status)}
                      onChange={(event) => updateItem(item.id, { title: event.target.value })}
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
                  <div className="queue-package-field">
                    <Select
                      mode="multiple"
                      maxTagCount={1}
                      placeholder="包装标签"
                      value={item.packageTypes}
                      disabled={!["waiting", "failed"].includes(item.status)}
                      options={config.options.packageTypes.map((value) => ({ value, label: value }))}
                      onChange={(values) => updateItem(item.id, { packageTypes: values })}
                    />
                  </div>
                  <Space size={4} className="queue-actions">
                    {item.status === "failed" && item.files.length ? (
                      <Button
                        icon={<RedoOutlined />}
                        disabled={running}
                        onClick={() => void retry(item)}
                      >
                        重试
                      </Button>
                    ) : null}
                    {item.createdId ? (
                      <Button
                        icon={<LinkOutlined />}
                        onClick={() => navigate(`/cases/${item.createdId}/edit`)}
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
                        onClick={() => {
                          setQueue((current) => {
                            const removed = current.filter(
                              (candidate) => candidate.id === item.id,
                            );
                            revokeQueuePreviews(removed);
                            return current.filter(
                              (candidate) => candidate.id !== item.id,
                            );
                          });
                          setSelectedIds((current) => current.filter((id) => id !== item.id));
                        }}
                      />
                    ) : null}
                  </Space>
                </div>
              );
            })}
          </div>
        )}

        {queue.some((item) => ["done", "needs_tags", "failed"].includes(item.status)) ? (
          <div className="queue-footer">
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              disabled={running}
              onClick={() =>
                setQueue((current) => {
                  const keep = current.filter((item) =>
                    ["waiting", "uploading", "processing", "creating"].includes(item.status),
                  );
                  const keepIds = new Set(keep.map((item) => item.id));
                  revokeQueuePreviews(
                    current.filter((item) => !keepIds.has(item.id)),
                  );
                  return keep;
                })
              }
            >
              清理已处理项
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
