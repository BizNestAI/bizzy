const SUPPORTED_QBO_REPORT_BASES = new Map([
  ["cash", "Cash"],
  ["accrual", "Accrual"],
]);

export class QboReportBasisError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "QboReportBasisError";
    this.code = code;
    this.details = details;
  }
}

export function extractAuthoritativeQboReportBasis(report) {
  const headers = reportHeaders(report);
  if (headers.length === 0) throw new QboReportBasisError("qbo_report_header_missing");

  const candidates = [];
  for (const { header, source } of headers) {
    collectDirectCandidate(candidates, header, source);
    collectOptionCandidates(candidates, header, source, "Option");
    collectOptionCandidates(candidates, header, source, "Options");
  }

  if (candidates.length === 0) throw new QboReportBasisError("qbo_report_basis_unproven");
  if (candidates.some((candidate) => candidate.malformed)) {
    throw new QboReportBasisError("qbo_report_basis_malformed", {
      sources: candidates.map((candidate) => candidate.source),
    });
  }

  const normalized = candidates.map((candidate) => normalizeBasis(candidate.value));
  if (normalized.some((basis) => !basis)) {
    throw new QboReportBasisError("qbo_report_basis_unsupported", {
      sources: candidates.map((candidate) => candidate.source),
    });
  }
  if (new Set(normalized).size !== 1) {
    throw new QboReportBasisError("qbo_report_basis_conflicting", {
      sources: candidates.map((candidate) => candidate.source),
    });
  }
  return normalized[0];
}

function reportHeaders(report) {
  const headers = [];
  if (report?.Header && typeof report.Header === "object" && !Array.isArray(report.Header)) {
    headers.push({ header: report.Header, source: "Header" });
  }
  if (report?.ReportHeader && typeof report.ReportHeader === "object" && !Array.isArray(report.ReportHeader)) {
    headers.push({ header: report.ReportHeader, source: "ReportHeader" });
  }
  return headers;
}

function collectDirectCandidate(candidates, header, source) {
  if (!Object.prototype.hasOwnProperty.call(header, "ReportBasis")) return;
  const value = header.ReportBasis;
  candidates.push({ source: `${source}.ReportBasis`, value, malformed: !isScalarBasis(value) });
}

function collectOptionCandidates(candidates, header, source, key) {
  if (!Object.prototype.hasOwnProperty.call(header, key)) return;
  const rawOptions = header[key];
  const options = Array.isArray(rawOptions)
    ? rawOptions
    : rawOptions && typeof rawOptions === "object"
      ? [rawOptions]
      : [];
  for (const option of options) {
    if (!option || typeof option !== "object" || Array.isArray(option)) continue;
    const name = String(option.Name ?? option.name ?? "").replace(/[_\s-]/g, "").toLowerCase();
    if (name !== "reportbasis") continue;
    const hasValue = Object.prototype.hasOwnProperty.call(option, "Value") || Object.prototype.hasOwnProperty.call(option, "value");
    const value = option.Value ?? option.value;
    candidates.push({ source: `${source}.${key}.ReportBasis`, value, malformed: !hasValue || !isScalarBasis(value) });
  }
}

function isScalarBasis(value) {
  return (typeof value === "string" || typeof value === "number") && String(value).trim().length > 0;
}

function normalizeBasis(value) {
  return SUPPORTED_QBO_REPORT_BASES.get(String(value).trim().toLowerCase()) || null;
}
