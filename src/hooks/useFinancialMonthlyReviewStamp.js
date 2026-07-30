import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabaseClient.js";

const COMPLETED_STATUSES = ["completed", "closed", "finalized"];

export default function useFinancialMonthlyReviewStamp({ businessId, period = null } = {}) {
  const reviewMonth = useMemo(() => normalizeReviewMonth(period), [period]);
  const [stamp, setStamp] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    let alive = true;

    async function loadStamp() {
      if (!businessId) {
        setStamp(null);
        return;
      }

      setLoading(true);
      try {
        let query = supabase
          .from("financial_monthly_review_stamps")
          .select("id,business_id,review_month,status,completed_at,reviewed_by,notes")
          .eq("business_id", businessId)
          .in("status", COMPLETED_STATUSES);

        if (reviewMonth) {
          query = query.eq("review_month", reviewMonth);
        } else {
          query = query
            .order("review_month", { ascending: false })
            .order("completed_at", { ascending: false })
            .limit(1);
        }

        const { data, error } = await query.maybeSingle();
        if (!alive) return;

        if (error) {
          console.warn("[FinancialMonthlyReviewStamp] load failed:", error?.message || error);
          setStamp(null);
          return;
        }

        setStamp(data || null);
      } catch (e) {
        if (alive) {
          console.warn("[FinancialMonthlyReviewStamp] unexpected error:", e?.message || e);
          setStamp(null);
        }
      } finally {
        if (alive) setLoading(false);
      }
    }

    loadStamp();
    return () => {
      alive = false;
    };
  }, [businessId, reviewMonth, refreshKey]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    window.addEventListener("bizzy:financial-review-stamp-updated", refetch);
    return () => window.removeEventListener("bizzy:financial-review-stamp-updated", refetch);
  }, [refetch]);

  return { stamp, loading, refetch };
}

function normalizeReviewMonth(period) {
  if (!period) return null;
  if (period instanceof Date && !Number.isNaN(period.getTime())) {
    return `${period.getFullYear()}-${String(period.getMonth() + 1).padStart(2, "0")}-01`;
  }

  const raw = String(period).trim();
  const match = raw.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-01`;
}
