// src/components/Settings/SettingsHome.jsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "../../context/AuthContext";
import { useBusiness } from "../../context/BusinessContext";
import { supabase } from "../../services/supabaseClient";
import { apiUrl, safeFetch } from "../../utils/safeFetch";
import { updateBusinessProfile } from "../../services/businessService";
import { getUserProfile, updateUserProfile } from "../../services/profileService";
import {
  User, Building2, PlugZap, CreditCard, Mail, Shield, Link as LinkIcon,
  LogOut, AlertTriangle
} from "lucide-react";
import BillingCard from "../../pages/Settings/BillingCard.jsx";
import { useNavigate } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import useIntegrationManager, { INTEGRATION_META } from "../../hooks/useIntegrationManager";
import { getDemoMode, setDemoMode, isTestingMode, setTestingMode } from "../../services/demo/demoClient.js";
import { logout as performLogout } from "../../services/authService";
import { markIntegrationsPageViewed } from "../../hooks/useOnboardingStatus";

/** Graphite neutrals (tokens) */
const NEUTRAL_BORDER = "rgba(165,167,169,0.18)";
const TEXT_MUTED = "var(--text-2)";
const PANEL_BG = "var(--panel)";

/** Tabs visible for MVP */
const tabs = [
  { key: "Profile",      icon: User },
  { key: "Business",     icon: Building2 },
  { key: "Integrations", icon: PlugZap },
  { key: "Billing",      icon: CreditCard },
];

