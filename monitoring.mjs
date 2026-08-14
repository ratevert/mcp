import * as Sentry from "@sentry/node";

function safeIdentifier(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.replace(/[^a-zA-Z0-9_$./:-]/g, "").slice(0, 120);
  return normalized || fallback;
}

function safeFrame(frame) {
  const filename =
    typeof frame?.filename === "string"
      ? frame.filename.replace(/\\/g, "/").split("/").slice(-4).join("/")
      : undefined;

  return {
    colno: typeof frame?.colno === "number" ? frame.colno : undefined,
    filename,
    function: safeIdentifier(frame?.function, "<anonymous>"),
    in_app: frame?.in_app === true,
    lineno: typeof frame?.lineno === "number" ? frame.lineno : undefined,
  };
}

function sanitizeEvent(event) {
  const environment = process.env.DEPLOY_ENVIRONMENT ?? "production";
  const values = event.exception?.values?.map((exception) => ({
    stacktrace: exception.stacktrace?.frames
      ? { frames: exception.stacktrace.frames.map(safeFrame) }
      : undefined,
    type: safeIdentifier(exception.type, "Error"),
    value: "Redacted",
  }));

  return {
    environment,
    exception: values ? { values } : undefined,
    level: event.level ?? "error",
    platform: event.platform,
    release: process.env.RATEVERT_BUILD_SHA,
    sdk: event.sdk,
    tags: { environment, product: "ratevert", service: "mcp" },
    timestamp: event.timestamp,
  };
}

export function initializeMcpMonitoring() {
  const dsn = process.env.GLITCHTIP_DSN;

  if (!dsn || process.env.NODE_ENV !== "production") {
    return false;
  }

  Sentry.init({
    beforeBreadcrumb: () => null,
    beforeSend: sanitizeEvent,
    dsn,
    enableLogs: false,
    includeServerName: false,
    release: process.env.RATEVERT_BUILD_SHA,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });

  return true;
}

export function captureUnexpectedMcpError(error) {
  Sentry.captureException(error);
}
