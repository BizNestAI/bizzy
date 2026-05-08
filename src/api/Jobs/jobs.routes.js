import express from "express";
import { supabase } from "../../services/supabaseAdmin.js"; // your existing helper
import { requireAuth } from "../gpt/middlewares/requireAuth.js";
const router = express.Router();

/* ---------- Helpers ---------- */
const asNum = (n) => (typeof n === "number" ? n : Number(n || 0));
const startOfMonthIso = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
const normalizePrompt = (value = "") => String(value || "").trim();
const normalizeNeedle = (value = "") => String(value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

function getBusinessId(req) {
  return req.get("x-business-id") || req.query.business_id || req.body?.business_id || req.body?.businessId || null;
}

function parseAssignmentPrompt(prompt) {
  const raw = normalizePrompt(prompt);
  const lower = raw.toLowerCase();
  const jobMatch = lower.match(/\b(?:to|for|on)\s+(?:the\s+)?(.+?)\s+(?:job|project)\b/);
  const jobName = jobMatch?.[1]?.trim() || null;

  const vendorMatch =
    lower.match(/\bassign\s+(?:all\s+)?(.+?)\s+(?:expenses?|transactions?|charges?|spend)\b/) ||
    lower.match(/\bassign\s+(?:the\s+)?(.+?)\s+from\b/);
  const vendorText = vendorMatch?.[1]?.replace(/\b(all|the)\b/g, " ").trim() || null;

  let startDate = null;
  let endDate = null;
  if (/\bthis month\b/.test(lower)) {
    startDate = startOfMonthIso();
  }

  const monthDay = lower.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (monthDay) {
    const months = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    };
    const d = new Date(new Date().getFullYear(), months[monthDay[1]], Number(monthDay[2]));
    if (!Number.isNaN(d.getTime())) {
      startDate = d.toISOString().slice(0, 10);
      endDate = startDate;
    }
  }

  return { raw, jobName, vendorText, startDate, endDate };
}

async function fetchJobCostingRows(businessId) {
  const { data: txns, error: txErr } = await supabase
    .from("bank_transactions")
    .select("id,date,name,merchant_name,counterparty_name,amount,direction,category_primary,category_detailed")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .order("date", { ascending: false })
    .limit(200);
  if (txErr) throw txErr;

  const ids = (txns || []).map((row) => row.id);
  let catMap = {};
  if (ids.length) {
    const { data: cats, error: catErr } = await supabase
      .from("transaction_categorizations")
      .select("transaction_id,status,final_qbo_account_name,suggested_qbo_account_name,meta")
      .eq("business_id", businessId)
      .in("transaction_id", ids);
    if (catErr) throw catErr;
    catMap = (cats || []).reduce((acc, row) => {
      acc[row.transaction_id] = row;
      return acc;
    }, {});
  }

  let assignmentMap = {};
  if (ids.length) {
    const { data: assignments, error: assignmentErr } = await supabase
      .from("job_transaction_assignments")
      .select("*")
      .eq("business_id", businessId)
      .in("transaction_id", ids);
    if (assignmentErr) throw assignmentErr;
    assignmentMap = (assignments || []).reduce((acc, row) => {
      acc[row.transaction_id] = row;
      return acc;
    }, {});
  }

  const { data: jobs, error: jobsErr } = await supabase
    .from("jobs")
    .select("id,title,status,amount_contracted,amount_estimated")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (jobsErr) throw jobsErr;

  const rows = (txns || []).map((row) => {
    const cat = catMap[row.id] || {};
    const assignment = assignmentMap[row.id] || null;
    return {
      id: row.id,
      date: row.date,
      vendor: row.counterparty_name || row.merchant_name || row.name || "",
      description: row.name || "",
      amount: Number(row.amount || 0),
      direction: row.direction || (Number(row.amount || 0) < 0 ? "OUTFLOW" : "INFLOW"),
      gl_account: cat.final_qbo_account_name || cat.suggested_qbo_account_name || row.category_primary || "Uncategorized",
      status: cat.status || "needs_review",
      job_id: assignment?.job_id || null,
      job_label: assignment?.job_label || null,
      assignment_source: assignment?.assignment_source || null,
      assignment_confidence: assignment?.confidence || null,
    };
  });

  return { transactions: rows, jobs: jobs || [] };
}

/** Map Jobber stage/status → Busy status */
export function mapJobberToBusyStatus(stage = "") {
  const s = String(stage).toLowerCase();
  if (s.includes("request")) return "lead";
  if (s.includes("quote")) return "qualified";
  if (s.includes("visit")) return "scheduled";
  if (s.includes("progress")) return "in_progress";
  if (s.includes("completed")) return "completed";
  if (s.includes("won") || s.includes("paid") || s.includes("closed")) return "won";
  if (s.includes("lost") || s.includes("declined")) return "lost";
  return "lead";
}

