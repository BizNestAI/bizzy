// src/components/Settings/SettingsHome.jsx
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAuth } from "../../context/AuthContext";
import { useBusiness } from "../../context/BusinessContext";
import { supabase } from "../../services/supabaseClient";
import { apiUrl, safeFetch } from "../../utils/safeFetch";
import { updateBusinessProfile } from "../../services/businessService";
import { getUserProfile, updateUserProfile } from "../../services/profileService";
import {
  User, Building2, PlugZap, CreditCard, Mail, Shield, Link as LinkIcon,
  LogOut, AlertTriangle, ChevronDown, Check
} from "lucide-react";
import BillingCard from "../../pages/Settings/BillingCard.jsx";
import useBillingStatus from "../../hooks/useBillingStatus.js";
import { useNavigate } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import useIntegrationManager, { INTEGRATION_META } from "../../hooks/useIntegrationManager";
import { getDemoMode, setDemoMode, isTestingMode, setTestingMode } from "../../services/demo/demoClient.js";
import { logout as performLogout } from "../../services/authService";
import { markIntegrationsPageViewed } from "../../hooks/useOnboardingStatus";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import BusinessSwitcher from "../../components/UserAdmin/BusinessSwitcher.jsx";
import {
  getPlaidStatus,
  createPlaidLinkToken,
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
const NEUTRAL_BORDER = "rgba(165,167,169,0.18)";
const TEXT_MUTED = "var(--text-2)";
const PANEL_BG = "var(--panel)";
const PLAID_LINK_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

/** Tabs visible for MVP */
const tabs = [
  { key: "Profile",      icon: User },
  { key: "Business",     icon: Building2 },
  { key: "Integrations", icon: PlugZap },
  { key: "Billing",      icon: CreditCard },
];

const CREDITS_CAP = 300;

export default function SettingsHome() {
  const SHOW_MARKETING_COMMS = false;
  const { user } = useAuth();
  const { currentBusiness, setCurrentBusiness } = useBusiness();
  const { usageCount = 0 } = useBizzyChatContext() || {};
  const navigate = useNavigate();
  const userId = user?.id || localStorage.getItem("user_id");
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId");
  const [searchParams, setSearchParams] = useSearchParams();
  const [billingRefresh, setBillingRefresh] = useState(0);
  const [billingToast, setBillingToast] = useState("");

  const activeTab = useMemo(() => {
    const tabParam = (searchParams.get("tab") || "").toLowerCase();
    const focus = (searchParams.get("integration") || "").toLowerCase();
    if (focus) return "Integrations";
    if (tabParam) {
      const match = tabs.find((t) => t.key.toLowerCase() === tabParam);
      if (match) return match.key;
    }
    try {
      const storedTab = (window.localStorage?.getItem("bizzy:settingsActiveTab") || "").toLowerCase();
      const match = storedTab && tabs.find((t) => t.key.toLowerCase() === storedTab);
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
  const [testingMode, setTestingModeState] = useState(() => isTestingMode());
  const [modeUpdating, setModeUpdating] = useState(false);
  const [qbCompanyName, setQbCompanyName] = useState("");
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  // Profile
  const [name, setName] = useState("");
  const [email, setEmail] = useState(user?.email || "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState("");
  const [profileError, setProfileError] = useState("");

  // Business
  const [businessForm, setBusinessForm] = useState({
    business_name: "",
    industry: "",
    team_size: "",
    state: "",
    timezone: "",
  });
  const [savingBusiness, setSavingBusiness] = useState(false);
  const [bizSuccessMsg, setBizSuccessMsg] = useState("");
  const [bizErrorMsg, setBizErrorMsg] = useState("");
  const hasMarkedIntegrationsRef = useRef(false);
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
    if (currentBusiness) {
      setBusinessForm({
        business_name: currentBusiness.business_name || "",
        industry: currentBusiness.industry || "",
        team_size: currentBusiness.team_size || "",
        state: currentBusiness.state || "",
        timezone: currentBusiness.timezone || "",
      });
    }
  }, [currentBusiness]);

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
    if (!currentBusiness?.id) return;
    setSavingBusiness(true);
    setBizSuccessMsg("");
    setBizErrorMsg("");
    const payload = {
      ...businessForm,
      team_size: businessForm.team_size ? parseInt(businessForm.team_size, 10) : null,
    };
    const { error } = await updateBusinessProfile(currentBusiness.id, payload);
    if (error) setBizErrorMsg("Failed to update business settings. Please try again.");
    else setBizSuccessMsg("Business settings updated successfully.");
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
    } catch (err) {
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

  useEffect(() => {
    if (activeTab !== "Integrations") return;
    if (!businessId || hasMarkedIntegrationsRef.current) return;
    hasMarkedIntegrationsRef.current = true;
    markIntegrationsPageViewed({ businessId }).finally(() => {
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem("bizzy:has_viewed_integrations_page", "true");
          window.localStorage.setItem("bizzy:visitedIntegrations", "true");
        }
      } catch {
        /* ignore */
      }
      try {
        window.dispatchEvent(new Event("bizzy:onboarding-flags-updated"));
      } catch {
        /* ignore */
      }
    });
  }, [activeTab, businessId]);

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
  if (!businessId) return;
  if (plaidRefreshOnceRef.current) return;
  plaidRefreshOnceRef.current = true;
  integrationManager.refresh?.("plaid").catch(() => {});
}, [activeTab, businessId, integrationManager]);

  /* ---------------- Render ---------------- */
  return (
    <div className="w-full px-3 md:px-4 pb-12 pt-0 bg-app text-primary" style={{ "--accent": "var(--accent)" }}>
      {/* Header (aligned with page content) */}
      <div className="max-w-6xl mx-auto px-3 md:px-4 lg:px-6 mb-5">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-[0.18em] text-[color:var(--text)] text-left">
          Settings
        </h1>
        <p className="mt-1 text-sm text-left" style={{ color: "rgba(var(--accent-rgb),0.78)" }}>
          Profile, business identity, integrations, and billing — all in one place.
        </p>
      </div>

      <div className="max-w-6xl mx-auto px-3 md:px-4 lg:px-6">
      <section
        className="mb-5 rounded-3xl px-4 py-5 border border-[rgba(var(--accent-rgb),0.14)]"
        style={{ background: PANEL_BG, boxShadow: "0 0 0 1px rgba(var(--accent-rgb),0.05), 0 22px 60px rgba(0,0,0,0.35)" }}
      >
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-sm font-semibold text-white/85">Data Source Mode</p>
            <p className="text-xs text-white/60">
              Toggle between Bizzi’s mock data (Mike’s Remodeling) and live integrations. Live Mode shows zeroes until your accounts sync.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-4">
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
            <div className="text-xs text-white/55">
              <div>{dataMode !== "live" ? "Bizzi demo data is active." : "Live mode enabled."}</div>
              <div>{dataMode !== "live" ? "Great for demos and testing." : "Connect QuickBooks, Gmail, Plaid, and more to populate your dashboards."}</div>
            </div>
            </div>
          </div>
        </div>
      </section>

      {/* Tab pills */}
      <div className="p-2.5 mb-5">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Settings tabs">
          <div className="flex flex-wrap gap-1.5 sm:gap-2">
            {tabs.map(({ key, icon: Icon }) => {
              const active = activeTab === key;
              return (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  aria-selected={active}
                  className="group inline-flex items-center gap-2 px-3.5 py-2 rounded-full text-sm focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 active:outline-none active:ring-0"
                  style={
                    active
                      ? {
                          outline: "none",
                          transition: "none",
                          color: "var(--accent)",
                          border: `1px solid rgba(var(--accent-rgb),0.4)`,
                          boxShadow: "0 0 0 1px rgba(var(--accent-rgb),0.12), 0 10px 24px rgba(0,0,0,0.35)",
                          background: "rgba(255,255,255,0.06)",
                        }
                      : {
                          outline: "none",
                          transition: "none",
                          color: "var(--text)",
                          border: `1px solid ${NEUTRAL_BORDER}`,
                          background: "rgba(255,255,255,0.02)",
                        }
                  }
                >
                  <Icon className="h-4 w-4 opacity-90 group-hover:opacity-100" />
                  {key}
                </button>
              );
            })}
            <button
              onClick={() => navigate('/setup')}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full text-sm border transition"
              style={{
                borderColor: "rgba(255,255,255,0.2)",
                color: "var(--text)",
                background: "rgba(255,255,255,0.06)",
              }}
            >
              Review Business Setup
            </button>
          </div>
        </div>
      </div>

      {/* Content wrapper */}
      <div
        className="rounded-3xl shadow-bizzi border p-4 sm:p-6"
        style={{ background: PANEL_BG, borderColor: NEUTRAL_BORDER }}
      >
        <div className="grid grid-cols-12 gap-6">
          {/* -------- Profile -------- */}
          {activeTab === "Profile" && (
            <>
              <Section
                className="col-start-1 col-span-12 md:col-span-6"
                title="Your Profile"
                subtitle="Keep your personal info up to date."
                icon={User}
              >
                <Field label="Full Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" /></Field>
                <Field label="Email"><Input value={email} disabled /></Field>
                <div className="flex flex-wrap gap-3 pt-2">
                  <AccentButton onClick={handleSaveProfile} disabled={savingProfile} className="focus-visible:outline-none">
                    {savingProfile ? "Saving…" : "Save Changes"}
                  </AccentButton>
                  <GhostButton onClick={handleResetPassword} className="focus-visible:outline-none">Send Reset Email</GhostButton>
                </div>
                <InlineMsg ok={profileSuccess} err={profileError} />
              </Section>

              <Section
                className="col-start-1 col-span-12"
                title="Sign out"
                subtitle="Log out of Bizzi on this device."
                icon={LogOut}
              >
                {!showLogoutConfirm ? (
                  <button
                    type="button"
                    onClick={beginLogout}
                    className="group inline-flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition hover:border-white/20 hover:bg-white/5"
                    style={{ borderColor: "rgba(255,255,255,0.12)", background: "rgba(12,16,22,0.85)" }}
                  >
                    <div className="grid h-9 w-9 place-items-center rounded-md bg-white/6 text-white/85">
                      <LogOut className="h-4 w-4" />
                    </div>
                    <div className="pr-1">
                      <p className="text-sm font-semibold text-white">Log out of Bizzi</p>
                      <p className="text-xs" style={{ color: TEXT_MUTED }}>
                        Ends your current session.
                      </p>
                    </div>
                  </button>
                ) : (
                <div
                  className="rounded-2xl p-4 sm:p-5"
                  style={{
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(20,21,22,0.9)",
                    boxShadow: "none",
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div>
                      <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                        Ready to sign out?
                      </p>
                      <p className="text-xs mt-1" style={{ color: TEXT_MUTED }}>
                          You’ll need to re-enter your credentials to get back into Bizzi.
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={confirmLogout}
                        disabled={loggingOut}
                        className="mt-4 px-4 py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-60"
                        style={{
                          background: "linear-gradient(120deg, rgba(80,82,86,0.95), rgba(45,47,52,0.9))",
                          color: "white",
                          boxShadow: "none",
                        }}
                      >
                        {loggingOut ? "Signing out…" : "Confirm sign out"}
                      </button>
                      <GhostButton onClick={cancelLogout} disabled={loggingOut} className="mt-4">
                        Stay signed in
                      </GhostButton>
                    </div>
                    <InlineMsg err={logoutError} className="mt-3" />
                  </div>
                )}
              </Section>
            </>
          )}

          {/* -------- Business -------- */}
          {activeTab === "Business" && (
            <>
              <Section
                className="col-start-1 col-span-12 md:col-span-6"
                title="Active Business"
                subtitle="Switch which business you are viewing in Bizzi."
                icon={Building2}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <p className="text-sm text-white/80">
                      {currentBusiness?.business_name || "No business selected"}
                    </p>
                    <p className="text-xs" style={{ color: TEXT_MUTED }}>
                      Select a business to update dashboards and integrations.
                    </p>
                  </div>
                  <BusinessSwitcher
                    currentBusiness={currentBusiness}
                    setCurrentBusiness={setCurrentBusiness}
                  />
                </div>
              </Section>

              <Section
                className="col-start-1 col-span-12 md:col-span-6"
                title="Business Profile"
                subtitle="This info helps Bizzi personalize insights and reports."
                icon={Building2}
              >
                <Field label="Business Name"><Input name="business_name" value={businessForm.business_name} onChange={handleBusinessChange} /></Field>
                <Field label="Industry"><Input name="industry" value={businessForm.industry} onChange={handleBusinessChange} /></Field>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label="Team Size"><Input name="team_size" type="number" value={businessForm.team_size} onChange={handleBusinessChange} /></Field>
                  <Field label="State"><Input name="state" value={businessForm.state} onChange={handleBusinessChange} /></Field>
                  <Field label="Timezone"><Input name="timezone" value={businessForm.timezone} onChange={handleBusinessChange} /></Field>
                </div>
                <div className="pt-2">
                  <AccentButton onClick={handleSaveBusiness} disabled={savingBusiness} className="focus-visible:outline-none">
                    {savingBusiness ? "Saving…" : "Save Changes"}
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
              <IntegrationRow provider="quickbooks" manager={integrationManager} companyName={qbCompanyName} businessId={businessId} />
                <PlaidIntegrationCard businessId={businessId} />
              </Section>

              {SHOW_MARKETING_COMMS ? (
                <Section
                  className="col-start-1 col-span-12"
                  title="Marketing & Comms"
                  subtitle="Bring in communications and social data."
                  icon={Mail}
                >
                  <IntegrationRow provider="gmail" manager={integrationManager} />
                  <IntegrationRow name="Slack" description="Team notifications and workflows." disabled />
                  <IntegrationRow provider="facebook" manager={integrationManager} />
                  <IntegrationRow provider="instagram" manager={integrationManager} />
                  <IntegrationRow provider="linkedin" manager={integrationManager} />
                </Section>
              ) : null}

              <Section
                className="col-start-1 col-span-12"
                title="Operations"
                subtitle="Jobber and field ops data."
                icon={PlugZap}
              >
                <IntegrationRow provider="jobber" manager={integrationManager} disabled />
              </Section>
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
            <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/60">
              Select a business to manage billing.
            </div>
          ) : (
            <BillingCard
              userId={userId}
              businessId={businessId}
              status={billingStatus}
              onBillingRefresh={() => setBillingRefresh((v) => v + 1)}
            />
          )}
          {activeTab === "Billing" && loadingBilling ? (
            <p className="text-xs mt-2" style={{ color: TEXT_MUTED }}>Loading billing status…</p>
          ) : null}

              <div className="mt-4 rounded-xl border px-4 py-3"
                style={{ borderColor: NEUTRAL_BORDER, background: "rgba(255,255,255,0.04)" }}>
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
                <div className="mt-3 h-2 w-full rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-emerald-400/70 transition-all"
                    style={{ width: `${Math.min((usageCount || 0) / CREDITS_CAP * 100, 100)}%` }}
                  />
                </div>
              </div>
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
        "relative inline-flex items-center rounded-full border border-white/15 bg-black/30 p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--accent-rgb),0.4)]",
        disabled ? "opacity-50 cursor-not-allowed" : "hover:border-[rgba(var(--accent-rgb),0.4)]",
      ].join(" ")}
      style={{ width: 210, height: 52 }}
    >
      <span
        className={[
          "absolute inset-1 rounded-full bg-[rgba(var(--accent-rgb),0.14)] transition-all duration-300",
          active ? "translate-x-0 opacity-100" : "translate-x-[calc(100%-2px)] opacity-0",
        ].join(" ")}
        aria-hidden
      />
      <span
        className={[
          "absolute inset-1 rounded-full bg-white/8 transition-all duration-300",
          active ? "translate-x-[calc(0%)] opacity-0" : "translate-x-0 opacity-100",
        ].join(" ")}
        aria-hidden
      />
      <div className="relative z-10 flex w-full items-center justify-between px-4 text-[13px] font-semibold">
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
    ok: "bg-emerald-500/15 text-emerald-200 border-emerald-500/30",
    warning: "bg-amber-500/15 text-amber-200 border-amber-500/30",
    slate: "bg-white/10 text-white/70 border-white/15",
  };
  const cls = toneMap[tone] || toneMap.slate;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {label}
    </span>
  );
}

