import { supabase } from "../../services/supabaseAdmin.js";
import axios from "axios";
import { getUserAccessTokenAndRealmId } from "../auth/quickbooksAuth.js";
import { fetchUncategorizedTransactions } from "./bookkeeping.routes.js";
import { upsertBookkeepingHealth } from "./bookkeepingHealth.js";
import { qbApiBase } from "../../utils/qboEnv.js";

const ENV_MOCK = String(process.env.USE_MOCK_ACCOUNTING || "").toLowerCase() === "true";

/**
 * Tiny, valid single-page PDF; we reuse for each month.
 * (It simply says "Mock Profit & Loss Report")
 */
const MOCK_PDF_BASE64 =
  "JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nCi9QYWdlcyAyIDAgUgovT3V0bGluZXMgMyAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMT4+CmVuZG9iagozIDAgb2JqCjw8L1R5cGUvT3V0bGluZXMKL0NvdW50IDAgPj4KZW5kb2JqCjQgMCBvYmoKPDwvVHlwZS9QYWdlCi9NZWRpYUJveCBbMCAwIDU5NSA4NDJdCi9QYXJlbnQgMiAwIFIKL1Jlc291cmNlcyA8PC9Gb250IDw8L0YxIDUgMCBSPj4+PgovQ29udGVudHMgNiAwIFI+PgplbmRvYmoKNSAwIG9iago8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMQovTmFtZS9GMS9CYXNlRm9udC9IZWx2ZXRpY2E+PgplbmRvYmoKNiAwIG9iago8PC9MZW5ndGggMTQ1Pj4Kc3RyZWFtCkJUCjEwMCA3NzAgVGQKKE1vY2sgUHJvZml0ICYgTG9zcyBSZXBvcnQpIFRqCkVUCmJUCjEwMCA3MzAgVGQKKEdlbmVyYXRlZCBieSBCaXp6eSAtIERldm1vZGUgTW9jaykgVGoKRVQKQlQKMTAwIDcwMCBUZAooVGhpcyBpcyBhIHBsYWNlaG9sZGVyIFBERiB3aGlsZSB5b3Ugc3luYyBRQk8pIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDcKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDgwIDAwMDAwIG4gCjAwMDAwMDAxNzggMDAwMDAgbiAKMDAwMDAwMDI1NiAwMDAwMCBuIAowMDAwMDAwNDc0IDAwMDAwIG4gCjAwMDAwMDA2MDIgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDcKL1Jvb3QgMSAwIFIKL0luZm8gOCAwIFI+PgpzdGFydHhyZWYKNjY5CiUlRU9G";

/**
 * Convert base64 to Buffer for upload
 */
function base64ToBuffer(b64) {
  return Buffer.from(b64, "base64");
}

/**
 * Build the 12-month window ending at "today" unless you pass `endYear`/`endMonth`.
 */