/* ---------- GET /api/jobs/summary ---------- */
/* KPIs: new leads (7d), scheduled (next 14d), win rate (30d), outstanding AR */
router.get("/summary", async (req, res) => {
  try {
    const businessId = req.get("x-business-id") || req.query.business_id;
    if (!businessId) return res.status(400).json({ error: "business_id required" });

    const now = new Date();
    const d7  = new Date(now); d7.setDate(d7.getDate() - 7);
    const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
    const d14 = new Date(now); d14.setDate(d14.getDate() + 14);

    // New Leads (7d)
    const { count: leads7 } = await supabase
      .from("jobs")
      .select("*", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("status", "lead")
      .gte("created_at", d7.toISOString());

    // Scheduled (next 14d)
    const { count: scheduled14 } = await supabase
      .from("jobs")
      .select("*", { count: "exact", head: true })
      .eq("business_id", businessId)
      .in("status", ["scheduled","in_progress"])
      .gte("start_date", now.toISOString().slice(0,10))
      .lte("start_date", d14.toISOString().slice(0,10));

    // Win rate (30d)
    const { data: wonLost } = await supabase
      .from("jobs")
      .select("status")
      .eq("business_id", businessId)
      .gte("created_at", d30.toISOString());
    const won = (wonLost || []).filter(r => r.status === "won").length;
    const lost = (wonLost || []).filter(r => r.status === "lost").length;
    const winRate = (won + lost) > 0 ? Math.round((won / (won + lost)) * 100) : null;

    // Outstanding AR
    const { data: arRows } = await supabase
      .from("jobs")
      .select("amount_invoiced, amount_paid, invoice_status")
      .eq("business_id", businessId)
      .neq("invoice_status", "paid");
    const arOutstanding = (arRows || []).reduce((sum, r) => {
      const inv = asNum(r.amount_invoiced);
      const paid = asNum(r.amount_paid);
      const due = Math.max(inv - paid, 0);
      return sum + due;
    }, 0);

    res.json({
      leads_7d: leads7 ?? 0,
      scheduled_next_14d: scheduled14 ?? 0,
      win_rate_30d: winRate,
      outstanding_ar: Math.round(arOutstanding),
    });
  } catch (e) {
    console.error("[jobs.summary]", e);
    res.status(500).json({ error: "summary_failed" });
  }
});

/* ---------- GET /api/jobs/pipeline ---------- */
/* columns: lead, qualified, scheduled, in_progress, completed, won, lost (read-only v1) */
router.get("/pipeline", async (req, res) => {
  try {
    const businessId = req.get("x-business-id") || req.query.business_id;
    if (!businessId) return res.status(400).json({ error: "business_id required" });

    const { data, error } = await supabase
      .from("jobs")
      .select("id,title,status,customer_id,amount_contracted,amount_estimated,due_date,start_date,invoice_status,amount_invoiced,amount_paid,external_source,external_id")
      .eq("business_id", businessId)
      .order("due_date", { ascending: true })
      .limit(500);

    if (error) throw error;

    const cols = ["lead","qualified","scheduled","in_progress","completed","won","lost"].reduce((acc, k) => {
      acc[k] = [];
      return acc;
    }, {});
    (data || []).forEach(j => { (cols[j.status] || cols.lead).push(j); });
    res.json(cols);
  } catch (e) {
    console.error("[jobs.pipeline]", e);
    res.status(500).json({ error: "pipeline_failed" });
  }
});

/* ---------- GET /api/jobs/top-unpaid ---------- */
router.get("/top-unpaid", async (req, res) => {
  try {
    const businessId = req.get("x-business-id") || req.query.business_id;
    if (!businessId) return res.status(400).json({ error: "business_id required" });

    const { data, error } = await supabase
      .from("jobs")
      .select("id,title,external_source,external_id,amount_invoiced,amount_paid,invoice_status,last_update_at")
      .eq("business_id", businessId)
      .in("invoice_status", ["unpaid","partial"])
      .order("last_update_at", { ascending: false })
      .limit(10);
    if (error) throw error;

    const rows = (data || []).map(r => {
      const due = Math.max(asNum(r.amount_invoiced) - asNum(r.amount_paid), 0);
      return { ...r, amount_due: due };
    }).sort((a,b) => b.amount_due - a.amount_due);

    res.json(rows);
  } catch (e) {
    console.error("[jobs.top-unpaid]", e);
    res.status(500).json({ error: "top_unpaid_failed" });
  }
});

/* ---------- GET /api/jobs/activity (last 7 days) ---------- */
router.get("/activity", async (req, res) => {
  try {
    const businessId = req.get("x-business-id") || req.query.business_id;
    if (!businessId) return res.status(400).json({ error: "business_id required" });

    const d7 = new Date(); d7.setDate(d7.getDate() - 7);

    const { data, error } = await supabase
      .from("job_events")
      .select("id,job_id,event_type,payload,source,created_at")
      .eq("business_id", businessId)
      .gte("created_at", d7.toISOString())
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    res.json(data || []);
  } catch (e) {
    console.error("[jobs.activity]", e);
    res.status(500).json({ error: "activity_failed" });
  }
});

router.get("/job-costing", requireAuth, async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return res.status(400).json({ ok: false, error: "business_id required" });
    const payload = await fetchJobCostingRows(businessId);
    return res.json({ ok: true, ...payload });
  } catch (e) {
    console.error("[jobs.job-costing]", e);
    res.status(500).json({ ok: false, error: "job_costing_failed", message: e?.message || "failed" });
  }
});

