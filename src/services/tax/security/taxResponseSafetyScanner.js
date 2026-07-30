import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MAX_PREVIEW = 140;

const SENSITIVE_KEY_PATTERNS = [
  { category: "credentials", pattern: /^(access_token|refresh_token|service_role|service_role_key|supabase_service_role_key|client_secret|plaid_access_token|qbo_access_token|qbo_refresh_token|authorization)$/i },
  { category: "credentials", pattern: /(password|private[_-]?key|secret)$/i },
  { category: "financial_identifier", pattern: /^(routing_number|account_number|full_account_number|qbo_realm_secret)$/i },
  { category: "raw_source_payload", pattern: /^(raw|raw_payload|source_payload|payload|response|counterparties)$/i, requiresContext: /(plaid|qbo|bank_transactions|qbo_posted_transactions|integration|source)/i },
  { category: "internal_implementation", pattern: /^(stack|stacktrace|sql|query|system_prompt|private_prompt)$/i },
];

const VALUE_PATTERNS = [
  { category: "credentials", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i, label: "bearer token" },
  { category: "credentials", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, label: "JWT-like token" },
  { category: "credentials", pattern: /\b(?:sk|pk|rk|sb_secret|supabase)_[A-Za-z0-9_]{16,}\b/i, label: "secret-like token" },
  { category: "credentials", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/i, label: "private key" },
  { category: "raw_source_payload", pattern: /"plaid_access_token"|"qbo_refresh_token"|"counterparties"\s*:\s*\[|"raw"\s*:\s*\{|"source_payload"\s*:\s*\{/i, label: "raw integration payload" },
  { category: "internal_implementation", pattern: /\bat\s+[\w.<>]+\s+\([^)]*:\d+:\d+\)/, label: "stack trace" },
  { category: "internal_implementation", pattern: /\/Users\/[^/\s]+\/|node_modules\/|\/src\/api\/|\/src\/services\//, label: "filesystem path" },
  { category: "internal_implementation", pattern: /\b(select|insert|update|delete)\s+.+\s+(from|into|set)\s+public\./i, label: "SQL statement" },
  { category: "internal_implementation", pattern: /relation\s+"?[\w.]+\"?\s+does not exist|SQLSTATE|syntax error at or near|PostgREST|PGRST\d+/i, label: "database internal error" },
  { category: "internal_implementation", pattern: /You are (?:Codex|ChatGPT)|system prompt|developer instructions/i, label: "private prompt text" },
  { category: "financial_identifier", pattern: /\b\d{9,17}\b/, label: "full account/routing-like number", guard: isLikelyFinancialIdentifier },
];

const CSV_FORMULA_PATTERN = /(?:^|[\n,])\s*"?[=+\-@][^",\n]*/;

export function scanTaxResponseSafety({
  name = "response",
  status = null,
  headers = {},
  body = null,
  filename = null,
  contentType = null,
  allowlist = DEFAULT_ALLOWLIST,
} = {}) {
  const findings = [];
  const add = (finding) => findings.push({ name, status, ...finding });

  scanHeaders({ headers, add, allowlist });
  if (filename) scanString({ value: filename, path: "$filename", add, allowlist });
  if (typeof body === "string") {
    scanString({ value: body, path: "$body", add, allowlist });
    if (isCsv(contentType, filename) && CSV_FORMULA_PATTERN.test(body)) {
      add({ category: "csv_injection", severity: "high", path: "$body", preview: "Possible unsafe CSV formula cell." });
    }
    const parsed = parseMaybeJson(body);
    if (parsed != null) scanJson({ value: parsed, path: "$body", add, allowlist });
  } else if (body != null) {
    scanJson({ value: body, path: "$body", add, allowlist });
  }

  return {
    name,
    status,
    safe: findings.length === 0,
    findings,
  };
}

export function scanTaxApiError(error) {
  return scanTaxResponseSafety({
    name: "frontend_api_error",
    body: {
      name: error?.name,
      code: error?.code,
      message: error?.message,
      status: error?.status,
      details: error?.details,
      action: error?.action,
      requestId: error?.requestId,
    },
  });
}

export function runStaticTaxOutputSafetyScan({ root = process.cwd() } = {}) {
  const targets = [
    "src/api/tax",
    "src/services/tax",
    "src/components/Tax",
    "src/hooks/tax",
    "src/hooks/useTaxLiability.js",
    "src/hooks/useDeductionsMatrix.js",
  ];
  const findings = [];
  for (const target of targets) {
    for (const file of listFiles(join(root, target))) {
      const text = readFileSync(file, "utf8");
      const rel = relative(root, file);
      scanSourceText(rel, text, findings);
    }
  }
  return {
    status: findings.some((finding) => finding.severity === "critical" || finding.severity === "high") ? "fail" : "pass",
    findings,
  };
}

function scanHeaders({ headers, add, allowlist }) {
  const entries = headers instanceof Headers
    ? Array.from(headers.entries())
    : Object.entries(headers || {});
  for (const [key, value] of entries) {
    const path = `$headers.${key}`;
    if (isAllowedPath(path, allowlist)) continue;
    if (/set-cookie|authorization|x-supabase|service|token/i.test(key)) {
      add({ category: "credentials", severity: "critical", path, preview: redact(value) });
      continue;
    }
    scanString({ value: String(value), path, add, allowlist });
  }
}

function scanJson({ value, path, add, allowlist }) {
  if (isAllowedPath(path, allowlist)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanJson({ value: item, path: `${path}[${index}]`, add, allowlist }));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      scanPropertyName({ key, path: childPath, add, allowlist });
      scanJson({ value: child, path: childPath, add, allowlist });
    }
    return;
  }
  if (typeof value === "string") scanString({ value, path, add, allowlist });
  if (typeof value === "number") scanString({ value: String(value), path, add, allowlist });
}

function scanPropertyName({ key, path, add, allowlist }) {
  if (isAllowedPath(path, allowlist)) return;
  for (const rule of SENSITIVE_KEY_PATTERNS) {
    if (!rule.pattern.test(key)) continue;
    if (rule.requiresContext && !rule.requiresContext.test(path)) continue;
    add({ category: rule.category, severity: "high", path, preview: redactKey(key) });
  }
}

function scanString({ value, path, add, allowlist }) {
  if (!value || isAllowedPath(path, allowlist)) return;
  for (const rule of VALUE_PATTERNS) {
    if (!rule.pattern.test(value)) continue;
    if (rule.guard && !rule.guard(value, path)) continue;
    add({ category: rule.category, severity: severityFor(rule.category), path, preview: `${rule.label}: ${redact(value)}` });
  }
}

function scanSourceText(file, text, findings) {
  const checks = [
    { pattern: /res\.json\s*\(\s*err\s*\)/, severity: "critical", category: "unsafe_error_envelope", message: "Route may serialize raw error object." },
    { pattern: /err\.stack|stack\s*:/, severity: "critical", category: "stack_exposure", message: "Tax code references stack output." },
    { pattern: /\.select\s*\(\s*["'`][^"'`]*(?:raw|payload|response)[^"'`]*["'`]\s*\)/, severity: "high", category: "raw_source_select", message: "Tax code selects raw/payload/response fields." },
    { pattern: /console\.(?:log|error|warn)\s*\([^)]*(?:token|authorization|payload|raw|headers|stack)/i, severity: "high", category: "unsafe_logging", message: "Tax code may log sensitive response data." },
    { pattern: /error\.details|err\?\.details|details:\s*err/i, severity: "medium", category: "error_details_rendering", message: "Tax code references error details; runtime scanner verifies exposure." },
  ];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const check of checks) {
      if (!check.pattern.test(line)) continue;
      findings.push({
        file,
        line: index + 1,
        category: check.category,
        severity: check.severity,
        message: check.message,
        preview: redact(line.trim()).slice(0, MAX_PREVIEW),
      });
    }
  });
}