function buildMonthWindow({ endYear, endMonth, window = 12 }) {
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

/**
 * Try to read an existing metadata record for (business, year, month).
 */
async function existsReport({ businessId, year, month }) {
  const { data, error } = await supabase
    .from("report_metadata")
    .select("id")
    .eq("business_id", businessId)
    .eq("year", Number(year))
    .eq("month", Number(month));
  if (error) {
    console.warn("[P&L] existsReport warning:", error.message || error);
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Upload a mock PDF and insert metadata.
 */
async function upsertMockReport({ businessId, year, month, revenue, netProfit }) {
  const filePath = `financial-reports/${businessId}/${year}-${month}.pdf`;

  // Upload mock PDF (upsert)
  const { error: upErr } = await supabase.storage
    .from("financial-reports")
    .upload(filePath, base64ToBuffer(MOCK_PDF_BASE64), {
      contentType: "application/pdf",
      upsert: true,
    });

  if (upErr) {
    console.warn(`❌ Mock upload failed for ${filePath}`, upErr.message || upErr);
  }

  const { error: insErr } = await supabase.from("report_metadata").upsert(
    {
      business_id: businessId,
      year: Number(year),
      month: Number(month),
      revenue: revenue ?? null,
      net_profit: netProfit ?? null,
      includes_forecast: false,
      storage_path: filePath,
    },
    { onConflict: "business_id,year,month" }
  );

  if (insErr) {
    console.warn(`❌ Mock metadata upsert failed for ${filePath}`, insErr.message || insErr);
  } else {
    console.log(`✅ Mock P&L stored → ${filePath}`);
  }
}

/**
 * Main: pull P&L PDFs for last N months.
 * - If QBO connected → fetch JSON (for revenue/net) + PDF, upload + insert metadata
 * - If not connected (or forceMock/USE_MOCK) → upload mock PDFs and metadata
 *
 * @param {string} userId
 * @param {string} businessId
 * @param {Object} opts { window?: number, endYear?: number, endMonth?: number, forceMock?: boolean }
 * @returns {Promise<{synced:number, skipped:number, mocked:number, errors:number}>}
 */
export async function pullPnlPdfsForYear(userId, businessId, opts = {}) {
  const { window = 12, endYear, endMonth, forceMock = false } = opts;

  // Decide path: QBO or mock
  let accessToken = null;
  let realmId = null;
  try {
    const creds = await getUserAccessTokenAndRealmId(userId);
    accessToken = creds?.accessToken || null;
    realmId = creds?.realmId || null;
  } catch (e) {
    // swallow; we'll switch to mock
  }

  const useMockPath = forceMock || ENV_MOCK || !accessToken || !realmId;

  const months = buildMonthWindow({ endYear, endMonth, window });
  let synced = 0, skipped = 0, mocked = 0, errors = 0;

  for (const { year, month, startDate, endDate } of months) {
    try {
      const already = await existsReport({ businessId, year, month });
      if (already) {
        skipped++;
        continue;
      }

      if (useMockPath) {
        // Simple, believable mock values
        const base = [48000, 51000, 46500, 53000, 49500, 52000, 50500, 54000, 56000, 57500, 59000, 60500];
        const idx = Number(month) - 1;
        const revenue = base[idx % base.length];
        const netProfit = Math.round(revenue * 0.25); // 25% margin mock
        await upsertMockReport({ businessId, year, month, revenue, netProfit });
        mocked++;
        continue;
      }

      // ---- LIVE QBO PATH ----
      // 1) JSON P&L for metadata
      const jsonRes = await axios.get(
        `${qbApiBase}/v3/company/${realmId}/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        }
      );

      const rows = jsonRes.data?.Rows?.Row || [];
      let revenue = null;
      let netProfit = null;

      for (const row of rows) {
        const label =
          row?.Summary?.ColData?.[0]?.value ||
          row?.ColData?.[0]?.value ||
          "";
        const amount = parseFloat(
          row?.Summary?.ColData?.[1]?.value ||
            row?.ColData?.[1]?.value ||
            0
        );

        if (/total income|total revenue/i.test(label)) revenue = amount;
        if (/net income|net profit/i.test(label)) netProfit = amount;
      }

      const filePath = `financial-reports/${businessId}/${year}-${month}.pdf`;

      // 2) PDF P&L
      const pdfRes = await axios.get(
        `${qbApiBase}/v3/company/${realmId}/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/pdf",
          },
          responseType: "arraybuffer",
        }
      );

      const { error: upErr } = await supabase.storage
        .from("financial-reports")
        .upload(filePath, pdfRes.data, {
          contentType: "application/pdf",
          upsert: true,
        });

      if (upErr) {
        console.error(`❌ Upload failed for ${filePath}`, upErr);
        errors++;
        continue;
      }

      const { error: insErr } = await supabase.from("report_metadata").insert({
        business_id: businessId,
        year: Number(year),
        month: Number(month),
        revenue: revenue ?? null,
        net_profit: netProfit ?? null,
        includes_forecast: false,
        storage_path: filePath,
      });

      if (insErr) {
        console.error(`❌ Metadata insert failed for ${filePath}`, insErr);
        errors++;
      } else {
        console.log(`✅ Synced ${month}/${year} → ${filePath}`);
        synced++;
      }
    } catch (err) {
      console.error(`❌ Error syncing report for ${month}/${year}`, err?.response?.data || err?.message || err);
      errors++;
    }
  }
  // Best-effort bookkeeping health snapshot after sync
  try {
    const { count } = await fetchUncategorizedTransactions({ businessId, limit: 100 });
    await upsertBookkeepingHealth({
      businessId,
      uncategorizedCount: count,
      lastSyncAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[bookkeeping health] post-sync update failed", e?.message || e);
  }

  return { synced, skipped, mocked, errors };
}
