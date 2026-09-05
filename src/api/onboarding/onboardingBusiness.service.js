/* global process */
const BUSINESS_FIELD_ALLOWLIST = [
  "business_name",
  "industry",
  "team_size",
  "annual_revenue",
  "state",
  "services_offered",
  "billing_model",
  "founded_year",
  "top_challenge",
  "bookkeeping_start_date",
];

const REQUIRED_FIELDS = [
  "business_name",
  "industry",
  "state",
];

export const INITIAL_BUSINESS_ALREADY_EXISTS = "INITIAL_BUSINESS_ALREADY_EXISTS";

function logOnboardingRpcFailure(error) {
  if (process.env.NODE_ENV === "production") return;
  // Keep this server-side only. These fields are enough to diagnose Supabase RPC
  // failures without logging request bodies, tokens, or service-role credentials.
  console.error("[onboarding] create_initial_business_for_user RPC failed", {
    code: error?.code || null,
    message: error?.message || null,
    details: error?.details || null,
    hint: error?.hint || null,
  });
}

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function cleanInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export function sanitizeInitialBusinessPayload(body = {}) {
  const out = {};
  for (const field of BUSINESS_FIELD_ALLOWLIST) {
    if (field === "team_size" || field === "founded_year") {
      out[field] = cleanInteger(body[field]);
    } else if (field === "bookkeeping_start_date") {
      out[field] = cleanDate(body[field]);
    } else {
      out[field] = cleanString(body[field]);
    }
  }

  const missing = REQUIRED_FIELDS.filter((field) => {
    const value = out[field];
    return value === null || value === undefined || value === "";
  });
  if (missing.length) {
    const err = new Error("Required business profile fields are missing.");
    err.status = 400;
    err.code = "BUSINESS_PROFILE_REQUIRED";
    err.safeMessage = "Required business profile fields are missing.";
    err.meta = { missing };
    throw err;
  }

  if (out.team_size != null && out.team_size < 0) {
    const err = new Error("Invalid team size.");
    err.status = 400;
    err.code = "BUSINESS_PROFILE_INVALID";
    err.safeMessage = "Invalid business profile details.";
    throw err;
  }

  return out;
}

function mapRpcRow(row = {}) {
  return {
    id: row.id,
    user_id: row.user_id,
    business_name: row.business_name,
    industry: row.industry,
    team_size: row.team_size,
    annual_revenue: row.annual_revenue,
    state: row.state,
    services_offered: row.services_offered,
    billing_model: row.billing_model,
    founded_year: row.founded_year,
    top_challenge: row.top_challenge,
    bookkeeping_start_date: row.bookkeeping_start_date || null,
    membership_role: row.membership_role || "owner",
  };
}

export async function createInitialBusinessForAuthenticatedUser({
  supabase,
  auth,
  body,
}) {
  const userId = auth?.userId;
  if (!userId) {
    const err = new Error("Authentication required.");
    err.status = 401;
    err.code = "AUTH_REQUIRED";
    err.safeMessage = "Authentication required.";
    throw err;
  }

  const profile = sanitizeInitialBusinessPayload(body);
  const { data, error } = await supabase.rpc("create_initial_business_for_user", {
    p_user_id: userId,
    p_email: auth?.email || "",
    p_business_name: profile.business_name,
    p_industry: profile.industry,
    p_team_size: profile.team_size,
    p_state: profile.state,
    p_services_offered: profile.services_offered,
    p_annual_revenue: profile.annual_revenue,
    p_billing_model: profile.billing_model,
    p_founded_year: profile.founded_year,
    p_top_challenge: profile.top_challenge,
  });

  if (error) {
    logOnboardingRpcFailure(error);
    if (String(error?.message || "").includes(INITIAL_BUSINESS_ALREADY_EXISTS)) {
      const err = new Error("Initial business already exists.");
      err.status = 409;
      err.code = INITIAL_BUSINESS_ALREADY_EXISTS;
      err.safeMessage = "Initial business setup is already complete.";
      throw err;
    }

    const err = new Error("Business onboarding failed.");
    err.status = 500;
    err.code = "BUSINESS_ONBOARDING_FAILED";
    err.safeMessage = "Business onboarding could not be completed.";
    err.cause = error;
    throw err;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id || row.user_id !== userId) {
    const err = new Error("Business onboarding returned invalid ownership.");
    err.status = 500;
    err.code = "BUSINESS_ONBOARDING_INVALID_RESULT";
    err.safeMessage = "Business onboarding could not be completed.";
    throw err;
  }

  if (profile.bookkeeping_start_date) {
    const { data: updated, error: updateErr } = await supabase
      .from("business_profiles")
      .update({ bookkeeping_start_date: profile.bookkeeping_start_date })
      .eq("id", row.id)
      .eq("user_id", userId)
      .select("id,user_id,business_name,industry,team_size,annual_revenue,state,services_offered,billing_model,founded_year,top_challenge,bookkeeping_start_date")
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (updated?.id) return mapRpcRow({ ...row, ...updated });
  }

  return mapRpcRow(row);
}

export const INITIAL_BUSINESS_FIELD_ALLOWLIST = BUSINESS_FIELD_ALLOWLIST;
