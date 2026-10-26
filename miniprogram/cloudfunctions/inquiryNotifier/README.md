# inquiryNotifier

Low-frequency administrator email alerts for new customization inquiries. The
function is inert unless the feature flag and every required setting are valid.

## Entrypoints

- Timer event (`Type: "Timer"`): drains durable oldest-first
  `alertTaskStatus: "pending"` markers with bounded concurrency, repairs
  partial deterministic job creation, and processes a bounded due-job batch.
- Kick (`{ action: "kick", inquiryId }`): creates the same jobs and attempts the
  two due-at-once primary jobs independently. Repeated calls are idempotent.
- Health (`{ action: "health" }`): returns only `ready/disabled` and a sanitized
  configuration reason; it performs no database read or SMTP connection.

Unknown actions do not run the scanner. The function returns aggregate status
only and never returns inquiry details, recipient addresses, or SMTP responses.

## Environment

Required before enabling:

- `INQUIRY_EMAIL_ALERTS_ENABLED=true`
- `INQUIRY_NOTIFY_PRIMARY_EMAIL`
- `INQUIRY_NOTIFY_PRIMARY_EMAIL_2`
- `INQUIRY_NOTIFY_BACKUP_EMAIL`
- `INQUIRY_SMTP_HOST`
- `INQUIRY_SMTP_PORT` (defaults to `465`)
- `INQUIRY_SMTP_SECURE` (defaults to `true` for port 465)
- `INQUIRY_SMTP_USER`
- `INQUIRY_SMTP_PASS`
- `INQUIRY_SMTP_FROM` (plain email address)
- `INQUIRY_NOTIFIER_INTERNAL_TOKEN` (high-entropy shared secret)

`INQUIRY_NOTIFIER_ENABLED` is accepted only as a legacy alias when the primary
feature flag is absent. Optional timeout settings are
`INQUIRY_SMTP_CONNECTION_TIMEOUT_MS`, `INQUIRY_SMTP_GREETING_TIMEOUT_MS`, and
`INQUIRY_SMTP_SOCKET_TIMEOUT_MS` (1-60 seconds).

Keep SMTP credentials in CloudBase function environment variables. Do not place
them in source, database records, invocation payloads, or logs.
Configure the same `INQUIRY_NOTIFIER_INTERNAL_TOKEN` in the trusted caller
functions. `health` and `kick` calls must send it as `internalToken`; the timer
trigger must send the exact value as its `Message`. Missing or mismatched values
fail closed before any database or SMTP work. The comparison hashes both inputs
before Node.js `timingSafeEqual`, and the token is never returned to clients.
All three recipient addresses are required, must be valid, and must be pairwise
distinct. Each recipient owns an independent durable job and SMTP delivery.

## Data contract

Create the server-only collection `inquiry_alert_jobs`. Job documents store only
an internal inquiry ID, normalized source, submission/stage timestamps,
stage/role, lease state, attempt count, and sanitized error codes. They do not
store recipient addresses or inquiry content.

Every terminal job transaction also updates the parent inquiry's safe aggregate
`emailNotificationStatus` and `emailNotificationUpdatedAt`. Only the terminal
status and timestamp are copied: recipient addresses and error details remain in
the server-only job collection. Any `failed`, `permanent_failed`, or
`delivery_unknown` result is sticky, so a later successful stage cannot hide the
administrator-facing “邮件通知异常” marker.

Stages are both primary recipients immediately, backup at five minutes, then
all three recipients at fifteen minutes. Any claim, first reply, or closed
inquiry cancels later work. Transient failures retry after 30 seconds, 2
minutes, and 5 minutes. Permanent failures do not retry. SMTP timeouts and
expired post-claim leases are `delivery_unknown` and are not resent because the
provider may already have accepted the message.
