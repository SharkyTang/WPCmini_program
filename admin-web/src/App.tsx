import { ConfigProvider, Result, Spin } from "antd";
import zhCN from "antd/locale/zh_CN";
import { lazy, Suspense, type ReactNode } from "react";
import {
  createHashRouter,
  Navigate,
  Outlet,
  RouterProvider,
} from "react-router-dom";
import { AdminConfigProvider } from "./context/AdminConfigContext";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { BRAND } from "./constants";

const AdminLayout = lazy(() =>
  import("./components/AdminLayout").then(({ AdminLayout }) => ({ default: AdminLayout })),
);
const CasesPage = lazy(() =>
  import("./pages/CasesPage").then(({ CasesPage }) => ({ default: CasesPage })),
);
const HomepagePage = lazy(() =>
  import("./pages/HomepagePage").then(({ HomepagePage }) => ({ default: HomepagePage })),
);
const LoginPage = lazy(() =>
  import("./pages/LoginPage").then(({ LoginPage }) => ({ default: LoginPage })),
);
const TrashPage = lazy(() =>
  import("./pages/TrashPage").then(({ TrashPage }) => ({ default: TrashPage })),
);
const UploadPage = lazy(() =>
  import("./pages/UploadPage").then(({ UploadPage }) => ({ default: UploadPage })),
);

function RouteLoading() {
  return (
    <div className="app-bootstrap" role="status" aria-live="polite">
      <Spin size="large" />
      <span>页面加载中…</span>
    </div>
  );
}

function RouteSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteLoading />}>{children}</Suspense>;
}

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
  return session ? (
    <Navigate to="/cases" replace />
  ) : (
    <RouteSuspense>
      <LoginPage />
    </RouteSuspense>
  );
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
        element: (
          <RouteSuspense>
            <AdminLayout />
          </RouteSuspense>
        ),
        children: [
          {
            path: "/cases",
            element: (
              <RouteSuspense>
                <CasesPage />
              </RouteSuspense>
            ),
          },
          {
            path: "/cases/upload",
            element: (
              <RouteSuspense>
                <UploadPage />
              </RouteSuspense>
            ),
          },
          {
            path: "/cases/:id/edit",
            element: (
              <RouteSuspense>
                <CasesPage />
              </RouteSuspense>
            ),
          },
          {
            path: "/homepage",
            element: (
              <RouteSuspense>
                <HomepagePage />
              </RouteSuspense>
            ),
          },
          {
            path: "/trash",
            element: (
              <RouteSuspense>
                <TrashPage />
              </RouteSuspense>
            ),
          },
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
