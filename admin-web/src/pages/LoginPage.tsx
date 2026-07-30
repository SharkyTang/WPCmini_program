import {
  ArrowRightOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Alert, Button, Form, Input, Space, Typography } from "antd";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { adminApi, isDemoMode } from "../lib/api";
import { getDemoCredentials } from "../lib/demoConfig";
import { getErrorMessage } from "../lib/errors";

interface LoginValues {
  account: string;
  password: string;
}

export function LoginPage() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const demoCredentials = getDemoCredentials();

  const submit = async (values: LoginValues) => {
    setSubmitting(true);
    setError("");
    try {
      await signIn(values.account, values.password);
      const from = (location.state as { from?: string } | null)?.from || "/cases";
      navigate(from, { replace: true });
    } catch (reason) {
      setError(getErrorMessage(reason, "登录失败，请稍后重试"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-showcase" aria-label="案例管理后台介绍">
        <div className="login-brand">
          <span className="brand-mark brand-mark-light">
            <span />
          </span>
          <span>
            <strong>酿艺案例库</strong>
            <small>MERCHANT STUDIO</small>
          </span>
        </div>

        <div className="login-showcase-copy">
          <Typography.Text className="login-kicker">DESKTOP CASE OPERATIONS</Typography.Text>
          <Typography.Title>把案例管理，<br />变成一件利落的事。</Typography.Title>
          <Typography.Paragraph>
            批量上传、复合筛选、首页编排与回收恢复，都在一个为桌面效率设计的工作台里完成。
          </Typography.Paragraph>
          <div className="login-feature-row">
            <span>批量处理</span>
            <span>精确筛选</span>
            <span>安全留痕</span>
          </div>
        </div>

        <div className="packaging-scene" aria-hidden="true">
          <div className="package-box">
            <span className="package-border" />
            <strong>山河酿</strong>
            <small>典藏 · 2026</small>
          </div>
          <div className="package-bottle">
            <span className="bottle-cap" />
            <span className="bottle-label">酿</span>
          </div>
          <div className="scene-disc" />
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <Space orientation="vertical" size={5}>
            <Typography.Text className="page-eyebrow">ADMIN ACCESS</Typography.Text>
            <Typography.Title level={2}>欢迎回来</Typography.Title>
            <Typography.Paragraph className="secondary-text">
              使用 CloudBase 中预先创建的管理员账号登录。
            </Typography.Paragraph>
          </Space>

          {!adminApi.configured ? (
            <Alert
              type="error"
              showIcon
              title="尚未配置 CloudBase"
              description="请配置 VITE_CLOUDBASE_ENV_ID 与 VITE_CLOUDBASE_PUBLISHABLE_KEY，或在本地启用演示模式。"
            />
          ) : null}
          {isDemoMode() ? (
            <Alert
              type="warning"
              showIcon
              title="本地演示模式"
              description={
                <span>
                  账号 <code>{demoCredentials.account}</code>　密码{" "}
                  <code>{demoCredentials.password}</code>
                </span>
              }
            />
          ) : null}
          {error ? <Alert type="error" showIcon title={error} closable onClose={() => setError("")} /> : null}

          <Form<LoginValues>
            layout="vertical"
            size="large"
            requiredMark={false}
            initialValues={
              isDemoMode()
                ? demoCredentials
                : undefined
            }
            onFinish={(values) => void submit(values)}
          >
            <Form.Item
              label="管理员账号"
              name="account"
              rules={[{ required: true, message: "请输入用户名、邮箱或手机号" }]}
            >
              <Input
                prefix={<UserOutlined />}
                autoComplete="username"
                placeholder="用户名 / 邮箱 / 手机号"
              />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                autoComplete="current-password"
                placeholder="输入管理员密码"
              />
            </Form.Item>
            <Button
              block
              type="primary"
              htmlType="submit"
              loading={submitting}
              disabled={!adminApi.configured}
              icon={<ArrowRightOutlined />}
              iconPlacement="end"
            >
              进入管理后台
            </Button>
          </Form>

          <div className="login-security">
            <SafetyCertificateOutlined />
            <span>仅授权管理员可访问，所有写入操作均由云函数再次校验身份。</span>
          </div>
        </div>
      </section>
    </main>
  );
}
