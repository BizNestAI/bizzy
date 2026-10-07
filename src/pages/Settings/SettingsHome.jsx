// src/components/Settings/SettingsHome.jsx
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAuth } from "../../context/AuthContext";
import { useBusiness } from "../../context/BusinessContext";
import { useAdminView } from "../../context/AdminViewContext.jsx";
import { supabase } from "../../services/supabaseClient";
import { apiUrl, safeFetch } from "../../utils/safeFetch";
import { updateBusinessProfile } from "../../services/businessService";
import { getUserProfile, updateUserProfile } from "../../services/profileService";
import {
  User, Building2, PlugZap, CreditCard, Mail, Shield, Link as LinkIcon,
  LogOut, AlertTriangle, ChevronDown, Check
} from "lucide-react";
import BillingCard from "../../pages/Settings/BillingCard.jsx";
import SettingsTabs from "./SettingsTabs.js";
import { SETTINGS_TABS } from "./settingsTabsConfig.js";
import useBillingStatus from "../../hooks/useBillingStatus.js";
import { useNavigate } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import useIntegrationManager, { INTEGRATION_META } from "../../hooks/useIntegrationManager";
import { getDemoMode, setDemoMode, isTestingMode, setTestingMode } from "../../services/demo/demoClient.js";
import { logout as performLogout } from "../../services/authService";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import {
  getPlaidStatus,
  createPlaidLinkToken,
  createPlaidUpdateLinkToken,
  completePlaidRepair,
  bootstrapPlaidRecoveryState,
  selectPlaidReplacementRecoveryAccount,
  getPlaidRecoveryStatus,
  preparePlaidRecoveryPreview,
  confirmPlaidReplacementLineage,
  getPlaidRecoveryBatchRows,
  admitPlaidRecoveryBatch,
  releasePlaidRecoveryHold,
  exchangePlaidPublicToken,
  triggerPlaidSync,
  disconnectPlaid,
  disconnectPlaidItem,
  getAccountMappings,
  updateAccountMapping,
  getQboPaymentAccounts,
  ensureQboPaymentAccount,
} from "../../services/bookkeeping/bookkeepingClient";

/** Graphite neutrals (tokens) */
const NEUTRAL_BORDER = "rgba(255,255,255,0.105)";
const SOFT_BORDER = "rgba(255,255,255,0.075)";
const TEXT_MUTED = "var(--text-2)";
const ROW_BG = "rgba(255,255,255,0.032)";
const PLAID_LINK_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const INTEGRATION_ACTION_BUTTON_CLASS =
  "inline-flex h-11 w-full items-center justify-center whitespace-nowrap rounded-xl px-4 text-sm font-semibold sm:w-[232px]";
const PLAID_STATUS_CACHE_VERSION = 1;
const REPLACEMENT_CARD_CUTOFF_DATE = "2026-08-27";

const CREDITS_CAP = 300;
const EMPTY_BUSINESS_FORM = {
  business_name: "",
  industry: "",
  team_size: "",
  state: "",
  bookkeeping_start_date: "",
};

function plaidStatusCacheKey(businessId) {
  return businessId ? `bizzy:plaid-status:${businessId}` : null;
}

function readPlaidStatusCache(businessId) {
  if (typeof window === "undefined") return null;
  const key = plaidStatusCacheKey(businessId);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== PLAID_STATUS_CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePlaidStatusCache(businessId, payload) {
  if (typeof window === "undefined") return;
  const key = plaidStatusCacheKey(businessId);
  if (!key) return;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: PLAID_STATUS_CACHE_VERSION,
        savedAt: Date.now(),
        ...payload,
      })
    );
  } catch {
    /* ignore */
  }
}

