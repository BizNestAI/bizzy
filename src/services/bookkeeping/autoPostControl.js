function isMissingAutoPostColumn(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return error?.code === "42703" || message.includes("auto_post_to_quickbooks");
}

export async function getAutoPostToQuickBooks(db, businessId) {
  if (!db || !businessId) return false;
  let query = db
    .from("business_profiles")
    .select("auto_post_to_quickbooks")
    .eq("id", businessId);
  if (typeof query.maybeSingle === "function") {
    const { data, error } = await query.maybeSingle();
    if (isMissingAutoPostColumn(error)) return false;
    if (error) throw error;
    return data?.auto_post_to_quickbooks === true;
  }
  if (typeof query.limit === "function") query = query.limit(1);
  const { data, error } = await query;
  if (isMissingAutoPostColumn(error)) return false;
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row?.auto_post_to_quickbooks === true;
}

export function computePostAfterForAutoPost(autoPostEnabled, graceHours = 24, nowMs = Date.now()) {
  if (autoPostEnabled !== true) return null;
  return new Date(nowMs + Number(graceHours || 24) * 60 * 60 * 1000).toISOString();
}
