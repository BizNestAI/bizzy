export const ACCOUNTING_DOCUMENT_START_YEAR = 2026;
export const ACCOUNTING_DOCUMENT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const ACCOUNTING_DOCUMENT_ALLOWED_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "csv", "xls", "xlsx"]);

export const ACCOUNTING_DOCUMENT_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function getAccountingDocumentYears(currentYear = new Date().getFullYear()) {
  const end = Math.max(ACCOUNTING_DOCUMENT_START_YEAR, Number(currentYear) || ACCOUNTING_DOCUMENT_START_YEAR);
  return Array.from({ length: end - ACCOUNTING_DOCUMENT_START_YEAR + 1 }, (_, index) => ACCOUNTING_DOCUMENT_START_YEAR + index);
}

export function buildAccountingMonthFolders(docs = []) {
  const counts = new Map();
  for (const doc of docs || []) {
    const month = Number(doc?.month || doc?.accounting_month || doc?.content?.accounting_document?.month);
    if (month >= 1 && month <= 12) counts.set(month, (counts.get(month) || 0) + 1);
  }
  return ACCOUNTING_DOCUMENT_MONTHS.map((name, index) => {
    const month = index + 1;
    return { month, name, count: counts.get(month) || 0 };
  });
}

export function accountingDocumentExtension(file = {}) {
  const name = String(file.name || "");
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
}

export function validateAccountingDocumentFile(file) {
  if (!file) return "Choose a file.";
  const ext = accountingDocumentExtension(file);
  if (!ACCOUNTING_DOCUMENT_ALLOWED_EXTENSIONS.has(ext)) return "Unsupported file type. Upload PDF, PNG, JPG, CSV, XLS, or XLSX.";
  if (file.size > ACCOUNTING_DOCUMENT_MAX_FILE_BYTES) return "File is too large. Maximum size is 25 MB per file.";
  return "";
}
