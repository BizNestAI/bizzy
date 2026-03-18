import axios from "axios";
import PDFDocument from "pdfkit";
import { createHash } from "crypto";
import { supabase } from "../../services/supabaseAdmin.js";
import { qbApiBase, qboEnvName } from "../../utils/qboEnv.js";
import { getQuickBooksAccessToken } from "../../services/quickbooksTokenService.js";

const BUCKET = "financial-reports";
const DEV_LOG = process.env.NODE_ENV !== "production";

export function buildMonthWindow({ endYear, endMonth, window = 12 }) {
  const today = new Date();
  let y = endYear || today.getFullYear();
  let m = endMonth || today.getMonth() + 1; // 1–12

  const out = [];
  for (let i = 0; i < window; i++) {
    const monthStr = String(m).padStart(2, "0");
    const startDate = `${y}-${monthStr}-01`;
    const endDate = new Date(y, m, 0).toISOString().slice(0, 10);
    out.unshift({
      year: y,
      month: monthStr,
      startDate,
      endDate,
    });
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
  }
  return out; // oldest -> newest
}

async function getQboTokenRow(business_id) {
  const { data, error } = await supabase
    .from("quickbooks_tokens")
    .select("*")
    .eq("business_id", business_id)
    .eq("qbo_env", qboEnvName)
    .eq("is_active", true)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[pnlPdfService] quickbooks_tokens lookup failed: ${error.message || error}`);
  if (data) {
    console.log("[pnlPdfService] token row", {
      business_id,
      qbo_env: qboEnvName,
      realm_id: data?.realm_id,
      company_name: data?.company_name || data?.connected_company_name,
    });
  }
  if (!data) {
    throw new Error("quickbooks_not_connected");
  }
  return data;
}

export async function fetchProfitAndLossJson({ business_id, startDate, endDate }) {
  const tokenRow = await getQboTokenRow(business_id);
  if (!tokenRow?.realm_id) throw new Error("quickbooks_not_connected");

  const accessToken = await getQuickBooksAccessToken(business_id);
  const realmId = tokenRow.realm_id;

  const url = new URL(`${qbApiBase}/v3/company/${realmId}/reports/ProfitAndLoss`);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("accounting_method", "Cash");
  url.searchParams.set("summarize_column_by", "Total");
  url.searchParams.set("minorversion", "75");

  const res = await axios.get(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (DEV_LOG) {
    console.log("[pnlPdfService] fetched P&L JSON", {
      business_id,
      startDate,
      endDate,
      status: res.status,
    });
  }

  return { report: res.data, companyName: tokenRow?.company_name || tokenRow?.connected_company_name || "Your Business" };
}

function walkSummaryRows(rows = [], cb) {
  for (const row of rows) {
    if (!row) continue;
    const label =
      row?.Summary?.ColData?.[0]?.value ||
      row?.ColData?.[0]?.value ||
      row?.Header?.ColData?.[0]?.value ||
      "";
    const amount = parseFloat(
      row?.Summary?.ColData?.[1]?.value ||
      row?.ColData?.[1]?.value ||
      0
    );
    cb(label, Number.isFinite(amount) ? amount : null, row);
    if (row?.Rows?.Row) {
      walkSummaryRows(row.Rows.Row, cb);
    }
  }
}

export function extractPnLTotals(reportJson) {
  const rows = reportJson?.Rows?.Row || [];
  const hits = [];

  walkSummaryRows(rows, (label, amount) => {
    const norm = String(label || "").toLowerCase();
    if (amount === null) return;
    hits.push({ norm, amount });
  });

  const pick = (primary, fallback) => {
    const firstPrimary = hits.find(primary);
    if (firstPrimary?.amount != null) return firstPrimary.amount;
    const firstFallback = hits.find(fallback);
    if (firstFallback?.amount != null) return firstFallback.amount;
    return null;
  };

  const revenue = pick(
    (h) => /total income/.test(h.norm),
    (h) => /income|revenue/.test(h.norm)
  );

  const expenses = pick(
    (h) => /total expenses/.test(h.norm),
    (h) => /expense/.test(h.norm)
  );

  const netProfit = pick(
    (h) => /net income|net profit/.test(h.norm),
    () => null
  );

  return {
    revenue: revenue ?? 0,
    expenses: expenses ?? 0,
    netProfit: netProfit ?? ((revenue ?? 0) - (expenses ?? 0)),
  };
}

function formatCurrency(value) {
  const num = Number(value || 0);
  return num.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function flattenReportRows(rows = [], indent = 0, lines = []) {
  rows.forEach((row) => {
    if (!row) return;
    const headerLabel = row?.Header?.ColData?.[0]?.value || null;
    const summaryLabel = row?.Summary?.ColData?.[0]?.value || headerLabel || null;
    const summaryAmount = parseFloat(row?.Summary?.ColData?.[1]?.value ?? row?.ColData?.[1]?.value ?? 0);
    const hasChildren = Array.isArray(row?.Rows?.Row) && row.Rows.Row.length > 0;
    const colLabel = row?.ColData?.[0]?.value || null;
    const colAmount = parseFloat(row?.ColData?.[1]?.value ?? 0);

    if (headerLabel) {
      lines.push({ type: "section", label: headerLabel, amount: null, indentLevel: indent });
    }

    if (colLabel) {
      lines.push({ type: "account", label: colLabel, amount: colAmount, indentLevel: indent + (headerLabel ? 1 : 0) });
    }

    if (hasChildren) {
      flattenReportRows(row.Rows.Row, indent + (headerLabel ? 1 : 0), lines);
    }

    if (summaryLabel && row?.Summary?.ColData) {
      lines.push({
        type: "subtotal",
        label: summaryLabel,
        amount: summaryAmount,
        indentLevel: indent + (headerLabel ? 0 : 0),
      });
    }
  });
  return lines;
}

export function renderPnLToPdfBuffer({ report, businessName, startDate, endDate, accountingMethod = "Cash" }) {
  const doc = new PDFDocument({ margin: 50, size: "LETTER" });
  const chunks = [];
  doc.on("data", (d) => chunks.push(d));

  const start = new Date(startDate);
  const end = new Date(endDate);
  const periodLabel = (() => {
    const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    if (sameMonth) {
      return `${start.toLocaleString("en-US", { month: "long" })} ${start.getFullYear()}`;
    }
    const fmt = (d) => d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${fmt(start)} – ${fmt(end)}`;
  })();

  const table = flattenReportRows(report?.Rows?.Row || [], 0, []);

  const pageWidth = doc.page.width;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = pageWidth - left - doc.page.margins.right;
  const amountWidth = 140;
  const labelWidth = right - left - amountWidth;
  const rowGap = 6;

  const drawHeader = () => {
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#000").text("Profit and Loss", left, doc.y, {
      width: contentWidth,
      align: "center",
    });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(12).fillColor("#444").text(businessName || "Your Business", left, doc.y, {
      width: contentWidth,
      align: "center",
    });
    doc.text(periodLabel, left, doc.y, { width: contentWidth, align: "center" });
    doc.text(`${accountingMethod} Basis`, left, doc.y, { width: contentWidth, align: "center" });
    doc.moveDown(0.6);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor("#e5e5e5").stroke();
    doc.moveDown(0.4);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#000");
    doc.text("Account", left, doc.y, { width: labelWidth, continued: true });
    doc.text("Total", left + labelWidth, doc.y, { width: amountWidth, align: "right" });
    doc.moveDown(0.3);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor("#e5e5e5").stroke();
    doc.moveDown(0.6);
  };

  const ensureSpace = (height = 20) => {
    const bottom = doc.page.height - doc.page.margins.bottom - 30;
    if (doc.y + height > bottom) {
      doc.addPage();
      drawHeader();
    }
  };

  drawHeader();

  table.forEach((line) => {
    ensureSpace(18);
    const indentPx = line.indentLevel * 14;
    const label = line.label || "";
    const amount = Number.isFinite(line.amount) ? formatCurrency(line.amount) : "";

    if (line.type === "section") {
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#000");
      doc.text(label, left, doc.y, { width: labelWidth, continued: false });
      doc.moveDown(0.2);
    } else {
      if (line.type === "subtotal" || line.type === "total") {
        doc.moveTo(left + indentPx, doc.y).lineTo(right, doc.y).strokeColor("#ddd").stroke();
      }
      doc.font(line.type === "account" ? "Helvetica" : "Helvetica-Bold").fontSize(11).fillColor("#111");
      doc.text(label, left + indentPx, doc.y, { width: labelWidth - indentPx, continued: false });
      doc.text(amount, left + labelWidth, doc.y, { width: amountWidth, align: "right" });
      doc.moveDown(line.type === "subtotal" ? 0.35 : 0.2);
    }
    doc.moveDown(rowGap / 12);
  });

  doc.moveDown(2);
  doc.font("Helvetica").fontSize(9).fillColor("#666").text(`Generated by Bizzi from QuickBooks data • ${new Date().toLocaleString()}`, {
    align: "center",
  });

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