function PlaidIntegrationCard({ businessId }) {
  const mappingOverrideStorageKey = useMemo(
    () => (businessId ? `bizzy:plaid-mapping-overrides:${businessId}` : null),
    [businessId]
  );
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false);
  const [disconnectingItem, setDisconnectingItem] = useState(null);
  const [disconnectingAll, setDisconnectingAll] = useState(false);
  const [confirmDisconnectAll, setConfirmDisconnectAll] = useState(false);
  const [confirmDisconnectByAccount, setConfirmDisconnectByAccount] = useState({});
  const [institutions, setInstitutions] = useState([]);
  const [counts, setCounts] = useState({ institutions: 0, accounts: 0 });
  const [statusError, setStatusError] = useState("");
  const [hasDisconnected, setHasDisconnected] = useState(false);
  const [mappingRows, setMappingRows] = useState([]);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [mappingError, setMappingError] = useState("");
  const [qboPaymentAccounts, setQboPaymentAccounts] = useState([]);
  const [mappingSaving, setMappingSaving] = useState({});
  const [mappingOverrides, setMappingOverrides] = useState({});

  const fetchStatus = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      const res = await getPlaidStatus(businessId);
      if (res?.ok === false) {
        console.warn("[plaid][status] backend error", res?.error || res?.message);
        setStatusError("Plaid status unavailable. Try syncing again.");
        setInstitutions(res?.institutions || []);
        setCounts({ institutions: 0, accounts: 0 });
        setHasDisconnected(false);
      } else {
        setStatusError("");
        const acctCount = res?.accounts_count || 0;
        const instCount = acctCount > 0 ? res?.institutions_count || 0 : 0;
        setInstitutions(acctCount > 0 ? res?.institutions || [] : []);
        setCounts({
          institutions: instCount,
          accounts: acctCount,
        });
        setHasDisconnected(Boolean(res?.has_disconnected));
      }
    } catch (err) {
      console.warn("[plaid][status] failed", err);
      setStatusError("Plaid status unavailable. Try syncing again.");
      setHasDisconnected(false);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const refreshMappings = useCallback(async () => {
    if (!businessId) return;
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
  }, [businessId]);

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
              await exchangePlaidPublicToken(businessId, public_token, metadata);
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
  }, [businessId, fetchStatus, refreshMappings]);

  const handleDisconnectAll = useCallback(async () => {
    if (!businessId) return;
    setDisconnectingAll(true);
    try {
      await disconnectPlaid(businessId);
      try {
        window.localStorage.setItem("bizzy:plaid_connected", "false");
        window.dispatchEvent(new Event("bizzy:onboarding-flags-updated"));
      } catch {
        /* ignore */
      }
      setConfirmDisconnectAll(false);
      await fetchStatus();
      await refreshMappings();
    } catch (err) {
      console.warn("[plaid][disconnect] failed", err);
    } finally {
      setDisconnectingAll(false);
    }
  }, [businessId, fetchStatus, refreshMappings]);

  const toggleDisconnectConfirm = useCallback((acctId) => {
    setConfirmDisconnectByAccount((prev) => ({
      ...prev,
      [acctId]: !prev[acctId],
    }));
  }, []);

  const handleDisconnectItem = useCallback(async (plaidItemId) => {
    if (!businessId || !plaidItemId) return;
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
      await fetchStatus();
      await refreshMappings();
    } catch (err) {
      console.warn("[plaid][disconnect-item] failed", err);
    } finally {
      setDisconnectingItem(null);
    }
  }, [businessId, fetchStatus, refreshMappings]);

  const latestSyncAt = useMemo(() => {
    const timestamps = institutions
      .map((inst) => (inst.last_sync_at ? Date.parse(inst.last_sync_at) : null))
      .filter(Boolean);
    if (!timestamps.length) return null;
    return new Date(Math.max(...timestamps));
  }, [institutions]);

  const isConnected = counts.accounts > 0;
  const isDisconnected = !isConnected && hasDisconnected;
  const isEmpty = !isConnected && !hasDisconnected;
  const mappingById = useMemo(() => {
    const map = new Map();
    (mappingRows || []).forEach((row) => {
      if (row?.plaid_account_id) map.set(row.plaid_account_id, row);
    });
    return map;
  }, [mappingRows]);
  const hasMappingNeeds = useMemo(
    () => isConnected && (mappingRows || []).some((row) => row?.requires_mapping && !row?.mapped),
    [isConnected, mappingRows]
  );

  const handleMappingChange = useCallback(async (plaidAccountId, value) => {
    if (!businessId || !plaidAccountId) return;
    setMappingSaving((prev) => ({ ...prev, [plaidAccountId]: true }));
    try {
      if (value === "__create__") {
        const ensured = await ensureQboPaymentAccount(businessId, plaidAccountId);
        const qboId = ensured?.account?.id || null;
        if (qboId) {
          await updateAccountMapping(businessId, {
            plaid_account_id: plaidAccountId,
            qbo_account_id: qboId,
          });
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
                    qbo_account_name: ensured?.account?.name || row.qbo_account_name || null,
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
  }, [businessId, refreshMappings]);

  return (
    <div
      className="mt-2 rounded-xl border border-white/10 bg-white/5 p-3"
      style={{ backdropFilter: "blur(4px)" }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Plaid (Bank Sync)</span>
          </div>
          <p className="text-xs text-white/60">
            {isDisconnected
              ? "Status: Disconnected"
              : `Connected: ${counts.institutions} institution${counts.institutions === 1 ? "" : "s"} · ${counts.accounts} account${counts.accounts === 1 ? "" : "s"}`}
          </p>
          {latestSyncAt ? (
            <p className="text-[11px] text-white/50">Last sync {formatRelative(latestSyncAt.getTime())}</p>
          ) : null}
        </div>
        {isConnected ? (
          <div className="flex items-center gap-2">
            <GhostButton onClick={openPlaid} disabled={linking} className="text-xs">
              {linking ? "Opening…" : "Add another bank"}
            </GhostButton>
            {confirmDisconnectAll ? (
              <>
                <GhostButton
                  onClick={handleDisconnectAll}
                  disabled={disconnectingAll}
                  className="text-xs text-rose-200 border-rose-400/40 hover:border-rose-300/60"
                >
                  {disconnectingAll ? "Disconnecting…" : "Confirm disconnect"}
                </GhostButton>
                <GhostButton
                  onClick={() => setConfirmDisconnectAll(false)}
                  className="text-xs"
                >
                  Cancel
                </GhostButton>
              </>
            ) : (
              <GhostButton
                onClick={() => setConfirmDisconnectAll(true)}
                className="text-xs text-rose-200 border-rose-400/40 hover:border-rose-300/60"
              >
                Disconnect Plaid
              </GhostButton>
            )}
          </div>
        ) : isDisconnected ? (
          <div className="flex items-center gap-2">
            <AccentButton onClick={openPlaid} disabled={linking} className="text-xs">
              {linking ? "Opening…" : "Reconnect Plaid"}
            </AccentButton>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <AccentButton onClick={openPlaid} disabled={linking} className="text-xs">
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
          Bizzi can’t post until these are mapped. Please select the appropriate account or create a new one for each unmapped account.
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
          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-xs text-white/70">
            No banks connected yet. Add a bank to start syncing transactions.
          </div>
        ) : (
          institutions.map((inst) => (
            <div
              key={inst.plaid_item_id}
              className="rounded-lg border border-white/10 bg-black/30 px-3 py-3"
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
              <div className="mt-2 space-y-1">
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
                  const qboOptions = typeNeeded
                    ? qboPaymentAccounts.filter((opt) => opt?.type === typeNeeded)
                    : qboPaymentAccounts;
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
                      className="flex items-center justify-between rounded-md border border-white/5 bg-white/5 px-2 py-2"
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
                            disabled={mappingLoading || saving}
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
                              { value: "__create__", label: "Create matching account in QuickBooks..." },
                            ]}
                          />
                        ) : null}
                        {suggested && !mappedFlag && !dismissedFlag ? (
                          <div className="max-w-[18rem] text-right text-[10px] text-amber-100/85">
                            Suggested match{suggestionLabel ? `: ${suggestionLabel}` : ""}. Review before confirming.
                          </div>
                        ) : null}
                        {acct.plaid_item_id && acct.plaid_item_id !== "unknown" ? (
                          confirmDisconnectByAccount[acct.plaid_account_id] ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleDisconnectItem(acct.plaid_item_id)}
                                disabled={disconnectingItem === acct.plaid_item_id}
                                className="px-2 py-1 text-[11px] rounded-md border border-rose-400/40 text-rose-200 hover:border-rose-300/70 hover:text-rose-100 transition disabled:opacity-50"
                              >
                                {disconnectingItem === acct.plaid_item_id ? "Disconnecting…" : "Confirm"}
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleDisconnectConfirm(acct.plaid_account_id)}
                                className="px-2 py-1 text-[11px] rounded-md border border-white/15 text-white/60 hover:text-white/80 transition"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => toggleDisconnectConfirm(acct.plaid_account_id)}
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
    </div>
  );
}

/* ---------------- UI helpers ---------------- */

function Badge({ children }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
      style={{ background: "rgba(255,255,255,0.06)", border: `1px solid rgba(var(--accent-rgb),0.22)`, color: TEXT_MUTED, boxShadow: "0 0 0 1px rgba(var(--accent-rgb),0.06)" }}
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
    <div className="relative w-[22rem] max-w-full" ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex w-full items-center justify-between gap-2 rounded-md border border-white/10 bg-[rgba(18,18,20,0.92)] px-3 py-2 text-[11px] text-white/90 shadow-[0_8px_18px_rgba(0,0,0,0.32)] backdrop-blur-md transition-all duration-150 ease-out hover:bg-[rgba(28,28,32,0.98)] hover:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/14 disabled:opacity-60"
      >
        <span className={`truncate text-left ${selected ? "text-white/90" : "text-white/55"}`}>
          {selected?.label || placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-white/65 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      <div
        className={`absolute right-0 z-40 mt-2 w-full overflow-hidden rounded-xl border border-[rgba(var(--accent-rgb),0.22)] bg-[rgba(10,12,16,0.98)] shadow-[0_20px_50px_rgba(0,0,0,0.58)] backdrop-blur-xl transition-all duration-150 ${
          open ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0"
        }`}
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
      className={`m-0 w-full rounded-2xl shadow-bizzi border p-4 sm:p-5 ${className}`}
      style={{ background: PANEL_BG, border: `1px solid rgba(var(--accent-rgb),0.16)`, boxShadow: "0 0 0 1px rgba(var(--accent-rgb),0.05), 0 18px 50px rgba(0,0,0,0.3)" }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="h-4 w-4" style={{ color: "var(--accent)" }} />}
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>
      </div>
      {subtitle && <p className="text-xs mb-4" style={{ color: TEXT_MUTED }}>{subtitle}</p>}
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="mb-3">
      <label className="block text-[11px] uppercase tracking-wide mb-1" style={{ color: TEXT_MUTED }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Input(props) {
  return (
    <input
      {...props}
      className="w-full px-3 py-2 rounded-xl outline-none transition"
      style={{
        background: "rgba(20,21,22,0.85)",
        border: `1px solid ${NEUTRAL_BORDER}`,
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

  const handleConnect = () => {
    if (!provider || !manager) return;
    manager.connect(provider);
  };
  const handleForceReconnect = () => {
    if (!provider || !manager) return;
    manager.connect(provider, { forceSwitchCompany: true });
    setShowCompanyMismatch(false);
    mismatchDismissedRef.current = true;
  };
  const handleDisconnect = async () => {
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
      if (state === "disconnected") return "Reconnect QuickBooks";
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
    if (status === "running") {
      id = setInterval(fetchBackfillStatus, 4000);
    }
    return () => {
      if (id) clearInterval(id);
    };
  }, [provider, fetchBackfillStatus, backfillStatus?.status]);

  const startBackfill = useCallback(async (force = false) => {
    if (!businessId) return;
    setBackfillLoading(true);
    try {
      await safeFetch(apiUrl("/api/qbo/backfill/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { business_id: businessId, months: 12, mode: "cash", force },
      });
      setBackfillStatus({ status: "running", months_done: 0, months_total: 12 });
    } catch (e) {
      console.warn("[backfill] start failed", e?.message || e);
    } finally {
      setBackfillLoading(false);
    }
  }, [businessId]);

  return (
    <div
      data-integration={provider || undefined}
      className="relative flex items-center justify-between rounded-xl px-3 py-3 mb-2 transition"
      style={{
        background: "rgba(255,255,255,0.06)",
        border: `1px solid ${NEUTRAL_BORDER}`,
      }}
    >
      <div className="flex flex-col gap-0.5 max-w-[65%]">
        <div className="flex items-center gap-2">
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
        {provider === "quickbooks" && state === "disconnected" ? (
          <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.55)" }}>
            Your historical data is still saved. Reconnect to resume posting.
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
              <AccentButton onClick={() => startBackfill(false)} disabled={backfillLoading}>
                {backfillLoading ? "Starting..." : "Backfill last 12 months"}
              </AccentButton>
              <GhostButton
                onClick={() => startBackfill(true)}
                disabled={backfillLoading}
                className="border-rose-500/50 text-rose-200 hover:border-rose-400/80"
              >
                Force re-sync
              </GhostButton>
            </div>
            {backfillStatus?.status === "running" ? (
              <span className="text-[11px] text-white/70">
                Backfill running… ({backfillStatus?.months_done || 0}/{backfillStatus?.months_total || 12}
                {backfillStatus?.current_month ? ` • ${backfillStatus.current_month}` : ""})
              </span>
            ) : null}
            {backfillAgo ? (
              <span className="text-[11px] text-white/50">
                {backfillStatus?.status === "running" ? "Backfill started" : "Backfilled"} {backfillAgo}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex gap-2">
        {disabled ? (
          <GhostButton disabled>Coming soon</GhostButton>
        ) : state === "connected" ? (
          <div className="relative">
            <GhostButton
              onClick={() => setConfirmDisconnect((p) => !p)}
              className="transition"
            >
              {ctaLabel()}
            </GhostButton>
            {confirmDisconnect ? (
              <div
                className="absolute right-0 mt-2 w-48 rounded-lg border border-white/10 bg-[rgba(12,12,14,0.9)] shadow-lg p-3 text-xs text-white/80"
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
          <AccentButton onClick={handleConnect} disabled={connecting}>
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
