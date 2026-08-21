const cloud = require("wx-server-sdk");
const { createCloudbaseRepository } = require("./cloudbaseRepository");
const { createInquiryNotifierService } = require("./inquiryNotifierService");
const { createSmtpAdapter } = require("./smtpAdapter");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const repository = createCloudbaseRepository(cloud.database());
const mailer = createSmtpAdapter({ env: process.env });
const service = createInquiryNotifierService({
  repository,
  mailer,
  env: process.env,
});

exports.main = async (event = {}) => {
  try {
    return await service.handle(event);
  } catch (error) {
    // Deliberately omit the exception and event. SMTP exceptions may contain
    // credentials, recipient addresses or provider response text.
    console.error("inquiryNotifier unexpected failure");
    return {
      ok: false,
      code: "SERVER_ERROR",
      message: "需求提醒服务暂时不可用",
    };
  }
};
