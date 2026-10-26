const {
  isEmailAddress,
  isNotifierEnabled,
} = require("./inquiryNotifierLogic");

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePort(value) {
  const port = Number(value || 465);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function parseTimeout(value, fallback) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout >= 1000 && timeout <= 60 * 1000
    ? Math.floor(timeout)
    : fallback;
}

function parseSecure(value, port) {
  const normalized = trimText(value).toLowerCase();
  if (!normalized) return { valid: true, value: port === 465 };
  if (normalized === "true") return { valid: true, value: true };
  if (normalized === "false") return { valid: true, value: false };
  return { valid: false, value: false };
}

function readSmtpConfiguration(env = {}) {
  const enabled = isNotifierEnabled(env);
  if (!enabled) {
    return { enabled: false, ready: false, reason: "feature_disabled" };
  }

  const host = trimText(env.INQUIRY_SMTP_HOST);
  const port = parsePort(env.INQUIRY_SMTP_PORT);
  const user = trimText(env.INQUIRY_SMTP_USER);
  const pass = trimText(env.INQUIRY_SMTP_PASS);
  const from = trimText(env.INQUIRY_SMTP_FROM);
  const secure = parseSecure(env.INQUIRY_SMTP_SECURE, port);
  const ready = Boolean(
    host
    && port
    && user
    && pass
    && isEmailAddress(from)
    && secure.valid
  );
  if (!ready) {
    return { enabled: true, ready: false, reason: "smtp_not_configured" };
  }

  return {
    enabled: true,
    ready: true,
    reason: "",
    host,
    port,
    secure: secure.value,
    user,
    pass,
    from,
    connectionTimeout: parseTimeout(env.INQUIRY_SMTP_CONNECTION_TIMEOUT_MS, 10 * 1000),
    greetingTimeout: parseTimeout(env.INQUIRY_SMTP_GREETING_TIMEOUT_MS, 10 * 1000),
    socketTimeout: parseTimeout(env.INQUIRY_SMTP_SOCKET_TIMEOUT_MS, 15 * 1000),
  };
}

function getSmtpConfigurationStatus(env = {}) {
  const config = readSmtpConfiguration(env);
  return {
    enabled: config.enabled,
    ready: config.ready,
    reason: config.reason,
  };
}

function createDisabledAdapter(reason) {
  return {
    isReady() {
      return false;
    },
    getStatus() {
      return { ready: false, reason };
    },
    async send() {
      const error = new Error("mail transport is disabled");
      error.code = "MAIL_DISABLED";
      throw error;
    },
  };
}

function createSmtpAdapter(options = {}) {
  const env = options.env || {};
  const config = readSmtpConfiguration(env);
  if (!config.ready) return createDisabledAdapter(config.reason);

  // Keep the dependency lazy: with the feature flag off or incomplete
  // configuration, a legacy runtime can load safely without touching SMTP.
  const transportFactory = options.transportFactory || ((transportOptions) => {
    const nodemailer = require("nodemailer");
    return nodemailer.createTransport(transportOptions);
  });
  const transport = transportFactory({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    connectionTimeout: config.connectionTimeout,
    greetingTimeout: config.greetingTimeout,
    socketTimeout: config.socketTimeout,
  });

  return {
    isReady() {
      return true;
    },
    getStatus() {
      return { ready: true, reason: "" };
    },
    async send(message = {}) {
      const recipient = trimText(message.recipient);
      if (!isEmailAddress(recipient)) {
        const error = new Error("invalid recipient");
        error.code = "INVALID_RECIPIENT";
        throw error;
      }
      const result = await transport.sendMail({
        from: config.from,
        to: recipient,
        subject: trimText(message.subject),
        text: trimText(message.text),
        messageId: trimText(message.messageId) || undefined,
        headers: {
          "X-Inquiry-Notification": trimText(message.reference),
        },
      });
      return {
        accepted: Array.isArray(result && result.accepted)
          ? result.accepted.length > 0
          : true,
      };
    },
  };
}

module.exports = {
  createSmtpAdapter,
  getSmtpConfigurationStatus,
};
