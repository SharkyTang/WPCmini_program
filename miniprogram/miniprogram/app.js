// app.js
const {
  getMiniProgramEnvVersion,
  resolveCloudEnvironment,
} = require("./envList");
const { reportClientFault } = require("./utils/errorTelemetry");

const HOME_ROUTE = "/pages/index/index";

App({
  onLaunch: function () {
    const envVersion = getMiniProgramEnvVersion(wx);
    const cloudEnvironment = resolveCloudEnvironment(envVersion);
    this.globalData = {
      // env 参数说明：
      // env 参数决定接下来小程序发起的云开发调用（wx.cloud.xxx）会请求到哪个云环境的资源
      // 此处请填入环境 ID, 环境 ID 可在微信开发者工具右上顶部工具栏点击云开发按钮打开获取
      env: cloudEnvironment,
      envVersion,
      caseDataVersion: 0,
      cloudReady: false,
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      reportClientFault({
        type: "cloud_init_error",
        stage: "capability_check",
        code: "CLOUD_UNSUPPORTED",
        envVersion,
      });
    } else if (!cloudEnvironment) {
      console.error("无法确认小程序运行版本，云开发未初始化");
      reportClientFault({
        type: "cloud_init_error",
        stage: "environment_detection",
        code: "UNKNOWN_ENV_VERSION",
        envVersion: "unknown",
      });
    } else {
      try {
        const initResult = wx.cloud.init({
          env: this.globalData.env,
          traceUser: true,
        });
        if (initResult && typeof initResult.then === "function") {
          this.globalData.cloudReady = false;
          Promise.resolve(initResult).then(
            () => {
              this.globalData.cloudReady = true;
            },
            (error) => {
              this.globalData.cloudReady = false;
              console.error("云开发初始化失败", error);
              reportClientFault({
                type: "cloud_init_error",
                stage: "cloud_init_async",
                error,
                envVersion,
              });
            }
          );
        } else {
          this.globalData.cloudReady = true;
        }
      } catch (error) {
        this.globalData.cloudReady = false;
        console.error("云开发初始化失败", error);
        reportClientFault({
          type: "cloud_init_error",
          stage: "cloud_init",
          error,
          envVersion,
        });
      }
    }
  },

  onError(error) {
    reportClientFault({
      type: "app_error",
      stage: "app_on_error",
      error,
      envVersion: this.globalData && this.globalData.envVersion,
    });
  },

  onUnhandledRejection(event = {}) {
    const reason = event && typeof event === "object" && "reason" in event
      ? event.reason
      : event;
    reportClientFault({
      type: "unhandled_rejection",
      stage: "app_unhandled_rejection",
      error: reason,
      envVersion: this.globalData && this.globalData.envVersion,
    });
  },

  onPageNotFound(event = {}) {
    event = event || {};
    const missingRoute = event.path || "unknown";
    reportClientFault({
      type: "page_not_found",
      stage: "route_resolve",
      code: "PAGE_NOT_FOUND",
      route: missingRoute,
      envVersion: this.globalData && this.globalData.envVersion,
    });

    const normalizedPath = String(missingRoute).split(/[?#]/, 1)[0];
    if (
      normalizedPath === HOME_ROUTE ||
      normalizedPath === HOME_ROUTE.slice(1) ||
      typeof wx.reLaunch !== "function"
    ) {
      return;
    }
    try {
      wx.reLaunch({
        url: HOME_ROUTE,
        fail: (error) => {
          reportClientFault({
            type: "page_not_found_redirect_error",
            stage: "route_fallback",
            error,
            route: HOME_ROUTE,
            envVersion: this.globalData && this.globalData.envVersion,
          });
        },
      });
    } catch (error) {
      reportClientFault({
        type: "page_not_found_redirect_error",
        stage: "route_fallback",
        error,
        route: HOME_ROUTE,
        envVersion: this.globalData && this.globalData.envVersion,
      });
    }
  },
});
