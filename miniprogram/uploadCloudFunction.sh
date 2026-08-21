# 注意：本脚本只上传函数代码。inquiryNotifier 的 60 秒超时、环境变量和
# 环境级函数安全规则必须按 docs/定制需求通知与跟进部署说明.md 单独应用并回读核对。
${installPath} cloud functions deploy --e ${envId} --n quickstartFunctions --r --project ${projectPath}
${installPath} cloud functions deploy --e ${envId} --n inquiryNotifier --r --project ${projectPath}
${installPath} cloud functions deploy --e ${envId} --n userData --r --project ${projectPath}
${installPath} cloud functions deploy --e ${envId} --n userLibrary --r --project ${projectPath}
${installPath} cloud functions deploy --e ${envId} --n caseAdmin --r --project ${projectPath}
${installPath} cloud functions deploy --e ${envId} --n caseCatalog --r --project ${projectPath}
${installPath} cloud functions deploy --e ${envId} --n imageProcessor --r --project ${projectPath}
${installPath} cloud functions deploy --e ${envId} --n inquiryAdmin --r --project ${projectPath}
${installPath} cloud functions deploy --e ${envId} --n contactAdmin --r --project ${projectPath}
${installPath} cloud functions deploy --e ${envId} --n notificationAdmin --r --project ${projectPath}
${installPath} cloud functions deploy --e ${envId} --n notificationDispatcher --r --project ${projectPath}
