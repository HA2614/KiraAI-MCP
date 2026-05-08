const verboseHttpRequests = /^(1|true|yes)$/i.test(process.env.LOG_HTTP_REQUESTS || "");

function sanitizeValue(value) {
  if (typeof value === "string") {
    return value
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]")
      .replace(/\bDATABASE_URL=\S+/gi, "DATABASE_URL=[hidden]");
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nextValue]) => [key, sanitizeValue(nextValue)]));
  }
  return value;
}

function compactContext(context = {}) {
  const sanitized = sanitizeValue(context);
  return Object.entries(sanitized)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
    .join(" ");
}

function formatLine(level, event, context = {}) {
  if (event === "api_started") {
    return `KiraAI backend ready at ${context.url || "configured port"}`;
  }
  const details = compactContext(context);
  return `${level.toUpperCase()} ${event}${details ? ` | ${details}` : ""}`;
}

export function logEvent(level, event, context = {}) {
  if (event === "http_request" && !verboseHttpRequests && Number(context.statusCode || 0) < 400) {
    return;
  }
  const line = formatLine(level, event, context);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function logInfo(event, context) {
  logEvent("info", event, context);
}

export function logWarn(event, context) {
  logEvent("warn", event, context);
}

export function logError(event, context) {
  logEvent("error", event, context);
}