function clearPlaidStatusCache(businessId) {
  if (typeof window === "undefined") return;
  const key = plaidStatusCacheKey(businessId);
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export default function SettingsHome() {
  const SHOW_MARKETING_COMMS = false;
  const { user } = useAuth();
  const { currentBusiness, setCurrentBusiness } = useBusiness();
  const adminView = useAdminView();
  const readOnly = adminView.active && adminView.readOnly;
  const { usageCount = 0 } = useBizzyChatContext() || {};
  const navigate = useNavigate();
  const userId = adminView.active ? "admin_view" : (user?.id || localStorage.getItem("user_id"));
  const businessId = adminView.active ? adminView.businessId : (currentBusiness?.id || localStorage.getItem("currentBusinessId"));
  const isPrimaryOwner = !adminView.active && Boolean(userId && currentBusiness?.user_id && String(currentBusiness.user_id) === String(userId));
  const ownerAdministrationDisabled = readOnly || !isPrimaryOwner;
  const [searchParams, setSearchParams] = useSearchParams();
  const [billingRefresh, setBillingRefresh] = useState(0);
  const [billingToast, setBillingToast] = useState("");

  const activeTab = useMemo(() => {
    const tabParam = (searchParams.get("tab") || "").toLowerCase();
    const focus = (searchParams.get("integration") || "").toLowerCase();
    if (focus) return "Integrations";
    if (tabParam) {
      const match = SETTINGS_TABS.find((t) => t.key.toLowerCase() === tabParam);
      if (match) return match.key;
    }
    try {
      const storedTab = (window.localStorage?.getItem("bizzy:settingsActiveTab") || "").toLowerCase();
      const match = storedTab && SETTINGS_TABS.find((t) => t.key.toLowerCase() === storedTab);
      if (match) return match.key;
    } catch {
      /* ignore */
    }
    return "Profile";
  }, [searchParams]);
  const shouldLoadBilling = activeTab === "Billing" && Boolean(businessId);
  const { status: billingStatus, loading: loadingBilling } = useBillingStatus(
    shouldLoadBilling ? businessId : null,
    shouldLoadBilling ? userId : null,
    billingRefresh
  );
  const setActiveTab = useCallback((nextTab) => {
    if (!nextTab) return;
    try {
      window.localStorage?.setItem("bizzy:settingsActiveTab", nextTab);
    } catch {
      /* ignore */
    }
    const next = new URLSearchParams(searchParams);
    if ((next.get("tab") || "").toLowerCase() !== nextTab.toLowerCase()) {
      next.set("tab", nextTab);
    }
    if (next.has("integration")) next.delete("integration");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const [pendingIntegrationFocus, setPendingIntegrationFocus] = useState(null);
  const [dataMode, setDataMode] = useState(() => getDemoMode());
  const [, setTestingModeState] = useState(() => isTestingMode());
  const [modeUpdating, setModeUpdating] = useState(false);
  const [qbCompanyName, setQbCompanyName] = useState("");
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  // Profile
  const [name, setName] = useState("");
  const [email] = useState(user?.email || "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState("");
  const [profileError, setProfileError] = useState("");

  // Business
  const [businessForm, setBusinessForm] = useState(EMPTY_BUSINESS_FORM);
  const [savingBusiness, setSavingBusiness] = useState(false);
  const [bizSuccessMsg, setBizSuccessMsg] = useState("");
  const [bizErrorMsg, setBizErrorMsg] = useState("");
  const plaidRefreshOnceRef = useRef(false);

  /* ---------------- Effects ---------------- */
  useEffect(() => {
    const fetchProfile = async () => {
      if (!user?.id) return;
      const { data } = await getUserProfile(user.id);
      if (data?.name) setName(data.name);
    };
    fetchProfile();
  }, [user]);

  useEffect(() => {
    let alive = true;

    const fallback = {
      business_name: currentBusiness?.business_name || adminView.businessName || "",
      industry: currentBusiness?.industry || "",
      team_size: currentBusiness?.team_size ?? "",
      state: currentBusiness?.state || "",
      bookkeeping_start_date: currentBusiness?.bookkeeping_start_date || "",
    };

    const loadBusinessProfile = async () => {
      if (!businessId) {
        if (alive) setBusinessForm(EMPTY_BUSINESS_FORM);
        return;
      }

      if (adminView.active) {
        if (!alive) return;
        setBusinessForm(fallback);
        setCurrentBusiness((prev) => ({
          ...(prev || {}),
          id: businessId,
          business_name: fallback.business_name || prev?.business_name || adminView.businessName || "",
        }));
        return;
      }

      const { data, error } = await supabase
        .from("business_profiles")
        .select("id,business_name,industry,team_size,state,bookkeeping_start_date")
        .eq("id", businessId)
        .maybeSingle();

      if (!alive) return;

      if (error) {
        console.warn("[settings] failed to load business profile", error);
        setBusinessForm(fallback);
        return;
      }

      const source = data || fallback;
      setBusinessForm({
        business_name: source.business_name || "",
        industry: source.industry || "",
        team_size: source.team_size ?? "",
        state: source.state || "",
        bookkeeping_start_date: source.bookkeeping_start_date || "",
      });

      if (data?.id) {
        setCurrentBusiness((prev) => ({ ...(prev || {}), ...data }));
      }
    };

    loadBusinessProfile();

    return () => {
      alive = false;
    };
  }, [adminView.active, adminView.businessName, businessId, currentBusiness?.id, setCurrentBusiness]);

  useEffect(() => {
    const checkout = searchParams.get("checkout");
    if (!checkout) return;
    if (checkout === "success") {
      setBillingToast("Bizzi is active. You can manage billing anytime.");
      setBillingRefresh((v) => v + 1);
    } else if (checkout === "cancel") {
      setBillingToast("Checkout canceled.");
    }
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("checkout");
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!billingToast) return;
    const t = setTimeout(() => setBillingToast(""), 4000);
    return () => clearTimeout(t);
  }, [billingToast]);

  /* ---------------- Handlers ---------------- */
  const handleResetPassword = async () => {
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    alert("Password reset email sent.");
  };

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    setProfileSuccess("");
    setProfileError("");
    const { error } = await updateUserProfile(user.id, { name });
    if (error) setProfileError("Failed to update profile.");
    else setProfileSuccess("Profile updated successfully.");
    setSavingProfile(false);
  };

  const handleBusinessChange = (e) => {
    const { name, value } = e.target;
    setBusinessForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSaveBusiness = async () => {
    if (!businessId) return;
    if (readOnly) {
      setBizErrorMsg("Business settings changes are unavailable in read-only Admin View.");
      return;
    }
    const currentStartDate = currentBusiness?.bookkeeping_start_date || "";
    const nextStartDate = businessForm.bookkeeping_start_date || "";
    if (currentStartDate && nextStartDate && nextStartDate < currentStartDate) {
      const confirmed = window.confirm(
        "Moving the bookkeeping start date earlier will make older imported transactions eligible for active review. Bizzi will not automatically approve or post those transactions. Continue?"
      );
      if (!confirmed) return;
    }
    setSavingBusiness(true);
    setBizSuccessMsg("");
    setBizErrorMsg("");
    const payload = {
      ...businessForm,
      team_size: businessForm.team_size ? parseInt(businessForm.team_size, 10) : null,
      bookkeeping_start_date: businessForm.bookkeeping_start_date || null,
    };
    const { data, error } = await updateBusinessProfile(businessId, payload);
    if (error) setBizErrorMsg("Failed to update business settings. Please try again.");
    else {
      setCurrentBusiness((prev) => ({ ...(prev || {}), ...(data || payload), id: businessId }));
      setBizSuccessMsg("Business settings updated successfully.");
    }
    setSavingBusiness(false);
  };

  const beginLogout = () => {
    setLogoutError("");
    setShowLogoutConfirm(true);
  };

  const cancelLogout = () => {
    if (loggingOut) return;
    setShowLogoutConfirm(false);
    setLogoutError("");
  };

  const confirmLogout = async () => {
    setLoggingOut(true);
    setLogoutError("");
    try {
      await performLogout();
      navigate("/login");
    } catch {
      setLogoutError("Unable to log out. Please try again.");
      setLoggingOut(false);
    }
  };

  const integrationManager = useIntegrationManager({ businessId });

  useEffect(() => {
    const focus = (searchParams.get("integration") || "").toLowerCase();
    if (!focus) return;
    setPendingIntegrationFocus(focus);
  }, [searchParams]);

  useEffect(() => {
    if (activeTab !== "Integrations" || !pendingIntegrationFocus) return;
    const el = document.querySelector(
      `[data-integration='${pendingIntegrationFocus}']`
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const prevShadow = el.style.boxShadow;
      el.style.boxShadow = "0 0 0 1px var(--accent), 0 0 18px rgba(59,176,246,0.45)";
      setTimeout(() => {
        el.style.boxShadow = prevShadow;
      }, 1600);
    }
    setPendingIntegrationFocus(null);
  }, [activeTab, pendingIntegrationFocus]);

  // Fetch QuickBooks company name for display
  useEffect(() => {
    if (activeTab !== "Integrations") return;
    let alive = true;
    async function loadCompany() {
      if (!businessId) {
        setQbCompanyName("");
        return;
      }
      try {
        const res = await safeFetch(apiUrl(`/auth/status?business_id=${businessId}`), { method: "GET" });
        if (!alive) return;
        setQbCompanyName(res?.company_name || "");
      } catch {
        if (!alive) return;
        setQbCompanyName("");
      }
    }
    loadCompany();
    return () => {
      alive = false;
    };
  }, [activeTab, businessId]);

useEffect(() => {
  if (activeTab !== "Integrations") {
    plaidRefreshOnceRef.current = false;
    return;
  }
  if (!businessId || readOnly) return;
  if (plaidRefreshOnceRef.current) return;
  plaidRefreshOnceRef.current = true;
  integrationManager.refresh?.("plaid").catch(() => {});
}, [activeTab, businessId, integrationManager, readOnly]);

  /* ---------------- Render ---------------- */
  return (
    <div className="w-full pb-12 pt-0 bg-app text-primary" style={{ "--accent": "var(--accent)" }}>
      {/* Header (aligned with page content) */}
      <div className="bizzy-page-width bizzy-page-width--workspace mb-5">
        <h1 className="text-[20px] sm:text-[22px] font-semibold tracking-[0.2em] text-[color:var(--text)] text-left">
          Settings
        </h1>
        <p className="mt-3 text-sm text-left text-white/70">
          Profile, business identity, integrations, and billing — all in one place.
        </p>
      </div>

      <div className="bizzy-page-width bizzy-page-width--workspace">
      <section
        className="mb-4 rounded-xl border px-4 py-3"
        style={{ background: "rgba(17,19,18,0.52)", borderColor: SOFT_BORDER, boxShadow: "none" }}
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white/85">Data Source Mode</p>
            <p className="text-xs text-white/60">
              Toggle between Bizzi’s mock data (Mike’s Remodeling) and live integrations. Live Mode shows zeroes until your accounts sync.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
            <ModeToggle
              active={dataMode !== "live"}
              labelOn="Mock Mode"
              labelOff="Live Mode"
              disabled={modeUpdating}
              onChange={(value) => {
                if (modeUpdating) return;
                setModeUpdating(true);
                const mode = value ? "demo" : "live";
                setDemoMode(mode);
                setDataMode(mode === "demo" ? "demo" : "live");
                if (mode === "demo") {
                  setTestingModeState(false);
                  setTestingMode(false);
                }
                setTimeout(() => window.location.reload(), 150);
              }}
            />
            <div className="text-xs text-white/55 sm:max-w-[18rem]">
              <div>{dataMode !== "live" ? "Bizzi demo data is active." : "Live mode enabled."}</div>
              <div>{dataMode !== "live" ? "Great for demos and testing." : "Connect QuickBooks and Plaid to populate your financial dashboards."}</div>
            </div>
          </div>
        </div>
      </section>

      {/* Tab pills */}
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Settings tabs">
          <div className="flex flex-wrap gap-1.5 sm:gap-2">
            <SettingsTabs
              items={SETTINGS_TABS}
              activeTab={activeTab}
              onSelect={setActiveTab}
              softBorder={SOFT_BORDER}
            />
            <button
              onClick={() => navigate('/setup?from=settings', { state: { fromSettings: true } })}
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] transition"
              style={{
                borderColor: SOFT_BORDER,
                color: "var(--text)",
                background: "rgba(255,255,255,0.018)",
              }}
            >
              Review Business Setup
            </button>
          </div>
        </div>
      </div>

      {/* Content wrapper */}
      <div className="p-0">
        <div className="grid grid-cols-12 gap-4">
          {/* -------- Profile -------- */}
          {activeTab === "Profile" && (
            <>
              <Section
                className="col-start-1 col-span-12 lg:col-span-7"
                title="Your Profile"
                subtitle="Keep your personal info up to date."
                icon={User}
              >
                <Field label="Full Name"><Input id="settings-full-name" name="full_name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" /></Field>
                <Field label="Email"><Input id="settings-email" name="email" autoComplete="email" value={email} disabled /></Field>
                <div className="flex flex-wrap gap-3 pt-2">
                  <AccentButton onClick={handleSaveProfile} disabled={readOnly || savingProfile} className="focus-visible:outline-none">
                    {readOnly ? "Read Only" : savingProfile ? "Saving…" : "Save Changes"}
                  </AccentButton>
                  <GhostButton onClick={handleResetPassword} className="focus-visible:outline-none">Send Reset Email</GhostButton>
                </div>
                <InlineMsg ok={profileSuccess} err={profileError} />

                <div className="mt-5 border-t border-white/[0.07] pt-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-white/85">
                        <LogOut className="h-4 w-4 text-white/55" />
                        Account access
                      </div>
                      <p className="mt-1 text-xs" style={{ color: TEXT_MUTED }}>
                        Sign out of this device when you are finished.
                      </p>
                    </div>
                    {!showLogoutConfirm ? (
                      <GhostButton onClick={beginLogout}>
                        Sign out
                      </GhostButton>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={confirmLogout}
                        disabled={loggingOut}
                          className="rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:opacity-60"
                        style={{
                          background: "linear-gradient(120deg, rgba(80,82,86,0.95), rgba(45,47,52,0.9))",
                          color: "white",
                          boxShadow: "none",
                        }}
                      >
                        {loggingOut ? "Signing out…" : "Confirm sign out"}
                      </button>
                        <GhostButton onClick={cancelLogout} disabled={loggingOut}>
                        Stay signed in
                      </GhostButton>
                      </div>
                    )}
                  </div>
                  {showLogoutConfirm ? (
                    <p className="mt-3 text-xs" style={{ color: TEXT_MUTED }}>
                      You’ll need to re-enter your credentials to get back into Bizzi.
                    </p>
                  ) : null}
                  <InlineMsg err={logoutError} className="mt-3" />
                </div>
              </Section>
            </>
          )}

          {/* -------- Business -------- */}
          {activeTab === "Business" && (
            <>
              <Section
                className="col-start-1 col-span-12"
                title="Business"
                subtitle="Manage the business Bizzi uses for dashboards and integrations."
                icon={Building2}
              >
                <div className="border-b border-white/[0.07] pb-4">
                  <div>
                    <p className="text-sm font-semibold text-white/85">
                      {businessForm.business_name || currentBusiness?.business_name || "No business selected"}
                    </p>
                    <p className="mt-1 text-xs" style={{ color: TEXT_MUTED }}>
                      This is the business currently active across your dashboards and integrations.
                    </p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Field label="Business Name"><Input name="business_name" value={businessForm.business_name} onChange={handleBusinessChange} /></Field>
                  <Field label="Industry"><Input name="industry" value={businessForm.industry} onChange={handleBusinessChange} /></Field>
                  <Field label="Team Size"><Input name="team_size" type="number" value={businessForm.team_size} onChange={handleBusinessChange} /></Field>
                  <Field label="State"><Input name="state" value={businessForm.state} onChange={handleBusinessChange} /></Field>
                  <Field label="When should Bizzi start managing your books?">
                    <Input name="bookkeeping_start_date" type="date" value={businessForm.bookkeeping_start_date} onChange={handleBusinessChange} />
                  </Field>
                </div>
                <div className="pt-2">
                  <AccentButton onClick={handleSaveBusiness} disabled={readOnly || savingBusiness} className="focus-visible:outline-none">
                    {readOnly ? "Read Only" : savingBusiness ? "Saving…" : "Save Changes"}
                  </AccentButton>
                  <InlineMsg ok={bizSuccessMsg} err={bizErrorMsg} className="mt-3" />
                </div>
              </Section>
            </>
          )}

          {/* -------- Integrations -------- */}
          {activeTab === "Integrations" && (
            <>
              <Section
                className="col-start-1 col-span-12"
                title="Accounting & Banking"
                subtitle="Connect your books and bank data."
                icon={PlugZap}
              >
                <IntegrationRow provider="quickbooks" manager={integrationManager} companyName={qbCompanyName} businessId={businessId} disabled={ownerAdministrationDisabled} />
                <PlaidIntegrationCard businessId={businessId} readOnly={ownerAdministrationDisabled} />
                {!isPrimaryOwner && !adminView.active ? (
                  <p className="mt-3 text-xs" style={{ color: TEXT_MUTED }}>Only the primary business owner can manage integrations.</p>
                ) : null}
              </Section>

              {SHOW_MARKETING_COMMS ? (
                <Section
                  className="col-start-1 col-span-12"
                  title="Marketing & Comms"
                  subtitle="Bring in communications and social data."
                  icon={Mail}
                >
                  <IntegrationRow name="Slack" description="Team notifications and workflows." disabled />
                  <IntegrationRow provider="facebook" manager={integrationManager} />
                  <IntegrationRow provider="instagram" manager={integrationManager} />
                  <IntegrationRow provider="linkedin" manager={integrationManager} />
                </Section>
              ) : null}

            </>
          )}

          {/* -------- Billing -------- */}
          {activeTab === "Billing" && (
            <Section
              className="col-start-1 col-span-12"
              title="Subscription & Billing"
              subtitle="Manage your plan, invoices, and credits."
              icon={CreditCard}
            >
              {billingToast ? (
                <div className="mb-3 rounded-lg border border-emerald-300/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
                  {billingToast}
                </div>
              ) : null}
              {!businessId ? (
                <div className="rounded-lg border px-3 py-2 text-sm text-white/60" style={{ borderColor: SOFT_BORDER, background: ROW_BG }}>
                  Select a business to manage billing.
                </div>
              ) : (
                <>
                  <div
                    className="rounded-xl border px-4 py-3"
                    style={{ borderColor: SOFT_BORDER, background: ROW_BG }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-white/90">Bizzi credits usage</p>
                        <p className="text-xs" style={{ color: TEXT_MUTED }}>
                          Track how many Bizzi credits you’ve used this month.
                        </p>
                      </div>
                      <span className="text-sm font-semibold text-white/85">
                        {Math.min(usageCount || 0, CREDITS_CAP)}/{CREDITS_CAP}
                      </span>
                    </div>
                    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/5">
                      <div
                        className="h-full rounded-full bg-emerald-400/70 transition-all"
                        style={{ width: `${Math.min(((usageCount || 0) / CREDITS_CAP) * 100, 100)}%` }}
                      />
                    </div>
                  </div>

                  <div className="mt-4">
                    <BillingCard
                      userId={userId}
                      businessId={businessId}
                      status={billingStatus}
                      readOnly={ownerAdministrationDisabled}
                      onBillingRefresh={() => setBillingRefresh((v) => v + 1)}
                    />
                  </div>
                  {!isPrimaryOwner && !adminView.active ? (
                    <p className="mt-3 text-xs" style={{ color: TEXT_MUTED }}>Only the primary business owner can manage billing.</p>
                  ) : null}
                </>
              )}
              {activeTab === "Billing" && loadingBilling ? (
                <p className="text-xs mt-2" style={{ color: TEXT_MUTED }}>Loading billing status…</p>
              ) : null}
            </Section>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

function ModeToggle({ active, onChange, disabled, labelOn = "On", labelOff = "Off" }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!active)}
      className={[
        "relative inline-flex items-center rounded-full border p-1 transition focus-visible:outline-none",
        disabled ? "opacity-50 cursor-not-allowed" : "hover:border-white/20",
      ].join(" ")}
      style={{ width: 172, height: 40, background: "rgba(0,0,0,0.18)", borderColor: SOFT_BORDER }}
    >
      <span
        className={[
          "absolute inset-1 rounded-full bg-[rgba(var(--accent-rgb),0.12)] transition-all duration-300",
          active ? "translate-x-0 opacity-100" : "translate-x-[calc(100%-2px)] opacity-0",
        ].join(" ")}
        aria-hidden
      />
      <span
        className={[
          "absolute inset-1 rounded-full bg-white/6 transition-all duration-300",
          active ? "translate-x-[calc(0%)] opacity-0" : "translate-x-0 opacity-100",
        ].join(" ")}
        aria-hidden
      />
      <div className="relative z-10 flex w-full items-center justify-between px-3 text-[12px] font-semibold">
        <span className={active ? "text-white" : "text-white/40"}>{labelOn}</span>
        <span className={!active ? "text-white" : "text-white/40"}>{labelOff}</span>
      </div>
    </button>
  );
}

function loadPlaidScript() {
  if (typeof window === "undefined") return Promise.reject(new Error("window unavailable"));
  if (window.Plaid) return Promise.resolve(window.Plaid);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PLAID_LINK_SCRIPT;
    script.async = true;
    script.onload = () => {
      if (window.Plaid) resolve(window.Plaid);
      else reject(new Error("Plaid script loaded without Plaid"));
    };
    script.onerror = () => reject(new Error("Failed to load Plaid Link"));
    document.head.appendChild(script);
  });
}

function StatusBadge({ label = "Unknown", tone = "slate" }) {
  const toneMap = {
    ok: "bg-emerald-500/12 text-emerald-200 border-emerald-500/24",
    warning: "bg-amber-500/12 text-amber-200 border-amber-500/24",
    slate: "bg-white/7 text-white/65 border-white/12",
  };
  const cls = toneMap[tone] || toneMap.slate;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {label}
    </span>
  );
}

function RecoveryTransactionReviewModal({ businessId, plaidItemId, batch, onClose, onAdmit }) {
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sort, setSort] = useState("oldest");
  const [selected, setSelected] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setError("");
    getPlaidRecoveryBatchRows(businessId, plaidItemId, batch.batch_id, { page, page_size: 25, search, date_from: dateFrom, date_to: dateTo, sort })
      .then((response) => {
        if (cancelled) return;
        if (response?.ok === false) throw new Error(response.message || "Recovery transactions could not be loaded.");
        setResult(response);
        setSelected((current) => current === null ? new Set(response.eligible_row_ids || []) : current);
      }).catch((cause) => { if (!cancelled) setError(cause?.message || "Recovery transactions could not be loaded."); });
    return () => { cancelled = true; };
  }, [businessId, plaidItemId, batch.batch_id, page, search, dateFrom, dateTo, sort]);
  const count = selected?.size || 0;
  const summary = result?.summary || batch.summary || {};
  const represented = (summary.exact_existing || 0) + (summary.represented || 0);
  const cutoffDate = result?.cutoff_date || batch.cutoff_date || REPLACEMENT_CARD_CUTOFF_DATE;
  const latestExistingDate = summary.latest_existing_transaction_date || summary.latest_existing_date || null;
  const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(Number(value || 0)));
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-3" role="dialog" aria-modal="true" aria-label="Review replacement-card transactions">
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-emerald-400/25 bg-[#101312] shadow-2xl">
        <div className="border-b border-white/10 px-5 py-4"><div className="text-lg font-semibold text-white">Review new Chase transactions</div>
          <div className="mt-1 text-xs text-white/55">Controlled cutoff: {cutoffDate} · Operator confirmed{latestExistingDate ? ` · Latest existing transaction: ${latestExistingDate}` : ""}</div></div>
        <div className="overflow-y-auto p-5">
          <div className="mb-4 grid gap-2 sm:grid-cols-3"><div className="rounded-lg border border-white/10 bg-white/[.03] p-3 text-xs text-white/65"><b className="text-white">{represented}</b> already represented and skipped</div>
            <div className="rounded-lg border border-white/10 bg-white/[.03] p-3 text-xs text-white/65"><b className="text-white">{summary.pending_replacements || 0}</b> pending replacements remain held</div>
            <div className="rounded-lg border border-amber-400/25 bg-amber-500/5 p-3 text-xs text-amber-100">Auto-post is off. Posting hold remains active.</div></div>
          {!confirming ? <>
            <div className="mb-3 flex flex-wrap gap-2">
              <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search merchant or description" className="min-w-56 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white" />
              <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} className="rounded-lg border border-white/10 bg-[#111] px-3 py-2 text-sm text-white [color-scheme:dark]" />
              <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} className="rounded-lg border border-white/10 bg-[#111] px-3 py-2 text-sm text-white [color-scheme:dark]" />
              <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} className="rounded-lg border border-white/10 bg-[#111] px-3 py-2 text-sm text-white"><option value="oldest">Oldest first</option><option value="newest">Newest first</option><option value="amount">Amount</option></select>
            </div>
            {error ? <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-100">{error}</div> : null}
            <div className="overflow-x-auto rounded-xl border border-white/10"><table className="min-w-[920px] w-full text-left text-xs"><thead className="bg-white/[.04] text-white/55"><tr>
              <th className="w-12 whitespace-nowrap p-3">Select</th><th className="min-w-32 whitespace-nowrap p-3">Transaction date</th><th className="min-w-32 whitespace-nowrap p-3">Authorized date</th><th className="min-w-72 whitespace-nowrap p-3">Merchant / description</th><th className="min-w-28 whitespace-nowrap p-3">Amount</th><th className="min-w-28 whitespace-nowrap p-3">Status</th><th className="min-w-40 whitespace-nowrap p-3">Classification</th>
            </tr></thead><tbody>{(result?.rows || []).map((row) => <tr key={row.id} className="border-t border-white/8 text-white/80"><td className="p-3"><input type="checkbox" checked={selected?.has(row.id) || false} onChange={() => setSelected((current) => { const next = new Set(current || []); next.has(row.id) ? next.delete(row.id) : next.add(row.id); return next; })} /></td>
              <td className="whitespace-nowrap p-3">{row.transaction_date}</td><td className="whitespace-nowrap p-3">{row.authorized_date && row.authorized_date !== row.transaction_date ? row.authorized_date : "—"}</td><td className="p-3">{row.merchant_or_description}</td><td className={`whitespace-nowrap p-3 font-semibold ${row.amount >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{row.amount >= 0 ? "+" : "−"}{money(row.amount)}</td><td className="whitespace-nowrap p-3">{row.pending ? "Pending" : "Posted"}</td><td className="whitespace-nowrap p-3 capitalize">{row.activity_type.replaceAll("_", " ")}</td></tr>)}</tbody></table></div>
            <div className="mt-3 flex items-center justify-between text-xs text-white/55"><span>{result?.total ? `Showing ${(page - 1) * 25 + 1}–${Math.min(page * 25, result.total)} of ${result.total}` : "Showing 0 transactions"}</span><div className="flex gap-2"><GhostButton type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</GhostButton><GhostButton type="button" disabled={page * 25 >= (result?.total || 0)} onClick={() => setPage((p) => p + 1)}>Next</GhostButton></div></div>
          </> : <div className="rounded-xl border border-amber-400/25 bg-amber-500/5 p-5 text-sm text-white/75"><div className="text-base font-semibold text-white">Confirm controlled admission</div><p className="mt-2">Import <b>{count}</b> selected transactions. Skip {represented} existing rows and hold {summary.pending_replacements || 0} pending replacements.</p><p className="mt-2">Cutoff: {cutoffDate} · Operator confirmed. Nothing will be sent to QuickBooks; Auto-post stays off and the posting hold remains active.</p></div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-4"><GhostButton type="button" onClick={confirming ? () => setConfirming(false) : onClose}>{confirming ? "Back" : "Cancel"}</GhostButton>
          {!confirming ? <AccentButton type="button" disabled={!count} onClick={() => setConfirming(true)}>Import {count} selected transactions</AccentButton>
            : <AccentButton type="button" disabled={busy || !count} onClick={async () => { setBusy(true); setError(""); try { await onAdmit([...selected]); } catch (cause) { setError(cause?.message || "Admission failed."); setConfirming(false); } finally { setBusy(false); } }}>{busy ? "Importing…" : `Confirm import of ${count}`}</AccentButton>}</div>
      </div>
    </div>
  );
}

function PlaidIntegrationCard({ businessId, readOnly = false }) {
  const mappingOverrideStorageKey = useMemo(
    () => (businessId ? `bizzy:plaid-mapping-overrides:${businessId}` : null),
    [businessId]
  );
  const initialCachedStatus = useMemo(() => readPlaidStatusCache(businessId), [businessId]);
  const [loading, setLoading] = useState(() => !initialCachedStatus);
  const [linking, setLinking] = useState(false);
  const [repairingItem, setRepairingItem] = useState(null);
  const [repairResult, setRepairResult] = useState({});
  const [recoveryByItem, setRecoveryByItem] = useState({});
  const [recoveryBusy, setRecoveryBusy] = useState({});
  const [recoveryMessage, setRecoveryMessage] = useState({});
  const [lineageSelection, setLineageSelection] = useState({});
  const [recoveryReview, setRecoveryReview] = useState(null);
  const [disconnectingItem, setDisconnectingItem] = useState(null);
  const [disconnectingAll, setDisconnectingAll] = useState(false);
  const [confirmDisconnectAll, setConfirmDisconnectAll] = useState(false);
  const [confirmDisconnectByAccount, setConfirmDisconnectByAccount] = useState({});
  const [institutions, setInstitutions] = useState(() => initialCachedStatus?.institutions || []);
  const [counts, setCounts] = useState(() => initialCachedStatus?.counts || { institutions: 0, accounts: 0 });
  const [statusError, setStatusError] = useState("");
  const [hasDisconnected, setHasDisconnected] = useState(() => Boolean(initialCachedStatus?.hasDisconnected));
  const [mappingRows, setMappingRows] = useState([]);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [mappingError, setMappingError] = useState("");
  const [qboPaymentAccounts, setQboPaymentAccounts] = useState([]);
  const [mappingSaving, setMappingSaving] = useState({});
  const [mappingOverrides, setMappingOverrides] = useState({});
  const [mappingMessages, setMappingMessages] = useState({});
  const isConnected = counts.accounts > 0;
  const isDisconnected = !isConnected && hasDisconnected;
  const isEmpty = !isConnected && !hasDisconnected;

  useEffect(() => {
    const cached = readPlaidStatusCache(businessId);
    if (cached) {
      setInstitutions(cached.institutions || []);
      setCounts(cached.counts || { institutions: 0, accounts: 0 });
      setHasDisconnected(Boolean(cached.hasDisconnected));
      setLoading(false);
    } else {
      setInstitutions([]);
      setCounts({ institutions: 0, accounts: 0 });
      setHasDisconnected(false);
      setLoading(Boolean(businessId));
    }
    setStatusError("");
  }, [businessId]);

  const fetchStatus = useCallback(async ({ showLoading = false } = {}) => {
    if (!businessId) return;
    if (showLoading) setLoading(true);
    try {
      const res = await getPlaidStatus(businessId);
      if (res?.ok === false) {
        console.warn("[plaid][status] backend error", res?.error || res?.message);
        setStatusError("Plaid status unavailable. Try syncing again.");
        if (!readPlaidStatusCache(businessId)) {
          setInstitutions(res?.institutions || []);
          setCounts({ institutions: 0, accounts: 0 });
          setHasDisconnected(false);
        }
      } else {
        setStatusError("");
        const acctCount = res?.accounts_count || 0;
        const instCount = acctCount > 0 ? res?.institutions_count || 0 : 0;
        const nextInstitutions = acctCount > 0 ? res?.institutions || [] : [];
        const nextCounts = {
          institutions: instCount,
          accounts: acctCount,
        };
        const nextHasDisconnected = Boolean(res?.has_disconnected);
        setInstitutions(nextInstitutions);
        setCounts(nextCounts);
        setHasDisconnected(nextHasDisconnected);
        if (!readOnly) writePlaidStatusCache(businessId, {
          institutions: nextInstitutions,
          counts: nextCounts,
          hasDisconnected: nextHasDisconnected,
        });
      }
    } catch (err) {
      console.warn("[plaid][status] failed", err);
      setStatusError("Plaid status unavailable. Try syncing again.");
      if (!readPlaidStatusCache(businessId)) {
        setHasDisconnected(false);
      }
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [businessId, readOnly]);

  useEffect(() => {
    fetchStatus({ showLoading: !readPlaidStatusCache(businessId) });
  }, [fetchStatus]);

  const refreshMappings = useCallback(async () => {
    if (!businessId || readOnly) return;
    if (!isConnected) {
      setMappingRows([]);
      setQboPaymentAccounts([]);
      setMappingError("");
      setMappingLoading(false);
      return;
    }
    setMappingLoading(true);
    try {
      const [mappingsRes, qboRes] = await Promise.all([
        getAccountMappings(businessId),
        getQboPaymentAccounts(businessId),
      ]);
      setMappingRows(mappingsRes?.accounts || []);
      setQboPaymentAccounts(qboRes?.accounts || []);
      setMappingError("");
    } catch (err) {
      console.warn("[plaid][mapping] fetch failed", err?.message || err);
      setMappingError("Mapping status unavailable.");
    } finally {
      setMappingLoading(false);
    }
  }, [businessId, isConnected, readOnly]);

  useEffect(() => {
    refreshMappings();
  }, [refreshMappings]);

  useEffect(() => {
    if (!mappingOverrideStorageKey) {
      setMappingOverrides({});
      return;
    }
    try {
      const raw = window.localStorage.getItem(mappingOverrideStorageKey);
      const parsed = raw ? JSON.parse(raw) : {};
      setMappingOverrides(parsed && typeof parsed === "object" ? parsed : {});
    } catch {
      setMappingOverrides({});
    }
  }, [mappingOverrideStorageKey]);

  useEffect(() => {
    if (!mappingOverrideStorageKey) return;
    try {
      const entries = Object.entries(mappingOverrides || {}).filter(([, value]) => value === "__none__");
      if (!entries.length) {
        window.localStorage.removeItem(mappingOverrideStorageKey);
        return;
      }
      window.localStorage.setItem(mappingOverrideStorageKey, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      /* ignore */
    }
  }, [mappingOverrideStorageKey, mappingOverrides]);

  const openPlaid = useCallback(async () => {
    if (!businessId) return;
    setLinking(true);
    try {
      const tokenResp = await createPlaidLinkToken(businessId);
      const linkToken =
        tokenResp?.link_token || tokenResp?.linkToken || tokenResp?.token;
      if (!linkToken) throw new Error("Link token unavailable");
      const Plaid = await loadPlaidScript();
      await new Promise((resolve, reject) => {
        const handler = Plaid.create({
          token: linkToken,
          onSuccess: async (public_token, metadata) => {
            try {
              await exchangePlaidPublicToken(businessId, public_token, metadata, tokenResp?.link_session);
              await triggerPlaidSync(businessId);
              await fetchStatus();
              await refreshMappings();
              resolve();
            } catch (e) {
              reject(e);
            } finally {
              handler?.destroy?.();
            }
          },
          onExit: (err) => {
            handler?.destroy?.();
            if (err) reject(err);
            else resolve();
          },
        });
        handler.open();
      });
    } catch (err) {
      console.warn("[plaid][link] failed", err?.message || err);
    } finally {
      setLinking(false);
    }
  }, [businessId, fetchStatus, readOnly, refreshMappings]);

  const repairPlaidItem = useCallback(async (plaidItemId, institutionName) => {
    if (!businessId || !plaidItemId || readOnly) return;
    setRepairingItem(plaidItemId);
    setRepairResult((current) => ({ ...current, [plaidItemId]: null }));
    try {
      const tokenResponse = await createPlaidUpdateLinkToken(businessId, plaidItemId);
      const Plaid = await loadPlaidScript();
      await new Promise((resolve, reject) => {
        const handler = Plaid.create({
          token: tokenResponse?.link_token,
          onSuccess: async () => {
            try {
              const result = await completePlaidRepair(businessId, plaidItemId);
              setRepairResult((current) => ({ ...current, [plaidItemId]: result }));
              const durable = await getPlaidRecoveryStatus(businessId, plaidItemId);
              setRecoveryByItem((current) => ({ ...current, [plaidItemId]: durable }));
              await fetchStatus();
              resolve();
            } catch (error) { reject(error); }
            finally { handler?.destroy?.(); }
          },
          onExit: (error) => {
            handler?.destroy?.();
            if (error) reject(error); else resolve();
          },
        });
        handler.open();
      });
    } catch (error) {
      console.warn("[plaid][repair] failed", error?.message || error);
      setRepairResult((current) => ({ ...current, [plaidItemId]: { ok: false, status: "failed", institution_name: institutionName } }));
    } finally {
      setRepairingItem(null);
    }
  }, [businessId, fetchStatus, readOnly]);

  const refreshRecoveryStatus = useCallback(async (plaidItemId) => {
    if (!businessId || !plaidItemId) return null;
    const result = await getPlaidRecoveryStatus(businessId, plaidItemId);
    if (result?.ok === false) throw new Error(result?.message || result?.error || "Recovery status unavailable");
    setRecoveryByItem((current) => ({ ...current, [plaidItemId]: result }));
    return result;
  }, [businessId]);

  useEffect(() => {
    if (!businessId || !institutions.length) return;
    let cancelled = false;
    Promise.all(institutions.map(async (inst) => {
      try {
        const result = await getPlaidRecoveryStatus(businessId, inst.plaid_item_id);
        return [inst.plaid_item_id, result];
      } catch (error) {
        return [inst.plaid_item_id, { ok: false, error: error?.code || "plaid_recovery_status_failed", message: error?.message || "Recovery status could not be loaded." }];
      }
    })).then((pairs) => {
      if (!cancelled) setRecoveryByItem(Object.fromEntries(pairs));
    });
    return () => { cancelled = true; };
  }, [businessId, institutions]);

  const runRecoveryAction = useCallback(async (plaidItemId, action) => {
    if (readOnly || recoveryBusy[plaidItemId]) return;
    setRecoveryBusy((current) => ({ ...current, [plaidItemId]: true }));
    setRecoveryMessage((current) => ({ ...current, [plaidItemId]: null }));
    try {
      const result = await action();
      if (result?.ok === false) throw new Error(result?.message || result?.error || "Recovery action failed");
      let status = await refreshRecoveryStatus(plaidItemId);
      for (let attempt = 0; status?.batch?.status === "staging" && attempt < 12; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        status = await refreshRecoveryStatus(plaidItemId);
      }
      setRecoveryMessage((current) => ({ ...current, [plaidItemId]: { tone: "ok", text: "Recovery state saved." } }));
    } catch (error) {
      setRecoveryMessage((current) => ({ ...current, [plaidItemId]: { tone: "error", text: error?.message || "Recovery action failed." } }));
    } finally {
      setRecoveryBusy((current) => ({ ...current, [plaidItemId]: false }));
    }
  }, [readOnly, recoveryBusy, refreshRecoveryStatus]);

  const prepareRecoveryPreview = useCallback(async (plaidItemId) => {
    try {
      const result = await preparePlaidRecoveryPreview(businessId, plaidItemId, REPLACEMENT_CARD_CUTOFF_DATE);
      if (result?.ok !== false) return result;
      const durable = await refreshRecoveryStatus(plaidItemId).catch(() => null);
      if (["preview_ready", "lineage_confirmation_required"].includes(durable?.batch?.status)) {
        return { ok: true, recovered_from_status: true };
      }
      return result;
    } catch (error) {
      // Preview creation is durable. If the response was lost after the server
      // committed it, recover the saved batch instead of asking for another sync.
      const durable = await refreshRecoveryStatus(plaidItemId).catch(() => null);
      if (["preview_ready", "lineage_confirmation_required"].includes(durable?.batch?.status)) {
        return { ok: true, recovered_from_status: true };
      }
      throw error;
    }
  }, [businessId, refreshRecoveryStatus]);

  const handleDisconnectAll = useCallback(async () => {
    if (!businessId || readOnly) return;
    setDisconnectingAll(true);
    try {
      await disconnectPlaid(businessId);
      try {
        window.localStorage.setItem("bizzy:plaid_connected", "false");
        window.dispatchEvent(new Event("bizzy:onboarding-flags-updated"));
      } catch {
        /* ignore */
      }
      clearPlaidStatusCache(businessId);
      setInstitutions([]);
      setCounts({ institutions: 0, accounts: 0 });
      setHasDisconnected(true);
      writePlaidStatusCache(businessId, {
        institutions: [],
        counts: { institutions: 0, accounts: 0 },
        hasDisconnected: true,
      });
      setConfirmDisconnectAll(false);
      await fetchStatus();
      await refreshMappings();
    } catch (err) {
      console.warn("[plaid][disconnect] failed", err);
    } finally {
      setDisconnectingAll(false);
    }
  }, [businessId, fetchStatus, readOnly, refreshMappings]);

  const toggleDisconnectConfirm = useCallback((acctId) => {
    setConfirmDisconnectByAccount((prev) => ({
      ...prev,
      [acctId]: !prev[acctId],
    }));
  }, []);

  const handleDisconnectItem = useCallback(async (plaidItemId) => {
    if (!businessId || readOnly || !plaidItemId) return;
    setDisconnectingItem(plaidItemId);
    try {
      await disconnectPlaidItem(businessId, plaidItemId);
      try {
        window.localStorage.setItem("bizzy:plaid_connected", "false");
        window.dispatchEvent(new Event("bizzy:onboarding-flags-updated"));
      } catch {
        /* ignore */
      }
      setConfirmDisconnectByAccount({});
      await fetchStatus({ showLoading: false });
      await refreshMappings();
    } catch (err) {
      console.warn("[plaid][disconnect-item] failed", err);
    } finally {
      setDisconnectingItem(null);
    }
  }, [businessId, fetchStatus, readOnly, refreshMappings]);

  const latestSyncAt = useMemo(() => {
    const timestamps = institutions
      .map((inst) => (inst.last_sync_at ? Date.parse(inst.last_sync_at) : null))
      .filter(Boolean);
    if (!timestamps.length) return null;
    return new Date(Math.max(...timestamps));
  }, [institutions]);

  const mappingById = useMemo(() => {
    const map = new Map();
    (mappingRows || []).forEach((row) => {
      if (row?.plaid_account_id) map.set(row.plaid_account_id, row);
    });
    return map;
  }, [mappingRows]);
  const visiblePlaidAccountIds = useMemo(() => {
    const ids = new Set();
    (institutions || []).forEach((inst) => {
      (inst?.accounts || []).forEach((acct) => {
        if (acct?.plaid_account_id) ids.add(acct.plaid_account_id);
      });
    });
    return ids;
  }, [institutions]);
  const unmappedPostableRows = useMemo(() => {
    if (!isConnected) return [];
    return (mappingRows || []).filter((row) => {
      if (visiblePlaidAccountIds.size > 0 && !visiblePlaidAccountIds.has(row?.plaid_account_id)) return false;
      if (!row?.requires_mapping || row?.posting_category === "NotUsed") return false;
      const overrideValue = mappingOverrides?.[row.plaid_account_id];
      if (overrideValue === "__none__") return false;
      return !(overrideValue || row?.mapped);
    });
  }, [isConnected, mappingOverrides, mappingRows, visiblePlaidAccountIds]);
  const hasMappingNeeds = unmappedPostableRows.length > 0;

  const handleMappingChange = useCallback(async (plaidAccountId, value) => {
    if (!businessId || readOnly || !plaidAccountId) return;
    setMappingSaving((prev) => ({ ...prev, [plaidAccountId]: true }));
    try {
      if (value === "__create__") {
        const ensured = await ensureQboPaymentAccount(businessId, plaidAccountId);
        const qboId = ensured?.account?.id || null;
        if (qboId) {
          const ensuredAccount = {
            id: String(qboId),
            name: ensured?.account?.name || "QuickBooks account",
            type: ensured?.account?.type || null,
          };
          setQboPaymentAccounts((prev) => {
            const exists = (prev || []).some((opt) => String(opt.id) === String(qboId));
            return exists ? prev : [...(prev || []), ensuredAccount];
          });
          await updateAccountMapping(businessId, {
            plaid_account_id: plaidAccountId,
            qbo_account_id: qboId,
          });
          setMappingMessages((prev) => ({
            ...prev,
            [plaidAccountId]: ensured?.created
              ? `Created a new QuickBooks account: ${ensuredAccount.name}. You can confirm it in QBO under Chart of accounts.`
              : `Mapped to existing QuickBooks account: ${ensuredAccount.name}.`,
          }));
          setMappingOverrides((prev) => {
            const next = { ...prev };
            delete next[plaidAccountId];
            return next;
          });
          setMappingRows((prev) =>
            prev.map((row) =>
              row.plaid_account_id === plaidAccountId
                ? {
                    ...row,
                    mapped: true,
                    qbo_account_id: String(qboId),
                    qbo_account_name: ensuredAccount.name || row.qbo_account_name || null,
                    qbo_account_type: ensuredAccount.type || row.qbo_account_type || null,
                  }
                : row
            )
          );
        }
      } else if (value === "__none__" || value === "") {
        await updateAccountMapping(businessId, {
          plaid_account_id: plaidAccountId,
          qbo_account_id: "__none__",
        });
        setMappingOverrides((prev) => ({ ...prev, [plaidAccountId]: "__none__" }));
        setMappingMessages((prev) => {
          const next = { ...prev };
          delete next[plaidAccountId];
          return next;
        });
        setMappingRows((prev) =>
          prev.map((row) =>
            row.plaid_account_id === plaidAccountId
              ? {
                  ...row,
                  mapped: false,
                  qbo_account_id: null,
                  qbo_account_name: null,
                }
              : row
          )
        );
      } else {
        await updateAccountMapping(businessId, {
          plaid_account_id: plaidAccountId,
          qbo_account_id: value,
        });
        setMappingOverrides((prev) => {
          const next = { ...prev };
          delete next[plaidAccountId];
          return next;
        });
        setMappingMessages((prev) => {
          const selectedName = qboPaymentAccounts.find((opt) => String(opt.id) === String(value))?.name || "QuickBooks account";
          return { ...prev, [plaidAccountId]: `Mapped to QuickBooks account: ${selectedName}.` };
        });
        setMappingRows((prev) =>
          prev.map((row) =>
            row.plaid_account_id === plaidAccountId
              ? {
                  ...row,
                  mapped: true,
                  qbo_account_id: String(value),
                  qbo_account_name:
                    qboPaymentAccounts.find((opt) => String(opt.id) === String(value))?.name || row.qbo_account_name || null,
                }
              : row
          )
        );
      }
      await refreshMappings();
    } catch (err) {
      console.warn("[plaid][mapping] update failed", err?.message || err);
    } finally {
      setMappingSaving((prev) => ({ ...prev, [plaidAccountId]: false }));
    }
  }, [businessId, qboPaymentAccounts, readOnly, refreshMappings]);

  return (
    <div
      className="mt-3 rounded-xl px-4 py-4"
      style={{
        background: ROW_BG,
        border: `1px solid ${SOFT_BORDER}`,
      }}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <LinkIcon className="h-4 w-4" style={{ color: "var(--accent)" }} />
            <span className="text-sm font-semibold">Plaid (Bank Sync)</span>
            <StatusPill state={isConnected ? "connected" : "disconnected"} />
          </div>
          <p className="text-xs" style={{ color: TEXT_MUTED }}>
            Sync bank transactions and account balances.
          </p>
          <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.55)" }}>
            {isDisconnected
              ? "Status: Disconnected"
              : `Connected: ${counts.institutions} institution${counts.institutions === 1 ? "" : "s"} · ${counts.accounts} account${counts.accounts === 1 ? "" : "s"}`}
          </p>
          {latestSyncAt ? (
            <p className="text-[11px] text-white/50">Last sync {formatRelative(latestSyncAt.getTime())}</p>
          ) : null}
        </div>
        {isConnected ? (
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
          <GhostButton onClick={openPlaid} disabled={readOnly || linking} className={INTEGRATION_ACTION_BUTTON_CLASS}>
            {linking ? "Opening…" : "Add another bank"}
          </GhostButton>
          {confirmDisconnectAll ? (
            <>
              <GhostButton
                onClick={handleDisconnectAll}
                disabled={readOnly || disconnectingAll}
                className={`${INTEGRATION_ACTION_BUTTON_CLASS} text-rose-200 border-rose-400/40 hover:border-rose-300/60`}
              >
                {disconnectingAll ? "Disconnecting…" : "Confirm disconnect"}
              </GhostButton>
              <GhostButton
                onClick={() => setConfirmDisconnectAll(false)}
                className={INTEGRATION_ACTION_BUTTON_CLASS}
              >
                Cancel
              </GhostButton>
            </>
          ) : (
            <GhostButton
              onClick={() => {
                if (!readOnly) setConfirmDisconnectAll(true);
              }}
              disabled={readOnly}
              className={`${INTEGRATION_ACTION_BUTTON_CLASS} text-rose-200 border-rose-400/40 hover:border-rose-300/60`}
            >
              Disconnect Plaid
            </GhostButton>
          )}
        </div>
      ) : isDisconnected ? (
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
          <AccentButton onClick={openPlaid} disabled={readOnly || linking} className={INTEGRATION_ACTION_BUTTON_CLASS}>
            {linking ? "Opening…" : "Reconnect Plaid"}
          </AccentButton>
        </div>
      ) : (
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
          <AccentButton onClick={openPlaid} disabled={readOnly || linking} className={INTEGRATION_ACTION_BUTTON_CLASS}>
            {linking ? "Opening…" : "Connect Plaid"}
          </AccentButton>
        </div>
      )}
      </div>
      {statusError ? (
        <p className="mt-1 text-[11px] text-white/50">{statusError}</p>
      ) : null}
      {mappingError ? (
        <p className="mt-1 text-[11px] text-white/50">{mappingError}</p>
      ) : null}
      {hasMappingNeeds ? (
        <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
          Bizzi can’t post from {unmappedPostableRows.length} postable account{unmappedPostableRows.length === 1 ? "" : "s"} until mapped.
          Please select the appropriate account or create a new one for each unmapped account.
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        {loading ? (
          <p className="text-xs text-white/60">Loading institutions…</p>
        ) : isDisconnected ? (
          <div className="rounded-lg border border-emerald-400/20 bg-emerald-500/5 px-3 py-3 text-xs text-emerald-100">
            Disconnected — your historical data is still saved.
            <div className="mt-1 text-[11px] text-emerald-200/80">
              Disconnect stops new transactions from syncing. Your historical transactions and categorizations stay saved.
            </div>
          </div>
        ) : isEmpty ? (
          <div className="rounded-lg border px-3 py-3 text-xs text-white/70" style={{ borderColor: SOFT_BORDER, background: ROW_BG }}>
            No banks connected yet. Add a bank to start syncing transactions.
          </div>
        ) : (
          institutions.map((inst) => (
            <div
              key={inst.plaid_item_id}
              className="border-t px-0 py-3 first:border-t-0"
              style={{ borderColor: SOFT_BORDER }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white/90">
                    {inst.institution_name || "Institution"}
                  </span>
                  {inst.status === "connected" ? (
                    <StatusPill state="connected" />
                  ) : (
                    <StatusBadge
                      tone="warning"
                      label={inst.status || "Unknown"}
                    />
                  )}
                </div>
                {inst.last_sync_at ? (
                  <span className="text-[11px] text-white/50">
                    Last sync {formatRelative(Date.parse(inst.last_sync_at))}
                  </span>
                ) : null}
              </div>
              <div className="mt-1 text-[11px] text-white/50">
                Disconnect stops new transactions from syncing. Your historical transactions and categorizations stay saved.
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <GhostButton
                  onClick={() => repairPlaidItem(inst.plaid_item_id, inst.institution_name)}
                  disabled={readOnly || repairingItem === inst.plaid_item_id}
                  className="inline-flex h-8 items-center justify-center whitespace-nowrap rounded-lg px-3 text-xs font-semibold"
                >
                  {repairingItem === inst.plaid_item_id ? "Opening repair…" : `Repair ${inst.institution_name || "connection"}`}
                </GhostButton>
                {repairResult?.[inst.plaid_item_id]?.status === "lineage_confirmation_required" ? (
                  <span className="text-[11px] text-amber-200">New account identity found. Ingestion is paused pending authorized lineage confirmation.</span>
                ) : repairResult?.[inst.plaid_item_id]?.status === "awaiting_account_selection" ? (
                  <span className="text-[11px] text-emerald-200">Connection repaired. Select the replacement account to continue the durable recovery review.</span>
                ) : repairResult?.[inst.plaid_item_id]?.status === "failed" ? (
                  <span className="text-[11px] text-rose-200">Repair could not be completed. Existing history remains unchanged.</span>
                ) : null}
                {recoveryByItem[inst.plaid_item_id]?.ok === false ? (
                  <span className="text-[11px] text-rose-200">{recoveryByItem[inst.plaid_item_id]?.message || "Durable recovery status is unavailable."}</span>
                ) : null}
                {!recoveryByItem[inst.plaid_item_id]?.orchestration?.status
                  && (recoveryByItem[inst.plaid_item_id]?.recovery_required
                    || ["awaiting_account_selection", "lineage_confirmation_required"].includes(repairResult?.[inst.plaid_item_id]?.status)) ? (
                  <GhostButton type="button" disabled={readOnly || Boolean(recoveryBusy[inst.plaid_item_id])}
                    onClick={() => runRecoveryAction(inst.plaid_item_id, () => bootstrapPlaidRecoveryState(businessId, inst.plaid_item_id))}
                    className="inline-flex h-8 items-center justify-center whitespace-nowrap rounded-lg px-3 text-xs font-semibold">
                    Resume replacement recovery
                  </GhostButton>
                ) : null}
              </div>
              {(() => {
                const recovery = recoveryByItem[inst.plaid_item_id];
                const orchestration = recovery?.orchestration || null;
                const pendingCandidate = recovery?.candidates?.find((candidate) => candidate.status === "pending");
                const batch = recovery?.batch || null;
                const summary = batch?.summary || {};
                const busy = Boolean(recoveryBusy[inst.plaid_item_id]);
                const selectionKey = pendingCandidate ? `${inst.plaid_item_id}:${pendingCandidate.id}` : null;
                const selectedPriorAccount = selectionKey ? lineageSelection[selectionKey] : null;
                if (!recovery || (!orchestration?.status && !(recovery.candidates || []).length && !batch)) return null;
                return (
                  <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-500/[0.06] p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-xs font-semibold text-amber-100">Replacement card recovery</div>
                        <div className="mt-1 text-[11px] text-white/55">
                          Source coverage and staged cursor are reviewed separately. Nothing in this panel posts to QuickBooks.
                        </div>
                      </div>
                      <StatusBadge tone={batch?.status === "released" ? "ok" : "warning"} label={(batch?.status || "lineage review").replaceAll("_", " ")} />
                    </div>

                    {orchestration?.status === "awaiting_account_selection" ? (
                      <div className="mt-3 rounded-lg border border-white/10 bg-black/15 p-3">
                        <div className="text-xs text-white/80">Select the repaired replacement-card account. Its mask is informational and is not used to infer lineage.</div>
                        <div className="mt-2">
                          <DarkMappingDropdown
                            className="w-full sm:max-w-md"
                            value={lineageSelection[`${inst.plaid_item_id}:replacement`] || ""}
                            onChange={(value) => setLineageSelection((current) => ({ ...current, [`${inst.plaid_item_id}:replacement`]: value }))}
                            disabled={readOnly || busy}
                            placeholder="Select replacement account…"
                            options={(inst.accounts || []).map((account) => {
                              const mapping = mappingById.get(account.plaid_account_id);
                              return {
                                value: account.plaid_account_id,
                                label: `${account.name || account.official_name || "Account"}${account.mask ? ` ••${account.mask}` : ""}${mapping?.qbo_account_name ? ` → ${mapping.qbo_account_name}` : ""}`,
                              };
                            })}
                          />
                        </div>
                        <div className="mt-2"><AccentButton type="button" className="h-9 px-3 text-xs"
                          disabled={readOnly || busy || !lineageSelection[`${inst.plaid_item_id}:replacement`]}
                          onClick={() => runRecoveryAction(inst.plaid_item_id, () => selectPlaidReplacementRecoveryAccount(businessId, inst.plaid_item_id, lineageSelection[`${inst.plaid_item_id}:replacement`]))}>
                          {busy ? "Saving…" : "Continue to lineage confirmation"}
                        </AccentButton></div>
                      </div>
                    ) : null}

                    {pendingCandidate ? (
                      <div className="mt-3 rounded-lg border border-white/10 bg-black/15 p-3">
                        <div className="text-xs text-white/80">
                          Confirm that {pendingCandidate.name}{pendingCandidate.mask ? ` ••${pendingCandidate.mask}` : ""} replaces an existing account.
                        </div>
                        <div className="mt-2">
                          <DarkMappingDropdown
                            className="w-full sm:max-w-md"
                            value={selectedPriorAccount || ""}
                            onChange={(value) => setLineageSelection((current) => ({ ...current, [selectionKey]: value }))}
                            disabled={readOnly || busy}
                            placeholder="Select prior account…"
                            options={(inst.accounts || []).map((account) => ({
                              value: account.plaid_account_id,
                              label: `${account.name || account.official_name || "Account"}${account.mask ? ` ••${account.mask}` : ""}`,
                            }))}
                          />
                        </div>
                        <div className="mt-2">
                          <AccentButton
                            type="button"
                            disabled={readOnly || busy || !selectedPriorAccount}
                            onClick={() => runRecoveryAction(inst.plaid_item_id, () => confirmPlaidReplacementLineage(businessId, inst.plaid_item_id, {
                              candidate_id: pendingCandidate.id,
                              prior_plaid_account_id: selectedPriorAccount,
                            }))}
                            className="h-9 px-3 text-xs"
                          >
                            {busy ? "Saving…" : "Confirm account lineage"}
                          </AccentButton>
                        </div>
                      </div>
                    ) : null}

                    {!pendingCandidate && orchestration?.status === "ready_for_preview" && (!batch || ["failed", "abandoned"].includes(batch.status)) ? (
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <AccentButton
                          type="button"
                          disabled={readOnly || busy}
                          onClick={() => runRecoveryAction(inst.plaid_item_id, () => prepareRecoveryPreview(inst.plaid_item_id))}
                          className="h-9 px-3 text-xs"
                        >
                          {busy ? "Preparing…" : batch ? "Retry recovery preview" : "Prepare recovery preview"}
                        </AccentButton>
                        <span className="text-[11px] text-white/55">Controlled cutoff: Aug 27, 2026</span>
                      </div>
                    ) : null}

                    {batch ? (
                      <div className="mt-3">
                        <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                          {[
                            ["Added", summary.total_added], ["Modified", summary.total_modified], ["Removed", summary.total_removed],
                            ["Already represented", (summary.exact_existing || 0) + (summary.represented || 0)],
                            ["Pending replacements", summary.pending_replacements], ["Historical discrepancies", summary.historical_discrepancies],
                            ["New after cutoff", summary.new_after_cutoff], ["Probable duplicates", summary.probable_duplicates],
                            ["Ambiguous", summary.ambiguous], ["Unknown accounts", summary.unknown_account_ids?.length || 0],
                          ].map(([label, value]) => (
                            <div key={label} className="rounded-lg border border-white/8 bg-black/10 px-2 py-2">
                              <div className="text-white/45">{label}</div><div className="mt-0.5 font-semibold text-white/85">{value || 0}</div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 text-[11px] text-white/55">
                          Source cutoff {batch.cutoff_date}. Staged cursor is not committed until controlled admission.
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {batch.status === "preview_ready" ? (
                            <AccentButton type="button" disabled={readOnly || busy || summary.ambiguous > 0 || summary.probable_duplicates > 0}
                              onClick={() => setRecoveryReview({ plaidItemId: inst.plaid_item_id, batch })}
                              className="h-9 px-3 text-xs">
                              {`Review ${summary.new_after_cutoff || 0} new transactions`}
                            </AccentButton>
                          ) : null}
                          {batch.status === "imported_held" ? (
                            <AccentButton type="button" disabled={readOnly || busy}
                              onClick={() => runRecoveryAction(inst.plaid_item_id, () => releasePlaidRecoveryHold(businessId, batch.batch_id))}
                              className="h-9 px-3 text-xs">
                              {busy ? "Releasing…" : "Release posting hold"}
                            </AccentButton>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    {recoveryMessage[inst.plaid_item_id] ? (
                      <div className={`mt-2 text-[11px] ${recoveryMessage[inst.plaid_item_id].tone === "error" ? "text-rose-200" : "text-emerald-200"}`}>
                        {recoveryMessage[inst.plaid_item_id].text}
                      </div>
                    ) : null}
                  </div>
                );
              })()}
                  <div className="mt-2">
                {(inst.accounts || []).map((acct) => {
                  const mappingInfo = mappingById.get(acct.plaid_account_id) || null;
                  const overrideValue = mappingOverrides?.[acct.plaid_account_id];
                  const mappedFlag = overrideValue === "__none__"
                    ? false
                    : overrideValue
                      ? true
                      : (mappingInfo?.mapped ?? acct.mapped_to_qbo);
                  const dismissedFlag = overrideValue === "__none__";
                  const suggested = mappingInfo?.suggested || null;
                  const typeNeeded = mappingInfo?.qbo_options_hint?.type_needed || null;
                  const postingCategory = mappingInfo?.posting_category || null;
                  const requiresMapping = mappingInfo?.requires_mapping;
                  const baseQboOptions = typeNeeded
                    ? qboPaymentAccounts.filter((opt) => opt?.type === typeNeeded)
                    : qboPaymentAccounts;
                  const selectedMappedOption =
                    mappingInfo?.qbo_account_id && mappingInfo?.qbo_account_name
                      ? {
                          id: String(mappingInfo.qbo_account_id),
                          name: mappingInfo.qbo_account_name,
                          type: mappingInfo.qbo_account_type || typeNeeded || null,
                        }
                      : null;
                  const qboOptions =
                    selectedMappedOption &&
                    !baseQboOptions.some((opt) => String(opt.id) === String(selectedMappedOption.id))
                      ? [...baseQboOptions, selectedMappedOption]
                      : baseQboOptions;
                  const missingQboOptionsMessage =
                    requiresMapping && !mappedFlag && typeNeeded && qboOptions.length === 0
                      ? typeNeeded === "CreditCard"
                        ? "No QuickBooks Credit Card accounts found. Create one to map this Plaid card."
                        : "No QuickBooks Bank accounts found. Create one to map this Plaid account."
                      : null;
                  const mappingMessage = mappingMessages?.[acct.plaid_account_id] || null;
                  const optionIds = new Set(qboOptions.map((o) => String(o.id)));
                  const selectedValueRaw = overrideValue
                    ? overrideValue
                    : mappedFlag
                      ? mappingInfo?.qbo_account_id || ""
                      : dismissedFlag
                        ? "__none__"
                        : suggested?.qbo_account_id || "";
                  const selectedValue =
                    selectedValueRaw === "__none__"
                      ? "__none__"
                      : selectedValueRaw && optionIds.has(String(selectedValueRaw))
                      ? String(selectedValueRaw)
                      : "";
                  const saving = Boolean(mappingSaving?.[acct.plaid_account_id]);
                  const suggestionLabel =
                    suggested?.qbo_account_name ||
                    qboOptions.find((opt) => String(opt.id) === String(suggested?.qbo_account_id))?.name ||
                    null;

                  return (
                    <div
                      key={acct.plaid_account_id}
                      className="flex items-center justify-between gap-3 border-t px-0 py-2 first:border-t-0"
                      style={{ borderColor: SOFT_BORDER }}
                    >
                      <div className="flex flex-col">
                        <span className="text-sm text-white/90">
                          {acct.name || acct.official_name || "Account"} {acct.mask ? `••${acct.mask}` : ""}
                        </span>
                        <span className="text-[11px] text-white/60">
                          {acct.type || "—"} {acct.subtype ? `· ${acct.subtype}` : ""}
                        </span>
                        {postingCategory === "NotUsed" ? (
                          <span className="mt-1 text-[10px] text-white/45">Not used for posting.</span>
                        ) : null}
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <div className="flex items-center gap-2">
                          <StatusBadge
                            tone={mappedFlag ? "ok" : requiresMapping ? "warning" : "slate"}
                            label={mappedFlag ? "Mapped" : requiresMapping ? "Needs mapping" : "Not used"}
                          />
                          {suggested && !mappedFlag && !dismissedFlag ? (
                            <StatusBadge tone="warning" label="Suggested review" />
                          ) : null}
                          <StatusBadge
                            tone={acct.is_active ? "ok" : "warning"}
                            label={acct.is_active ? "Active" : "Inactive"}
                          />
                        </div>
                        {postingCategory !== "NotUsed" ? (
                          <DarkMappingDropdown
                            value={selectedValue}
                            onChange={(nextValue) => handleMappingChange(acct.plaid_account_id, nextValue)}
                            disabled={readOnly || mappingLoading || saving}
                            placeholder="Select QuickBooks account..."
                            options={[
                              { value: "__none__", label: "None / remove mapping" },
                              ...qboOptions.map((opt) => ({
                                value: String(opt.id),
                                label:
                                  `${opt.name}${
                                    suggested && !mappedFlag && !dismissedFlag && String(suggested.qbo_account_id) === String(opt.id)
                                      ? " (Suggested)"
                                      : ""
                                  }`,
                              })),
                              { value: "__create__", label: "Find or create matching QuickBooks account..." },
                            ]}
                          />
                        ) : null}
                        {suggested && !mappedFlag && !dismissedFlag ? (
                          <div className="max-w-[18rem] text-right text-[10px] text-amber-100/85">
                            Suggested match{suggestionLabel ? `: ${suggestionLabel}` : ""}. Review before confirming.
                          </div>
                        ) : null}
                        {missingQboOptionsMessage ? (
                          <div className="max-w-[18rem] text-right text-[10px] leading-snug text-amber-100/85">
                            {missingQboOptionsMessage}
                          </div>
                        ) : null}
                        {mappingMessage ? (
                          <div className="max-w-[18rem] text-right text-[10px] leading-snug text-emerald-100/85">
                            {mappingMessage}
                          </div>
                        ) : null}
                        {acct.plaid_item_id && acct.plaid_item_id !== "unknown" ? (
                          confirmDisconnectByAccount[acct.plaid_account_id] ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleDisconnectItem(acct.plaid_item_id)}
                                disabled={readOnly || disconnectingItem === acct.plaid_item_id}
                                className="px-2 py-1 text-[11px] rounded-md border border-rose-400/40 text-rose-200 hover:border-rose-300/70 hover:text-rose-100 transition disabled:opacity-50"
                              >
                                {disconnectingItem === acct.plaid_item_id ? "Disconnecting…" : "Confirm"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (!readOnly) toggleDisconnectConfirm(acct.plaid_account_id);
                                }}
                                disabled={readOnly}
                                className="px-2 py-1 text-[11px] rounded-md border border-white/15 text-white/60 hover:text-white/80 transition"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                if (!readOnly) toggleDisconnectConfirm(acct.plaid_account_id);
                              }}
                              disabled={readOnly}
                              className="px-2 py-1 text-[11px] rounded-md border border-white/15 text-white/60 hover:text-white/80 hover:border-white/30 transition"
                            >
                              Disconnect
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
      {recoveryReview ? (
        <RecoveryTransactionReviewModal
          businessId={businessId}
          plaidItemId={recoveryReview.plaidItemId}
          batch={recoveryReview.batch}
          onClose={() => setRecoveryReview(null)}
          onAdmit={async (selectedRowIds) => {
            const result = await admitPlaidRecoveryBatch(businessId, recoveryReview.plaidItemId, recoveryReview.batch.batch_id, selectedRowIds);
            if (result?.ok === false) throw new Error(result?.message || result?.error || "Recovery admission failed.");
            await refreshRecoveryStatus(recoveryReview.plaidItemId);
            setRecoveryMessage((current) => ({ ...current, [recoveryReview.plaidItemId]: { tone: "ok", text: `${selectedRowIds.length} reviewed transactions imported with posting hold active.` } }));
            setRecoveryReview(null);
          }}
        />
      ) : null}
    </div>
  );
}

/* ---------------- UI helpers ---------------- */

function Badge({ children }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
      style={{ background: ROW_BG, border: `1px solid ${SOFT_BORDER}`, color: TEXT_MUTED, boxShadow: "none" }}
    >
      {children}
    </span>
  );
}

function DarkMappingDropdown({
  value,
  onChange,
  options = [],
  placeholder = "Select...",
  disabled = false,
  className = "w-[22rem] max-w-full",
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const selected = useMemo(
    () => (options || []).find((opt) => String(opt.value) === String(value)) || null,
    [options, value]
  );

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[11px] text-white/90 transition-all duration-150 ease-out hover:border-white/24 focus:outline-none disabled:opacity-60"
        style={{ background: "var(--input-bg)", borderColor: SOFT_BORDER, boxShadow: "none" }}
      >
        <span className={`truncate text-left ${selected ? "text-white/90" : "text-white/55"}`}>
          {selected?.label || placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-white/65 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      <div
        className={`absolute right-0 z-40 mt-2 w-full overflow-hidden rounded-xl border bg-[rgba(10,12,16,0.98)] shadow-[0_14px_34px_rgba(0,0,0,0.44)] transition-all duration-150 ${
          open ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0"
        }`}
        style={{ borderColor: NEUTRAL_BORDER }}
      >
        <div className="max-h-72 overflow-y-auto py-1">
          {(options || []).map((opt) => {
            const active = String(opt.value) === String(value);
            return (
              <button
                key={String(opt.value)}
                type="button"
                onClick={() => {
                  onChange?.(opt.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition ${
                  active
                    ? "bg-white/8 text-white"
                    : "text-white/80 hover:bg-white/6 hover:text-white"
                }`}
              >
                <span className="truncate">{opt.label}</span>
                {active ? <Check className="h-4 w-4 shrink-0 text-emerald-300" /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Section({ title, subtitle, icon: Icon, children, className = "" }) {
  return (
    <div
      className={`m-0 w-full rounded-xl border p-4 sm:p-5 ${className}`}
      style={{ background: "rgba(17,19,18,0.58)", border: `1px solid ${SOFT_BORDER}`, boxShadow: "none" }}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="h-4 w-4 text-white/75" />}
          <h2 className="text-base font-semibold">{title}</h2>
        </div>
      </div>
      {subtitle && <p className="text-xs mb-4" style={{ color: TEXT_MUTED }}>{subtitle}</p>}
      {children}
    </div>
  );
}

function Field({ label, children }) {
  const child = React.Children.only(children);
  const childId = React.isValidElement(child) ? child.props.id || child.props.name : undefined;
  return (
    <div className="mb-3">
      <label htmlFor={childId} className="block text-[11px] uppercase tracking-wide mb-1" style={{ color: TEXT_MUTED }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Input(props) {
  const generatedId = React.useId();
  const id = props.id || props.name || generatedId;
  const name = props.name || props.id || generatedId;
  return (
    <input
      {...props}
      id={id}
      name={name}
      className="w-full px-3 py-2 rounded-xl outline-none transition"
      style={{
        background: "var(--input-bg)",
        border: `1px solid ${SOFT_BORDER}`,
        color: "var(--text)",
      }}
    />
  );
}

function InlineMsg({ ok, err, className = "" }) {
  if (ok) return <p className={`text-emerald-400 text-sm ${className}`}>{ok}</p>;
  if (err) return <p className={`text-rose-400 text-sm ${className}`}>{err}</p>;
  return null;
}

function formatRelative(ts) {
  const value = typeof ts === "number" ? ts : Number(ts);
  if (!value || Number.isNaN(value)) return null;
  const diff = Date.now() - value;
  const minutes = Math.max(Math.floor(diff / 60000), 0);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(value);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function IntegrationRow({ provider, manager, name, description, companyName = "", disabled = false, businessId = null }) {
  const readOnly = disabled === true && Boolean(provider);
  const meta = provider ? INTEGRATION_META[provider] : null;
  const label = name || meta?.label || provider;
  const detail = description || meta?.description || "";
  const status = provider && manager ? manager.getStatus(provider) : { status: disabled ? "coming-soon" : "disconnected", lastSync: null };
  const state = status?.status || (disabled ? "coming-soon" : "disconnected");
  const connecting = state === "connecting";
  const awaiting = state === "awaiting";
  const lastSync = status?.lastSync ? formatRelative(status.lastSync) : null;
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const disconnectLabel =
    provider === "quickbooks"
      ? "QuickBooks"
      : provider === "plaid"
      ? "Plaid"
      : meta?.label || label || "integration";
  const qbStatus = provider === "quickbooks" ? status?.info || null : null;
  const qbCompanyFile =
    provider === "quickbooks"
      ? companyName || qbStatus?.company_name || qbStatus?.companyName || ""
      : "";
  const quickBooksWasConnected =
    provider === "quickbooks" &&
    Boolean(
      state === "connected" ||
        qbStatus?.hasConnectedBefore ||
        qbStatus?.has_connected_before ||
        qbStatus?.previouslyConnected ||
        qbStatus?.previously_connected ||
        qbStatus?.disconnectedAt ||
        qbStatus?.disconnected_at ||
        qbStatus?.connectedAt ||
        qbStatus?.connected_at ||
        qbStatus?.realmId ||
        qbStatus?.realm_id
    );
  const quickBooksRealmAlreadyConnected =
    provider === "quickbooks" &&
    (status?.error === "realm_already_connected" || status?.info?.realmAlreadyConnected);
  const [showCompanyMismatch, setShowCompanyMismatch] = useState(false);
  const mismatchDismissedRef = useRef(false);
  const [backfillStatus, setBackfillStatus] = useState(null);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const backfillTimestamp = useMemo(() => {
    if (!backfillStatus) return null;
    const ts = backfillStatus?.finished_at || backfillStatus?.started_at || null;
    if (!ts) return null;
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : null;
  }, [backfillStatus]);
  const backfillAgo = useMemo(
    () => (backfillTimestamp ? formatRelative(backfillTimestamp) : null),
    [backfillTimestamp]
  );
  const backfillAnchorLabel = useMemo(() => {
    const anchorYear = Number(backfillStatus?.anchor?.year || backfillStatus?.anchor_year || new Date().getFullYear());
    const anchorMonth = Number(backfillStatus?.anchor?.month || backfillStatus?.anchor_month || new Date().getMonth() + 1);
    if (!Number.isInteger(anchorYear) || !Number.isInteger(anchorMonth)) return "the selected month";
    return new Date(anchorYear, anchorMonth - 1, 1).toLocaleString(undefined, { month: "short", year: "numeric" });
  }, [backfillStatus]);
  const backfillSummary = useMemo(() => {
    if (!backfillStatus || backfillStatus.status === "idle") return "";
    const total = Number(backfillStatus.months_total || 12);
    const coverage = Number(backfillStatus.snapshot_coverage_count ?? (Number(backfillStatus.months_succeeded || 0) + Number(backfillStatus.months_skipped || 0)));
    const failed = Number(backfillStatus.months_failed || 0);
    if (["queued", "running"].includes(backfillStatus.status)) {
      return `Importing ${coverage} of ${total} months${backfillStatus.current_month ? ` • ${backfillStatus.current_month}` : ""}`;
    }
    if (backfillStatus.status === "completed") {
      return `Imported ${coverage} of ${total} months through ${backfillAnchorLabel}`;
    }
    if (backfillStatus.status === "partial") {
      return `Imported ${coverage} of ${total} months · ${failed} need retry`;
    }
    if (backfillStatus.status === "failed") {
      return "Historical import failed · Retry";
    }
    return "";
  }, [backfillAnchorLabel, backfillStatus]);

  const handleConnect = () => {
    if (readOnly) return;
    if (!provider || !manager) return;
    manager.connect(provider);
  };
  const handleForceReconnect = () => {
    if (readOnly) return;
    if (!provider || !manager) return;
    manager.connect(provider);
    setShowCompanyMismatch(false);
    mismatchDismissedRef.current = true;
  };
  const handleDisconnect = async () => {
    if (readOnly) return;
    if (!provider || !manager) return;
    await manager.disconnect(provider);
    setConfirmDisconnect(false);
  };

  useEffect(() => {
    setConfirmDisconnect(false);
  }, [provider, state]);

  useEffect(() => {
    if (provider !== "quickbooks") return;
    if (mismatchDismissedRef.current) return;
    if (status?.error === "company_mismatch" || status?.info?.companyMismatch) {
      setShowCompanyMismatch(true);
    }
  }, [provider, status?.error, status?.info?.companyMismatch]);

  const ctaLabel = () => {
    if (provider === "quickbooks") {
      if (connecting) return "Connecting…";
      if (state === "connected") return "Disconnect QuickBooks";
      if (state === "awaiting") return "Finish setup";
      if (state === "disconnected") {
        return quickBooksWasConnected ? "Reconnect QuickBooks" : meta?.cta || "Connect QuickBooks";
      }
    }
    if (state === "connected") return "Disconnect";
    if (state === "error") return "Retry";
    if (connecting) return "Connecting…";
    if (awaiting) return "Finish setup";
    return meta?.cta || "Connect";
  };

  const fetchBackfillStatus = useCallback(async () => {
    if (provider !== "quickbooks" || !businessId) return;
    try {
      const res = await safeFetch(apiUrl(`/api/qbo/backfill/status?business_id=${encodeURIComponent(businessId)}`));
      setBackfillStatus(res || null);
    } catch {
      setBackfillStatus(null);
    }
  }, [businessId, provider]);

  useEffect(() => {
    if (provider !== "quickbooks") return undefined;
    fetchBackfillStatus();
    let id = null;
    const status = backfillStatus?.status;
    if (["queued", "running"].includes(status)) {
      id = setInterval(fetchBackfillStatus, 4000);
    }
    return () => {
      if (id) clearInterval(id);
    };
  }, [provider, fetchBackfillStatus, backfillStatus?.status]);

  const startBackfill = useCallback(async (force = false) => {
    if (readOnly) return;
    if (!businessId) return;
    const anchor = new Date();
    const anchorYear = anchor.getFullYear();
    const anchorMonth = anchor.getMonth() + 1;
    if (force) {
      const confirmed = globalThis.confirm?.(
        `Re-import 12 months from QuickBooks ending ${new Date(anchorYear, anchorMonth - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" })}? This re-fetches reports but preserves snapshot history.`
      );
      if (confirmed === false) return;
    }
    setBackfillLoading(true);
    try {
      const res = await safeFetch(apiUrl("/api/qbo/backfill/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          business_id: businessId,
          months: 12,
          anchor_year: anchorYear,
          anchor_month: anchorMonth,
          source: force ? "settings_force_reimport" : "settings_import_missing_history",
          force,
        },
      });
      setBackfillStatus(res || { status: "queued", months_done: 0, months_total: 12 });
    } catch (e) {
      console.warn("[backfill] start failed", e?.message || e);
    } finally {
      setBackfillLoading(false);
    }
  }, [businessId, readOnly]);

  return (
    <div
      data-integration={provider || undefined}
      className={`relative mb-3 flex flex-col gap-4 rounded-xl px-4 py-4 transition sm:flex-row sm:items-start sm:justify-between ${
        confirmDisconnect ? "z-40" : "z-0"
      }`}
      style={{
        background: ROW_BG,
        border: `1px solid ${SOFT_BORDER}`,
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <LinkIcon className="h-4 w-4" style={{ color: "var(--accent)" }} />
          <span className="text-sm font-semibold">{label}</span>
          <StatusPill state={state} />
        </div>
        {detail ? (
          <p className="text-xs" style={{ color: TEXT_MUTED }}>
            {detail}
          </p>
        ) : null}
        {provider === "quickbooks" && (state === "connected" || state === "disconnected") ? (
          <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.55)" }}>
            Status: {state === "connected" ? "Connected" : "Disconnected"}
          </p>
        ) : null}
        {provider === "quickbooks" && state === "connected" && qbCompanyFile ? (
          <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.55)" }}>
            Company file: {qbCompanyFile}
          </p>
        ) : null}
        {provider === "quickbooks" && state === "disconnected" && quickBooksWasConnected ? (
          <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.55)" }}>
            Your historical data is still saved. Reconnect to resume posting.
          </p>
        ) : null}
        {provider === "quickbooks" && state === "disconnected" && !quickBooksWasConnected ? (
          <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.55)" }}>
            Connect QuickBooks to start syncing your books.
          </p>
        ) : null}
        {quickBooksRealmAlreadyConnected ? (
          <p className="max-w-xl text-[11px] text-amber-200/90">
            {qbStatus?.message ||
              status?.info?.message ||
              "That QuickBooks company is already connected to another Bizzi business. Disconnect it there first, or choose a different QuickBooks sandbox company."}
          </p>
        ) : null}
        {provider === "quickbooks" && state === "connected" ? (
          <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.55)" }}>
            Disconnect pauses posting to QuickBooks. Bizzi keeps your historical transactions, categorizations, and audit trail.
          </p>
        ) : null}
        {lastSync && state === "connected" ? (
          <p className="text-[11px] text-white/50">Last synced {lastSync}</p>
        ) : null}
        {provider === "quickbooks" && state === "connected" ? (
          <div className="flex flex-col gap-2 mt-2">
            <div className="flex gap-2 flex-wrap">
              <AccentButton onClick={() => startBackfill(false)} disabled={readOnly || backfillLoading}>
                {backfillLoading ? "Starting..." : "Import missing history"}
              </AccentButton>
              <GhostButton
                onClick={() => startBackfill(true)}
                disabled={readOnly || backfillLoading}
                className="border-rose-500/50 text-rose-200 hover:border-rose-400/80"
              >
                Re-import 12 months
              </GhostButton>
            </div>
            <span className="text-[11px] text-white/50">
              Imports missing monthly reports from QuickBooks for the 12-month period ending {backfillAnchorLabel}.
            </span>
            {backfillSummary ? (
              <span className="text-[11px] text-white/70">
                {backfillSummary}
              </span>
            ) : null}
            {backfillAgo && backfillStatus?.status === "completed" ? (
              <span className="text-[11px] text-white/50">
                Full history imported {backfillAgo}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
        {disabled ? (
          <GhostButton disabled className={INTEGRATION_ACTION_BUTTON_CLASS}>{readOnly ? "Read Only" : "Coming soon"}</GhostButton>
        ) : state === "connected" ? (
          <div className="relative">
            <GhostButton
              onClick={() => setConfirmDisconnect((p) => !p)}
              className={`${INTEGRATION_ACTION_BUTTON_CLASS} transition`}
            >
              {ctaLabel()}
            </GhostButton>
            {confirmDisconnect ? (
              <div
                className="absolute right-0 z-50 mt-2 w-48 rounded-lg border border-white/10 bg-[rgba(12,12,14,0.9)] shadow-lg p-3 text-xs text-white/80"
                style={{ backdropFilter: "blur(6px)" }}
              >
                <div className="mb-2 text-white/90">Disconnect {disconnectLabel}?</div>
                {provider === "quickbooks" ? (
                  <div className="mb-2 text-[11px] text-white/60">
                    Disconnect pauses posting to QuickBooks. Bizzi keeps your historical transactions, categorizations, and audit trail.
                  </div>
                ) : null}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmDisconnect(false)}
                    className="px-2 py-1 rounded bg-white/5 text-white/80 hover:bg-white/10 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    className="px-2 py-1 rounded bg-rose-600/80 text-white hover:bg-rose-600 transition"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <AccentButton onClick={handleConnect} disabled={connecting} className={INTEGRATION_ACTION_BUTTON_CLASS}>
            {ctaLabel()}
          </AccentButton>
        )}
      </div>
      {provider === "quickbooks" && showCompanyMismatch ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[rgba(12,12,14,0.95)] p-4 text-sm text-white/80 shadow-lg">
            <div className="text-base font-semibold text-white">Switch QuickBooks company?</div>
            <p className="mt-2 text-xs text-white/60">
              {qbStatus?.message || status?.info?.message || "You connected a different QuickBooks company. Switching may affect posting destinations. Confirm switch?"}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowCompanyMismatch(false);
                  mismatchDismissedRef.current = true;
                }}
                className="px-3 py-1.5 rounded bg-white/5 text-white/80 hover:bg-white/10 transition text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleForceReconnect}
                className="px-3 py-1.5 rounded bg-emerald-500/80 text-emerald-50 hover:bg-emerald-500 transition text-xs"
              >
                Confirm switch
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatusPill({ state }) {
  const map = {
    connected: { text: "Connected", className: "text-emerald-300" },
    connecting: { text: "Syncing…", className: "text-sky-300" },
    awaiting: { text: "Awaiting approval", className: "text-amber-300" },
    error: { text: "Needs attention", className: "text-rose-300" },
    "coming-soon": { text: "Soon", className: "text-white/60" },
    disconnected: { text: "Disconnected", className: "text-white/60" },
  };
  const meta = map[state] || map.disconnected;
  return (
    <span className={`text-[11px] tracking-wide uppercase ${meta.className}`}>
      {meta.text}
    </span>
  );
}

function AccentButton({ children, className = "", ...props }) {
  return (
    <button
      {...props}
      className={`px-3 py-2 rounded-lg text-sm transition border bg-transparent hover:bg-white/5 hover:border-white/40 disabled:opacity-60 ${className}`}
      style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
    >
      {children}
    </button>
  );
}

function GhostButton({ children, className = "", ...props }) {
  return (
    <button
      {...props}
      className={`px-3 py-2 rounded-lg text-sm transition border bg-transparent hover:bg-white/5 hover:border-white/40 disabled:opacity-60 ${className}`}
      style={{ color: "var(--text)", borderColor: NEUTRAL_BORDER }}
    >
      {children}
    </button>
  );
}
