import {
  AppstoreOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  HomeOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SafetyCertificateOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { Avatar, Badge, Button, Dropdown, Layout, Menu, Space, Tooltip, Typography } from "antd";
import { useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { adminApi } from "../lib/api";

const { Sider, Header, Content } = Layout;

const menuItems = [
  { key: "/cases", icon: <DatabaseOutlined />, label: "案例库" },
  { key: "/cases/upload", icon: <UploadOutlined />, label: "批量上传" },
  { key: "/homepage", icon: <HomeOutlined />, label: "首页编排" },
  { key: "/trash", icon: <AppstoreOutlined />, label: "回收站" },
];

const pageTitles: Record<string, { eyebrow: string; title: string }> = {
  "/cases": { eyebrow: "CASE LIBRARY", title: "案例管理" },
  "/cases/upload": { eyebrow: "BATCH WORKBENCH", title: "批量上传" },
  "/homepage": { eyebrow: "HOMEPAGE CURATION", title: "首页编排" },
  "/trash": { eyebrow: "RECYCLE BIN", title: "回收站" },
};

export function AdminLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const selectedKey = useMemo(() => {
    if (location.pathname.startsWith("/cases/upload")) return "/cases/upload";
    if (location.pathname.startsWith("/cases")) return "/cases";
    if (location.pathname.startsWith("/homepage")) return "/homepage";
    return "/trash";
  }, [location.pathname]);
  const page = pageTitles[selectedKey] || pageTitles["/cases"];

  const handleSignOut = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <Layout className="admin-shell">
      <Sider
        className="admin-sider"
        width={232}
        collapsedWidth={76}
        collapsed={collapsed}
        trigger={null}
      >
        <button
          type="button"
          className={`brand-lockup ${collapsed ? "is-collapsed" : ""}`}
          onClick={() => navigate("/cases")}
          aria-label="返回案例库"
        >
          <span className="brand-mark">
            <span />
          </span>
          {!collapsed ? (
            <span>
              <strong>酿艺案例库</strong>
              <small>MERCHANT STUDIO</small>
            </span>
          ) : null}
        </button>

        <Menu
          theme="dark"
          mode="inline"
          items={menuItems}
          selectedKeys={[selectedKey]}
          onClick={({ key }) => navigate(key)}
          className="admin-menu"
        />

        <div className="sider-foot">
          {!collapsed ? (
            <div className="security-note">
              <SafetyCertificateOutlined />
              <span>
                管理员专用
                <small>操作会记录账号来源</small>
              </span>
            </div>
          ) : (
            <Tooltip title="管理员专用">
              <SafetyCertificateOutlined className="sider-security-icon" />
            </Tooltip>
          )}
        </div>
      </Sider>

      <Layout className="admin-main">
        <Header className="admin-header">
          <div className="header-title-group">
            <Button
              type="text"
              className="collapse-button"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((value) => !value)}
              aria-label={collapsed ? "展开导航" : "收起导航"}
            />
            <div>
              <Typography.Text className="page-eyebrow">{page.eyebrow}</Typography.Text>
              <Typography.Title level={3}>{page.title}</Typography.Title>
            </div>
          </div>

          <Space size={16}>
            <Badge
              status={adminApi.mode === "mock" ? "warning" : "success"}
              text={adminApi.mode === "mock" ? "本地演示数据" : "CloudBase 已连接"}
              className="environment-badge"
            />
            <Dropdown
              placement="bottomRight"
              trigger={["click"]}
              menu={{
                items: [
                  {
                    key: "env",
                    icon: <CloudServerOutlined />,
                    label: adminApi.mode === "mock" ? "演示环境" : "CloudBase 环境",
                    disabled: true,
                  },
                  { type: "divider" },
                  {
                    key: "logout",
                    icon: <LogoutOutlined />,
                    label: "退出登录",
                    onClick: () => void handleSignOut(),
                  },
                ],
              }}
            >
              <button type="button" className="account-button" aria-label="管理员账户菜单">
                <Avatar>{session?.user.label.slice(0, 1) || "管"}</Avatar>
                <span>
                  <strong>{session?.user.label || "管理员"}</strong>
                  <small>{session?.user.email || "案例管理员"}</small>
                </span>
              </button>
            </Dropdown>
          </Space>
        </Header>

        <Content className="admin-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
