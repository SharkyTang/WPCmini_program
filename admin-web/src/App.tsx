import { ConfigProvider, Result, Spin } from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  createHashRouter,
  Navigate,
  Outlet,
  RouterProvider,
} from "react-router-dom";
import { AdminLayout } from "./components/AdminLayout";
import { AdminConfigProvider } from "./context/AdminConfigContext";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { BRAND } from "./constants";
import { CasesPage } from "./pages/CasesPage";
import { HomepagePage } from "./pages/HomepagePage";
import { LoginPage } from "./pages/LoginPage";
import { TrashPage } from "./pages/TrashPage";
import { UploadPage } from "./pages/UploadPage";

function ProtectedApp() {
  const { session, loading } = useAuth();
  if (loading) {
    return (
      <div className="app-bootstrap">
        <Spin size="large" />
        <span>正在确认管理员身份…</span>
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  return (
    <AdminConfigProvider>
      <Outlet />
    </AdminConfigProvider>
  );
}

function LoginRoute() {
  const { session, loading } = useAuth();
  if (loading) {
    return (
      <div className="app-bootstrap">
        <Spin size="large" />
      </div>
    );
  }
  return session ? <Navigate to="/cases" replace /> : <LoginPage />;
}

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: BRAND.goldDark,
          colorInfo: BRAND.goldDark,
          colorSuccess: "#55745b",
          colorWarning: "#b87932",
          colorError: BRAND.red,
          colorText: BRAND.ink,
          colorTextSecondary: BRAND.inkSoft,
          colorBgBase: BRAND.paper,
          colorBorder: BRAND.line,
          borderRadius: 8,
          fontFamily:
            '"Inter", "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif',
        },
        components: {
          Layout: {
            bodyBg: BRAND.cream,
            headerBg: BRAND.paper,
            siderBg: BRAND.ink,
          },
          Menu: {
            darkItemBg: BRAND.ink,
            darkItemSelectedBg: "rgba(179, 138, 74, .22)",
            darkItemSelectedColor: "#f5dba9",
          },
          Table: {
            headerBg: "#f7f2ea",
            headerColor: BRAND.inkSoft,
            rowHoverBg: "#fcf8f1",
          },
        },
      }}
    >
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ConfigProvider>
  );
}

// CloudBase default static-hosting domains do not provide a reliable history
// fallback: rewriting a missing route to index.html can recurse into the same
// 404 rule. Hash routing keeps every refresh on the real root document while
// preserving the app's internal route paths and deep-link behavior.
const router = createHashRouter([
  {
    path: "/login",
    element: <LoginRoute />,
  },
  {
    element: <ProtectedApp />,
    children: [
      {
        element: <AdminLayout />,
        children: [
          { path: "/cases", element: <CasesPage /> },
          { path: "/cases/upload", element: <UploadPage /> },
          { path: "/cases/:id/edit", element: <CasesPage /> },
          { path: "/homepage", element: <HomepagePage /> },
          { path: "/trash", element: <TrashPage /> },
        ],
      },
    ],
  },
  { path: "/", element: <Navigate to="/cases" replace /> },
  {
    path: "*",
    element: (
      <Result
        status="404"
        title="页面不存在"
        subTitle="这个管理页面可能已被移动。"
      />
    ),
  },
]);