router.post("/job-costing/assign-natural-language", requireAuth, async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return res.status(400).json({ ok: false, error: "business_id required" });
    const prompt = normalizePrompt(req.body?.prompt);
    if (!prompt) return res.status(400).json({ ok: false, error: "prompt required" });

    const parsed = parseAssignmentPrompt(prompt);
    if (!parsed.jobName || !parsed.vendorText) {
      return res.status(400).json({
        ok: false,
        error: "assignment_prompt_unclear",
        message: "Try: Assign all Amazon expenses this month to the Johnson job.",
      });
    }

    const jobNeedle = normalizeNeedle(parsed.jobName);
    const { data: jobs, error: jobsErr } = await supabase
      .from("jobs")
      .select("id,title,status")
      .eq("business_id", businessId)
      .limit(200);
    if (jobsErr) throw jobsErr;

    const matchedJob = (jobs || []).find((job) => normalizeNeedle(job.title).includes(jobNeedle) || jobNeedle.includes(normalizeNeedle(job.title)));
    if (!matchedJob) {
      return res.status(404).json({ ok: false, error: "job_not_found", message: `No job matched "${parsed.jobName}".` });
    }

    let query = supabase
      .from("bank_transactions")
      .select("id,date,name,merchant_name,counterparty_name,amount,direction")
      .eq("business_id", businessId)
      .eq("is_archived", false);
    if (parsed.startDate) query = query.gte("date", parsed.startDate);
    if (parsed.endDate) query = query.lte("date", parsed.endDate);

    const { data: txns, error: txErr } = await query.limit(500);
    if (txErr) throw txErr;

    const vendorNeedle = normalizeNeedle(parsed.vendorText);
    const matches = (txns || []).filter((txn) => {
      const haystack = normalizeNeedle([txn.counterparty_name, txn.merchant_name, txn.name].filter(Boolean).join(" "));
      const isExpense = (txn.direction || "").toUpperCase() === "OUTFLOW" || Number(txn.amount || 0) < 0;
      return isExpense && haystack.includes(vendorNeedle);
    });

    if (!matches.length) {
      return res.json({ ok: true, assigned: 0, message: "No matching expense transactions found.", parsed });
    }

    const now = new Date().toISOString();
    const payload = matches.map((txn) => ({
      business_id: businessId,
      transaction_id: txn.id,
      job_id: matchedJob.id,
      job_label: matchedJob.title,
      assignment_source: "natural_language",
      prompt,
      confidence: 0.86,
      updated_at: now,
    }));

    const { error: upsertErr } = await supabase
      .from("job_transaction_assignments")
      .upsert(payload, { onConflict: "business_id,transaction_id" });
    if (upsertErr) throw upsertErr;

    const refreshed = await fetchJobCostingRows(businessId);
    return res.json({
      ok: true,
      assigned: payload.length,
      job: matchedJob,
      parsed,
      ...refreshed,
    });
  } catch (e) {
    console.error("[jobs.job-costing.assign]", e);
    res.status(500).json({ ok: false, error: "job_costing_assign_failed", message: e?.message || "failed" });
  }
});

/* ---------- Sync stubs ---------- */
router.post("/integrations/jobber/sync", async (_req, res) => {
  // TODO: call Jobber API, transform with mapJobberToBusyStatus, upsert into jobs + job_events
  res.json({ ok: true, message: "jobber sync stub" });
});

router.post("/integrations/housecall/sync", async (_req, res) => {
  // TODO: call Housecall Pro API + normalize pipeline/events
  res.json({ ok: true, message: "housecall sync stub" });
});

router.post("/integrations/qbo/sync", async (_req, res) => {
  // TODO: fetch QBO invoices w/ JobID in CustomField/Memo, aggregate to jobs
  res.json({ ok: true, message: "qbo sync stub" });
});

export default router;