export default function SettingsHome() {
  const { user } = useAuth();
  const { currentBusiness } = useBusiness();
  const navigate = useNavigate();
  const userId = user?.id || localStorage.getItem("user_id");
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId");
  const [searchParams] = useSearchParams();

  const [billingStatus, setBillingStatus] = useState(null);
  const [loadingBilling, setLoadingBilling] = useState(false);

  const [activeTab, setActiveTab] = useState("Profile");
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
    let cancelled = false;
    async function loadStatus() {
      if (!businessId) return;
      setLoadingBilling(true);
      try {
        const url = new URL(apiUrl("/api/billing/status"));
        url.searchParams.set("business_id", businessId);
        const data = await safeFetch(url.toString(), {
          headers: { "x-business-id": businessId, "x-user-id": userId || "" },
        });
        if (!cancelled) setBillingStatus(data || null);
      } catch {
        if (!cancelled) setBillingStatus(null);
      } finally {
        if (!cancelled) setLoadingBilling(false);
      }
    }
    loadStatus();
    return () => { cancelled = true; };
  }, [businessId, userId]);

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
    const tabParam = (searchParams.get("tab") || "").toLowerCase();
    if (tabParam) {
      const match = tabs.find((t) => t.key.toLowerCase() === tabParam);
      if (match) setActiveTab(match.key);
    }
    const focus = (searchParams.get("integration") || "").toLowerCase();
    if (focus) {
      setActiveTab("Integrations");
      setPendingIntegrationFocus(focus);
    }
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
    markIntegrationsPageViewed({ businessId });
  }, [activeTab, businessId]);

  // Fetch QuickBooks company name for display
  useEffect(() => {
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
  }, [businessId]);

  /* ---------------- Render ---------------- */
  return (
    <div className="w-full px-3 md:px-4 pb-12 pt-0 bg-app text-primary" style={{ "--accent": "var(--accent)" }}>
      {/* Header */}
      <div
        className="relative overflow-hidden rounded-3xl shadow-bizzi border p-5 md:p-7 mb-5"
        style={{
          background: "linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, transparent), rgba(20,21,22,0.92))",
          borderColor: NEUTRAL_BORDER
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-8 rounded-[32px] opacity-30 blur-3xl"
          style={{ background: "radial-gradient(60% 60% at 15% 15%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 60%)" }}
        />
        <div className="relative flex items-center justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-[0.18em] text-[color:var(--text)]">
              Control Center
            </h1>
            <p className="mt-1 text-sm" style={{ color: TEXT_MUTED }}>
              Profile, business identity, integrations, and billing — all in one place.
            </p>
          </div>
        </div>
      </div>

      <section
        className="mb-5 rounded-3xl border px-4 py-5"
        style={{ borderColor: NEUTRAL_BORDER, background: PANEL_BG }}
      >
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-sm font-semibold text-white/85">Data Source Mode</p>
            <p className="text-xs text-white/60">
              Toggle between Bizzi’s mock data (Mike’s Remodeling) and live integrations. Live Mode shows zeroes until your accounts sync.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Badge>Testing (QB Sandbox)</Badge>
              <ModeToggle
                active={testingMode}
                labelOn="Testing On"
                labelOff="Testing Off"
                disabled={modeUpdating}
                onChange={(value) => {
                  if (modeUpdating) return;
                  setModeUpdating(true);
                  setTestingModeState(value);
                  setTestingMode(value);
                  // Testing always forces live data (no demo)
                  if (value) {
                    setDemoMode("live");
                    setDataMode("live");
                  }
                  setTimeout(() => window.location.reload(), 150);
                }}
              />
              <p className="text-xs text-white/55">
                Use QuickBooks sandbox (QB_CLIENT_ID/SECRET) for dev testing without touching production data.
              </p>
            </div>
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
      <div
        className="rounded-2xl shadow-bizzi border p-2.5 mb-5 backdrop-blur"
        style={{ background: "rgba(20,21,22,0.85)", borderColor: NEUTRAL_BORDER }}
      >
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Settings tabs">
          <div className="flex flex-wrap gap-1.5 sm:gap-2">
            {tabs.map(({ key, icon: Icon }) => {
              const active = activeTab === key;
              return (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  aria-selected={active}
                  className="group inline-flex items-center gap-2 px-3.5 py-2 rounded-full text-sm border transition"
                  style={
                    active
                      ? {
                          color: "var(--accent)",
                          border: `1px solid var(--accent)`,
                          boxShadow: "0 0 14px 0 var(--accent)",
                          background: "rgba(255,255,255,0.06)",
                        }
                      : {
                          color: "var(--text)",
                          border: `1px solid ${NEUTRAL_BORDER}`,
                          background: "transparent",
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
                  <AccentButton onClick={handleSaveProfile} disabled={savingProfile}>
                    {savingProfile ? "Saving…" : "Save Changes"}
                  </AccentButton>
                  <GhostButton onClick={handleResetPassword}>Send Reset Email</GhostButton>
                </div>
                <InlineMsg ok={profileSuccess} err={profileError} />
              </Section>

              <Section
                className="col-start-1 md:col-start-7 col-span-12 md:col-span-6"
                title="Security"
                subtitle="2FA and device history are coming soon."
                icon={Shield}
              >
                <p className="text-sm" style={{ color: TEXT_MUTED }}>
                  Protect your account with additional verification. We’ll notify you when security upgrades are available.
                </p>
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
                      border: "1px solid rgba(248,113,113,0.4)",
                      background: "linear-gradient(135deg, rgba(24,12,15,0.95), rgba(54,16,29,0.9))",
                      boxShadow: "0 25px 50px rgba(0,0,0,0.55)",
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className="h-12 w-12 rounded-2xl border grid place-items-center"
                        style={{
                          borderColor: "rgba(248,113,113,0.5)",
                          background: "rgba(248,113,113,0.08)",
                          color: "rgb(248,113,113)",
                        }}
                      >
                        <AlertTriangle className="h-5 w-5" />
                      </div>
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
                          background: "linear-gradient(120deg, rgba(248,113,113,0.9), rgba(127,29,29,0.85))",
                          color: "white",
                          boxShadow: "0 15px 40px rgba(248,113,113,0.25)",
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
                  <AccentButton onClick={handleSaveBusiness} disabled={savingBusiness}>
                    {savingBusiness ? "Saving…" : "Save Changes"}
                  </AccentButton>
                  <InlineMsg ok={bizSuccessMsg} err={bizErrorMsg} className="mt-3" />
                </div>
              </Section>

              <Section
                className="col-start-1 md:col-start-7 col-span-12 md:col-span-6"
                title="Brand Basics"
                subtitle="Logo and accent color controls are on the roadmap."
                icon={Building2}
              >
                <p className="text-sm" style={{ color: TEXT_MUTED }}>
                  Soon you’ll be able to upload a logo and match Bizzi to your brand colors.
                </p>
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
                <IntegrationRow provider="plaid" manager={integrationManager} />
              </Section>

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

              <Section
                className="col-start-1 col-span-12"
                title="Operations"
                subtitle="Jobber and field ops data."
                icon={PlugZap}
              >
                <IntegrationRow provider="jobber" manager={integrationManager} />
              </Section>
            </>
          )}

          {/* -------- Billing -------- */}
          {activeTab === "Billing" && (
            <Section
              className="col-start-1 col-span-12"
              title="Subscription & Billing"
              subtitle="Manage your plan and invoices."
              icon={CreditCard}
            >
              <BillingCard userId={userId} businessId={businessId} status={billingStatus} />
              {loadingBilling && <p className="text-xs mt-2" style={{ color: TEXT_MUTED }}>Loading billing status…</p>}
            </Section>
          )}
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
        "relative inline-flex items-center rounded-full border border-white/15 bg-black/30 p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30",
        disabled ? "opacity-50 cursor-not-allowed" : "hover:border-white/30",
      ].join(" ")}
      style={{ width: 210, height: 52 }}
    >
      <span
        className={[
          "absolute inset-1 rounded-full bg-emerald-400/12 transition-all duration-300",
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

/* ---------------- UI helpers ---------------- */

function Badge({ children }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
      style={{ background: "rgba(255,255,255,0.06)", border: `1px solid ${NEUTRAL_BORDER}`, color: TEXT_MUTED }}
    >
      {children}
    </span>
  );
}

function Section({ title, subtitle, icon: Icon, children, className = "" }) {
  return (
    <div
      className={`m-0 w-full rounded-2xl shadow-bizzi border p-4 sm:p-5 ${className}`}
      style={{ background: PANEL_BG, border: `1px solid ${NEUTRAL_BORDER}` }}
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
  const [qbStatus, setQbStatus] = useState(null);

  const fetchQbStatus = useCallback(async () => {
    if (provider !== "quickbooks" || !businessId) return;
    try {
      const res = await safeFetch(apiUrl(`/auth/status?business_id=${businessId}`));
      setQbStatus(res || null);
      if (res) {
        if (res.connected) {
          manager?.markStatus?.("quickbooks", "connected");
        } else if (res.needs_setup || res.has_row) {
          manager?.markStatus?.("quickbooks", "awaiting");
        } else {
          manager?.markStatus?.("quickbooks", "disconnected");
        }
      }
    } catch {
      setQbStatus(null);
    }
  }, [businessId, manager, provider]);

  useEffect(() => {
    fetchQbStatus();
  }, [fetchQbStatus]);

  useEffect(() => {
    if (provider !== "quickbooks") return;
    const handler = () => fetchQbStatus();
    const visHandler = () => {
      if (document.visibilityState === "visible") fetchQbStatus();
    };
    window.addEventListener("focus", handler);
    document.addEventListener("visibilitychange", visHandler);
    return () => {
      window.removeEventListener("focus", handler);
      document.removeEventListener("visibilitychange", visHandler);
    };
  }, [fetchQbStatus, provider]);

  const handleConnect = () => {
    if (!provider || !manager) return;
    manager.connect(provider);
  };
  const handleDisconnect = async () => {
    if (!provider || !manager) return;
    await manager.disconnect(provider);
    await fetchQbStatus();
  };

  const ctaLabel = () => {
    if (provider === "quickbooks") {
      if (connecting) return "Connecting…";
      if (qbStatus?.connected) return "Manage";
      if (qbStatus?.needs_setup) return "Finish setup";
      if (qbStatus && qbStatus.connected === false && qbStatus.needs_setup === false) return "Connect QuickBooks";
    }
    if (state === "connected") return "Disconnect";
    if (state === "error") return "Retry";
    if (connecting) return "Connecting…";
    if (awaiting) return "Finish setup";
    return meta?.cta || "Connect";
  };

  return (
    <div
      data-integration={provider || undefined}
      className="flex items-center justify-between rounded-xl px-3 py-3 mb-2 transition"
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
        {provider === "quickbooks" && state === "connected" ? (
          <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.55)" }}>
            Company: {companyName || "Unknown"}
          </p>
        ) : null}
        {lastSync ? (
          <p className="text-[11px] text-white/50">Last synced {lastSync}</p>
        ) : null}
      </div>
      <div className="flex gap-2">
        {disabled ? (
          <GhostButton disabled>Coming soon</GhostButton>
        ) : state === "connected" ? (
          <GhostButton onClick={handleDisconnect}>{ctaLabel()}</GhostButton>
        ) : (
          <AccentButton onClick={handleConnect} disabled={connecting}>
            {ctaLabel()}
          </AccentButton>
        )}
      </div>
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
    disconnected: { text: "Not synced", className: "text-white/60" },
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