async function findExistingReportRow({ business_id, year, month }) {
  // Guard for older schemas: only select guaranteed columns; optional fields will be fetched/handled separately.
  const { data, error } = await supabase
    .from("report_metadata")
    .select("id, storage_path, year, month, revenue, net_profit")
    .eq("business_id", business_id)
    .eq("year", Number(year))
    .eq("month", Number(month))
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[pnlPdfService] report_metadata lookup failed: ${error.message || error}`);
  return data || null;
}

export async function upsertReportMetadata({
  business_id,
  year,
  month,
  revenue,
  net_profit,
  storage_path,
  generated_at,
  qbo_report_hash,
  source_start_date,
  source_end_date,
  accounting_method,
}) {
  const existing = await findExistingReportRow({ business_id, year, month });
  const canonicalPath = `${business_id}/${String(year)}-${String(month).padStart(2, "0")}-pnl.pdf`;
  const payload = {
    revenue,
    net_profit,
    storage_path: canonicalPath,
    includes_forecast: false,
  };

  // Optional fields: only include if present to avoid schema errors on older deployments
  if (generated_at) payload.generated_at = generated_at;
  if (qbo_report_hash) payload.qbo_report_hash = qbo_report_hash;
  if (source_start_date) payload.source_start_date = source_start_date;
  if (source_end_date) payload.source_end_date = source_end_date;
  if (accounting_method) payload.accounting_method = accounting_method;

  const tryPersist = async (usePayload) => {
    if (existing?.id) {
      return supabase
        .from("report_metadata")
        .update(usePayload)
        .eq("id", existing.id);
    }
    return supabase
      .from("report_metadata")
      .insert({
        business_id,
        year: Number(year),
        month: Number(month),
        ...usePayload,
      })
      .select("id")
      .maybeSingle();
  };

  // First attempt with optional fields
  let res = await tryPersist(payload);
  if (res.error && /column .* does not exist/i.test(res.error.message || "")) {
    // Retry without optional fields
    const minimal = {
      revenue,
      net_profit,
      storage_path,
      includes_forecast: false,
    };
    res = await tryPersist(minimal);
  }

  if (res.error) throw new Error(`[pnlPdfService] report_metadata persist failed: ${res.error.message || res.error}`);
  return res.data?.id || existing?.id || null;
}

async function storageFileExists(filePath) {
  const parts = filePath.split("/");
  const prefix = parts.slice(0, -1).join("/") || "";
  const fileName = parts[parts.length - 1];
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
    search: fileName,
    limit: 1,
  });
  if (error) {
    console.warn("[pnlPdfService] storage list failed", error.message || error);
    return false;
  }
  return Array.isArray(data) && data.some((f) => f.name === fileName);
}

export async function ensurePnLPdf({ business_id, year, month, forceRefresh = false }) {
  const monthStr = String(month).padStart(2, "0");
  const filePath = `${business_id}/${year}-${monthStr}-pnl.pdf`;
  const startDate = `${year}-${monthStr}-01`;
  const endDate = new Date(year, Number(monthStr), 0).toISOString().slice(0, 10);
  console.log("[pnlPdfService] ensurePnLPdf start", { business_id, year, month, filePath, forceRefresh });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[pnlPdfService] env missing", {
      hasUrl: Boolean(process.env.SUPABASE_URL),
      hasServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    });
    const err = new Error("pnl_pdf_env_missing");
    err.code = "pnl_pdf_env_missing";
    throw err;
  }

  const existingMeta = await findExistingReportRow({ business_id, year, month });
  // If optional columns are missing, skip TTL/hash staleness and always regenerate
  let stale = true;
  let existingHash = null;
  let generatedAtTs = null;
  try {
    const ttlHours = Number(process.env.PNL_PDF_TTL_HOURS || 6);
    generatedAtTs = existingMeta?.generated_at ? Date.parse(existingMeta.generated_at) : null;
    existingHash = existingMeta?.qbo_report_hash || null;
    const now = Date.now();
    stale = !generatedAtTs || now - generatedAtTs > ttlHours * 60 * 60 * 1000;
  } catch (e) {
    stale = true;
  }

  if (!forceRefresh) {
    const existsCached = await storageFileExists(filePath);
    if (existsCached && !stale) {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, 60 * 5);
      if (!error && data?.signedUrl) {
        console.log("[pnlPdfService] cache hit", { bucket: BUCKET, key: filePath });
        return { storage_path: filePath, signed_url: data.signedUrl, source: "cache" };
      }
      console.warn("[pnlPdfService] cache sign failed, regenerating", { error });
    }
  }

  const { report, companyName } = await fetchProfitAndLossJson({ business_id, startDate, endDate });
  const normalized = JSON.stringify({ Header: report?.Header, Rows: report?.Rows });
  const hash = createHash("sha256").update(normalized).digest("hex");

  const exists = await storageFileExists(filePath);
  if (!forceRefresh && exists && existingHash && existingHash === hash) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, 60 * 5);
    if (!error && data?.signedUrl) {
      await upsertReportMetadata({
        business_id,
        year,
        month,
        revenue: existingMeta?.revenue ?? null,
        net_profit: existingMeta?.net_profit ?? null,
        storage_path: filePath,
        generated_at: new Date().toISOString(),
        qbo_report_hash: hash,
        source_start_date: startDate,
        source_end_date: endDate,
        accounting_method: "Cash",
      });
      console.log("[pnlPdfService] hash match; reused cached PDF", { bucket: BUCKET, key: filePath });
      return { storage_path: filePath, signed_url: data.signedUrl, source: "cache" };
    }
  }

  const totals = extractPnLTotals(report);
  if (DEV_LOG) {
    console.log("[pnlPdfService] totals", { business_id, year, month, totals, filePath });
  }
  const buffer = await renderPnLToPdfBuffer({
    report,
    businessName: companyName,
    startDate,
    endDate,
    accountingMethod: "Cash",
  });

  console.log("[pnlPdfService] uploading PDF", { bucket: BUCKET, key: filePath, bytes: buffer.length });
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(filePath, buffer, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (upErr) {
    console.error("[pnlPdfService] storage upload failed", { bucket: BUCKET, key: filePath, error: upErr });
    const err = new Error(`pnl_pdf_upload_failed: ${upErr.message || upErr}`);
    err.code = "pnl_pdf_upload_failed";
    err.cause = upErr;
    throw err;
  }

  const existsAfter = await storageFileExists(filePath);
  console.log("[pnlPdfService] post-upload exists", { bucket: BUCKET, key: filePath, existsAfter });

  await upsertReportMetadata({
    business_id,
    year,
    month,
    revenue: totals.revenue ?? null,
    net_profit: totals.netProfit ?? null,
    storage_path: filePath,
    generated_at: new Date().toISOString(),
    qbo_report_hash: hash,
    source_start_date: startDate,
    source_end_date: endDate,
    accounting_method: "Cash",
  });
  if (DEV_LOG) {
    console.log("[pnlPdfService] report_metadata updated", { business_id, year, month, storage_path: filePath });
  }

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, 60 * 5);
  if (error) {
    console.error("[pnlPdfService] signed url failed", { bucket: BUCKET, key: filePath, error });
    const err = new Error(`pnl_pdf_signed_url_failed: ${error.message || error}`);
    err.code = "pnl_pdf_signed_url_failed";
    err.cause = error;
    throw err;
  }
  console.log("[pnlPdfService] signed url success", { bucket: BUCKET, key: filePath });

  return { storage_path: filePath, signed_url: data.signedUrl, source: "generated" };
}

export default {
  buildMonthWindow,
  fetchProfitAndLossJson,
  extractPnLTotals,
  renderPnLToPdfBuffer,
  ensurePnLPdf,
};
