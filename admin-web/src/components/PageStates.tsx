import { InboxOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Result, Skeleton, Space } from "antd";

export function PageLoading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="page-state-card" aria-label="正在加载">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          active
          avatar={{ shape: "square", size: 56 }}
          paragraph={{ rows: 1, width: ["52%", "78%"] }}
          title={{ width: "34%" }}
        />
      ))}
    </div>
  );
}

export function PageError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Result
      className="page-state-card"
      status="warning"
      title="内容暂时没能加载"
      subTitle={message}
      extra={
        <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
          重新加载
        </Button>
      }
    />
  );
}

export function PageEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-state-card empty-state">
      <Empty
        image={<InboxOutlined className="empty-state-icon" />}
        description={
          <Space orientation="vertical" size={4}>
            <strong>{title}</strong>
            <span className="secondary-text">{description}</span>
          </Space>
        }
      >
        {action}
      </Empty>
    </div>
  );
}

export function WriteDisabledAlert() {
  return (
    <Alert
      showIcon
      type="warning"
      title="当前为只读验收状态"
      description="管理员写入开关尚未开启，可以浏览和筛选，但不能保存修改。"
      className="write-disabled-alert"
    />
  );
}
