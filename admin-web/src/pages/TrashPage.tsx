import {
  DeleteOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Input,
  message,
  Modal,
  Pagination,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";
import { CaseImage, CaseTagList } from "../components/CaseVisuals";
import { PageEmpty, PageError, PageLoading, WriteDisabledAlert } from "../components/PageStates";
import { EMPTY_FILTERS } from "../constants";
import { useAdminConfig } from "../context/AdminConfigContext";
import { useAuth } from "../context/AuthContext";
import { adminApi } from "../lib/api";
import { getExpectedVersions } from "../lib/caseLogic";
import { getErrorMessage } from "../lib/errors";
import {
  type PendingPurgeCleanupJob,
  readPendingPurgeCleanupJobs,
  removePendingPurgeCleanupJob,
  toPendingPurgeCleanupJob,
  upsertPendingPurgeCleanupJob,
} from "../lib/purgeCleanupStore";
import type { CaseRecord, ListCasesResponse } from "../types";

export function TrashPage() {
  const { config, loading: configLoading } = useAdminConfig();
  const { session } = useAuth();
  const sessionUid = session?.user.id || "";
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [result, setResult] = useState<ListCasesResponse>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    hasMore: false,
  });
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [purging, setPurging] = useState(false);
  const [retryingCleanupJobs, setRetryingCleanupJobs] = useState<string[]>([]);
  const [cleanupRecoveryError, setCleanupRecoveryError] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<CaseRecord[]>([]);
  const [purgeTarget, setPurgeTarget] = useState<{
    items: CaseRecord[];
    clientMutationId: string;
  } | null>(null);
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const [cleanupNotices, setCleanupNotices] = useState<PendingPurgeCleanupJob[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await adminApi.listCases({
        page,
        pageSize,
        filters: { ...EMPTY_FILTERS, keyword, trash: true },
        sort: { field: "updatedAt", direction: "desc" },
      });
      setResult(response);
      setSelected([]);
    } catch (reason) {
      setError(getErrorMessage(reason, "回收站读取失败"));
    } finally {
      setLoading(false);
    }
  }, [keyword, page, pageSize]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), keyword ? 260 : 0);
    return () => window.clearTimeout(timer);
  }, [load, refreshToken, keyword]);

  const permanentDeleteAvailable =
    config.writeEnabled &&
    config.permanentDeleteEnabled &&
    Boolean(adminApi.permanentlyDeleteCases);
  const purgeCleanupAvailable = Boolean(adminApi.retryPurgeCleanup);

  useEffect(() => {
    if (!sessionUid) {
      setCleanupNotices([]);
      setCleanupRecoveryError("");
      return;
    }

    const localJobs = readPendingPurgeCleanupJobs(sessionUid);
    setCleanupNotices(localJobs);
    setCleanupRecoveryError("");
    if (configLoading) return;

    const retry = adminApi.retryPurgeCleanup;
    let disposed = false;

    const recoverPendingCleanup = async () => {
      const jobsById = new Map(
        localJobs.map((job) => [job.cleanupJobId, job]),
      );

      if (adminApi.listPendingPurgeJobs) {
        try {
          const serverJobs = await adminApi.listPendingPurgeJobs();
          if (disposed) return;
          serverJobs.forEach((job) => {
            const pendingJob = toPendingPurgeCleanupJob(job);
            if (pendingJob.cleanupJobId && pendingJob.pendingFileCount > 0) {
              jobsById.set(pendingJob.cleanupJobId, pendingJob);
            }
          });
        } catch (reason) {
          if (disposed) return;
          setCleanupRecoveryError(
            getErrorMessage(
              reason,
              "服务端待清理任务暂时无法读取，已保留本机记录，可稍后重试",
            ),
          );
        }
      }

      if (disposed) return;
      const pendingJobs = Array.from(jobsById.values())
        .filter((job) => job.pendingFileCount > 0)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      pendingJobs.forEach((job) => upsertPendingPurgeCleanupJob(sessionUid, job));
      setCleanupNotices(pendingJobs);
      if (!pendingJobs.length || !retry) return;

      setRetryingCleanupJobs(pendingJobs.map((job) => job.cleanupJobId));
      pendingJobs.forEach((job) => {
        void retry.call(adminApi, job.cleanupJobId)
          .then((response) => {
            if (disposed) return;
            const next = toPendingPurgeCleanupJob(response);
            if (next.pendingFileCount > 0) {
              upsertPendingPurgeCleanupJob(sessionUid, next);
              setCleanupNotices((current) => [
                next,
                ...current.filter((item) => item.cleanupJobId !== next.cleanupJobId),
              ]);
            } else {
              removePendingPurgeCleanupJob(sessionUid, job.cleanupJobId);
              setCleanupNotices((current) =>
                current.filter((item) => item.cleanupJobId !== job.cleanupJobId),
              );
              message.success("上次待清理的案例图片已处理完成");
            }
          })
          .catch((reason) => {
            if (!disposed) {
              setCleanupRecoveryError(
                getErrorMessage(reason, "上次图片清理暂时无法继续，可稍后手动重试"),
              );
            }
          })
          .finally(() => {
            if (!disposed) {
              setRetryingCleanupJobs((current) =>
                current.filter((id) => id !== job.cleanupJobId),
              );
            }
          });
      });
    };

    void recoverPendingCleanup();

    return () => {
      disposed = true;
    };
  }, [configLoading, sessionUid]);

  const restore = (items: CaseRecord[]) => {
    Modal.confirm({
      title: `恢复 ${items.length} 个案例？`,
      content: "恢复后的案例保持隐藏，不会立即出现在小程序前台。补充检查后可在案例库中上架。",
      okText: "恢复案例",
      cancelText: "取消",
      async onOk() {
        setRestoring(true);
        try {
          await adminApi.restoreCases(
            items.map((item) => item._id),
            getExpectedVersions(items),
          );
          message.success(`已恢复 ${items.length} 个案例`);
          setRefreshToken((value) => value + 1);
        } catch (reason) {
          message.error(getErrorMessage(reason, "恢复失败"));
        } finally {
          setRestoring(false);
        }
      },
    });
  };

  const openPurgeConfirmation = (items: CaseRecord[]) => {
    if (!permanentDeleteAvailable || purging || !items.length) return;
    setPurgeConfirmation("");
    setPurgeTarget({ items, clientMutationId: crypto.randomUUID() });
  };

  const permanentlyDelete = async () => {
    if (!purgeTarget || purgeConfirmation !== "永久删除" || !permanentDeleteAvailable) return;
    const purge = adminApi.permanentlyDeleteCases;
    if (!purge) {
      message.error("当前后台版本不支持永久删除，请刷新页面后重试");
      return;
    }
    setPurging(true);
    try {
      const response = await purge.call(
        adminApi,
        purgeTarget.items.map((item) => item._id),
        getExpectedVersions(purgeTarget.items),
        purgeTarget.clientMutationId,
      );
      message.success(`已永久删除 ${response.deleted} 个案例`);
      const cleanupJob = toPendingPurgeCleanupJob(response);
      if (cleanupJob.pendingFileCount > 0) {
        upsertPendingPurgeCleanupJob(sessionUid, cleanupJob);
        setCleanupNotices((current) => [
          cleanupJob,
          ...current.filter((item) => item.cleanupJobId !== cleanupJob.cleanupJobId),
        ]);
      } else {
        removePendingPurgeCleanupJob(sessionUid, cleanupJob.cleanupJobId);
      }
      setPurgeTarget(null);
      setPurgeConfirmation("");
      setSelected([]);
      if (page > 1 && result.items.length <= response.deleted) {
        setPage((value) => Math.max(1, value - 1));
      } else {
        setRefreshToken((value) => value + 1);
      }
    } catch (reason) {
      message.error(getErrorMessage(reason, "永久删除失败"));
    } finally {
      setPurging(false);
    }
  };

  const retryCleanup = async (cleanupJob: PendingPurgeCleanupJob) => {
    if (!cleanupJob.cleanupJobId) return;
    const retry = adminApi.retryPurgeCleanup;
    if (!retry) {
      message.error("当前后台版本不支持继续清理，请刷新页面后重试");
      return;
    }
    setRetryingCleanupJobs((current) =>
      current.includes(cleanupJob.cleanupJobId)
        ? current
        : [...current, cleanupJob.cleanupJobId],
    );
    setCleanupRecoveryError("");
    try {
      const response = await retry.call(adminApi, cleanupJob.cleanupJobId);
      const next = toPendingPurgeCleanupJob(response);
      if (next.pendingFileCount) {
        upsertPendingPurgeCleanupJob(sessionUid, next);
        setCleanupNotices((current) => [
          next,
          ...current.filter((item) => item.cleanupJobId !== next.cleanupJobId),
        ]);
        message.warning(`仍有 ${next.pendingFileCount} 个文件待清理，请稍后重试`);
      } else {
        removePendingPurgeCleanupJob(sessionUid, cleanupJob.cleanupJobId);
        setCleanupNotices((current) =>
          current.filter((item) => item.cleanupJobId !== cleanupJob.cleanupJobId),
        );
        message.success("案例图片清理已完成");
      }
    } catch (reason) {
      message.error(getErrorMessage(reason, "继续清理失败"));
    } finally {
      setRetryingCleanupJobs((current) =>
        current.filter((id) => id !== cleanupJob.cleanupJobId),
      );
    }
  };

  const columns: TableColumnsType<CaseRecord> = [
    {
      title: "案例",
      key: "case",
      width: 340,
      render: (_, item) => (
        <div className="case-title-cell">
          <CaseImage item={item} />
          <span>
            <strong>{item.title}</strong>
            <small>{item.caseId}</small>
          </span>
        </div>
      ),
    },
    {
      title: "标签",
      key: "tags",
      render: (_, item) =>
        item.packageTypes.length ? <CaseTagList item={item} limit={4} /> : <Tag>未分类</Tag>,
    },
    {
      title: "移入时间",
      dataIndex: "deletedAt",
      width: 180,
      render: (value) => (value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "—"),
    },
    {
      title: "移入账号",
      key: "actor",
      width: 180,
      render: (_, item) => item.deletedBy?.id || "历史操作",
    },
    {
      title: "状态",
      width: 110,
      render: () => <Tag color="default">已下架</Tag>,
    },
    {
      title: "操作",
      key: "action",
      width: 220,
      fixed: "right",
      render: (_, item) => (
        <Space size={0}>
          <Button
            type="link"
            icon={<UndoOutlined />}
            disabled={!config.writeEnabled || purging}
            onClick={() => restore([item])}
          >
            恢复
          </Button>
          <Button
            type="link"
            danger
            icon={<DeleteOutlined />}
            disabled={!permanentDeleteAvailable || restoring || purging}
            onClick={() => openPurgeConfirmation([item])}
          >
            永久删除
          </Button>
        </Space>
      ),
    },
  ];

  if (configLoading) return <PageLoading rows={5} />;

  return (
    <div className="page-stack">
      {!config.writeEnabled ? <WriteDisabledAlert /> : null}
      <Alert
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        title="回收站支持恢复和手动永久删除"
        description="恢复后案例仍为隐藏状态。永久删除会移除案例，并清理没有被其他案例引用的云端图片；删除后无法恢复。"
      />
      {cleanupRecoveryError ? (
        <Alert
          type="warning"
          showIcon
          closable
          title="待清理图片暂时无法自动恢复"
          description={cleanupRecoveryError}
          onClose={() => setCleanupRecoveryError("")}
        />
      ) : null}
      {cleanupNotices.map((cleanupJob) => {
        const retrying = retryingCleanupJobs.includes(cleanupJob.cleanupJobId);
        return (
          <Alert
            key={cleanupJob.cleanupJobId}
            type="warning"
            showIcon
            title={`案例已删除，仍有 ${cleanupJob.pendingFileCount} 个文件待清理`}
            description={
              <Space wrap>
                <span>已清理 {cleanupJob.deletedFileCount} 个文件</span>
                {cleanupJob.retainedReferencedCount ? (
                  <span>保留 {cleanupJob.retainedReferencedCount} 个仍被引用的文件</span>
                ) : null}
                <Button
                  size="small"
                  loading={retrying}
                  disabled={!purgeCleanupAvailable}
                  onClick={() => void retryCleanup(cleanupJob)}
                >
                  继续清理
                </Button>
              </Space>
            }
          />
        );
      })}

      <div className="page-toolbar">
        <div>
          <Typography.Text className="toolbar-count">
            回收站中 <strong>{result.total}</strong> 个案例
          </Typography.Text>
          <Typography.Text className="secondary-text">
            恢复会保留原编号与标签；永久删除后无法恢复
          </Typography.Text>
        </div>
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => setRefreshToken((value) => value + 1)}
          >
            刷新
          </Button>
          <Button
            danger
            icon={<DeleteOutlined />}
            loading={purging}
            disabled={!selected.length || !permanentDeleteAvailable || restoring}
            onClick={() => openPurgeConfirmation(selected)}
          >
            永久删除已选（{selected.length}）
          </Button>
          <Button
            type="primary"
            icon={<UndoOutlined />}
            loading={restoring}
            disabled={!selected.length || !config.writeEnabled || purging}
            onClick={() => restore(selected)}
          >
            恢复已选（{selected.length}）
          </Button>
        </Space>
      </div>

      <Card className="trash-search-card">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          value={keyword}
          placeholder="搜索已回收案例的标题、编号或标签"
          onChange={(event) => {
            setKeyword(event.target.value);
            setPage(1);
          }}
        />
      </Card>

      {loading ? (
        <PageLoading />
      ) : error ? (
        <PageError message={error} onRetry={() => void load()} />
      ) : !result.items.length ? (
        <PageEmpty
          title={keyword ? "没有匹配的已回收案例" : "回收站是空的"}
          description={keyword ? "换一个关键词再试试。" : "从案例库移入回收站的案例会显示在这里。"}
        />
      ) : (
        <Card className="data-card" styles={{ body: { padding: 0 } }}>
          <Table<CaseRecord>
            rowKey="_id"
            columns={columns}
            dataSource={result.items}
            pagination={false}
            scroll={{ x: 1100 }}
            rowSelection={{
              selectedRowKeys: selected.map((item) => item._id),
              onChange: (_, rows) => {
                if (rows.length > config.limits.batch) {
                  message.warning(`每次最多选择 ${config.limits.batch} 个案例`);
                  return;
                }
                setSelected(rows);
              },
            }}
          />
        </Card>
      )}

      {!loading && result.total ? (
        <div className="pagination-row">
          <Pagination
            current={page}
            pageSize={pageSize}
            total={result.total}
            showSizeChanger
            pageSizeOptions={[20, 40, 50]}
            showTotal={(total, range) => `第 ${range[0]}–${range[1]} 条，共 ${total} 条`}
            onChange={(nextPage, nextSize) => {
              setPage(nextSize === pageSize ? nextPage : 1);
              setPageSize(nextSize);
            }}
          />
        </div>
      ) : null}

      <div className="trash-no-delete">
        <DeleteOutlined />
        <span>为避免误操作，不提供一键清空；永久删除需要逐次确认。</span>
      </div>

      <Modal
        open={Boolean(purgeTarget)}
        title={`永久删除 ${purgeTarget?.items.length || 0} 个案例？`}
        okText="确认永久删除"
        okButtonProps={{
          danger: true,
          disabled: purgeConfirmation !== "永久删除" || !permanentDeleteAvailable,
          loading: purging,
        }}
        cancelText="取消"
        cancelButtonProps={{ disabled: purging }}
        closable={!purging}
        maskClosable={!purging}
        destroyOnHidden
        onCancel={() => {
          if (purging) return;
          setPurgeTarget(null);
          setPurgeConfirmation("");
        }}
        onOk={() => void permanentlyDelete()}
      >
        <div className="trash-purge-confirmation">
          <Alert
            type="error"
            showIcon
            title="案例与无引用图片将不可恢复"
            description="仍被其他案例或首页使用的图片会被安全保留。"
          />
          <div className="trash-purge-case-list">
            {purgeTarget?.items.slice(0, 5).map((item) => (
              <span key={item._id}>{item.title}（{item.caseId}）</span>
            ))}
            {(purgeTarget?.items.length || 0) > 5 ? (
              <span>另有 {(purgeTarget?.items.length || 0) - 5} 个案例</span>
            ) : null}
          </div>
          <label htmlFor="trash-purge-confirm-input">
            输入“永久删除”以确认
          </label>
          <Input
            id="trash-purge-confirm-input"
            aria-label="永久删除确认文字"
            value={purgeConfirmation}
            disabled={purging}
            autoComplete="off"
            placeholder="永久删除"
            onChange={(event) => setPurgeConfirmation(event.target.value)}
            onPressEnter={() => {
              if (purgeConfirmation === "永久删除") void permanentlyDelete();
            }}
          />
        </div>
      </Modal>
    </div>
  );
}
