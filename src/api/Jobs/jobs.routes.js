import express from "express";
import { supabase } from "../../services/supabaseAdmin.js"; // your existing helper
const router = express.Router();

/* ---------- Helpers ---------- */
const asNum = (n) => (typeof n === "number" ? n : Number(n || 0));

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