function isLikelyFinancialIdentifier(value, path) {
  if (/(runId|businessId|transactionId|paymentId|year|date|amount|taxYear|requestId|dedupe|fingerprint)/i.test(path)) return false;
  const digits = String(value).replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 17) return false;
  if (/^0+$|^1+$|^9+$/.test(digits)) return false;
  return true;
}

function isCsv(contentType, filename) {
  return /csv/i.test(String(contentType || "")) || /\.csv$/i.test(String(filename || ""));
}

function parseMaybeJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isAllowedPath(path, allowlist) {
  return allowlist.some((rule) => rule.test(path));
}

function severityFor(category) {
  if (category === "credentials") return "critical";
  if (category === "financial_identifier") return "high";
  return "high";
}

function redactKey(key) {
  return `${key.replace(/./g, "*")} property`;
}

export function redact(value) {
  return String(value || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[jwt-redacted]")
    .replace(/\b(?:sk|pk|rk|sb_secret|supabase)_[A-Za-z0-9_]{12,}\b/gi, "[secret-redacted]")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/gi, "[private-key-redacted]")
    .slice(0, MAX_PREVIEW);
}

function listFiles(target) {
  try {
    const stat = statSync(target);
    if (stat.isFile()) return target.endsWith(".js") || target.endsWith(".jsx") ? [target] : [];
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(target)) {
    const full = join(target, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...listFiles(full));
    else if (/\.(js|jsx)$/.test(entry)) files.push(full);
  }
  return files;
}

const DEFAULT_ALLOWLIST = [
  /\$body\.(?:data\.)?links\./,
  /\$body\.(?:data\.)?actions\[\d+\]\.payload\./,
  /\$body\.(?:data\.)?metadata\.route$/,
  /\$body\.(?:data\.)?(?:runId|businessId|transactionId|paymentId|reserveAccountId|requestId|ruleId|id)$/,
  /\$headers\.(?:content-type|content-length|cache-control|content-disposition|x-request-id|x-correlation-id|date|etag)$/i,
];

export default {
  scanTaxResponseSafety,
  scanTaxApiError,
  runStaticTaxOutputSafetyScan,
  redact,
};
