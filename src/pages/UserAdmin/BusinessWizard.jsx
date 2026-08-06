// src/pages/UserAdmin/BusinessWizard.jsx
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { createBusinessProfile, ensureUserProfile, updateBusinessProfile } from '../../services/businessService';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../services/supabaseClient.js';
import { ArrowRight, Info } from 'lucide-react';
import bizzyLogo from '../../assets/bizzy-logo.png';

// ----- Options (expandable later) -----
const INDUSTRIES = [
  'Home Services','Construction','Roofing','HVAC','Plumbing','Electrical',
  'Remodeling','Landscaping','Cleaning','Painting','Flooring','Windows & Doors','General Contracting','Other'
];
const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN',
  'MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','Other'];
const BILLING_MODELS = ['Per project', 'Recurring service', 'Time & materials', 'Hybrid'];
const revenueBands = ['$0-100k','$100-250k','$250-500k','$500k-1M','$1-2M','$2-5M','$5M+'];
const ACCENT_HEX = '#34d399'; // app financials green (Books)
const CTA_BG = 'linear-gradient(180deg, rgba(245,247,251,0.16), rgba(245,247,251,0.07))';
const CTA_TEXT = '#f5f7fb';
const CTA_GLOW = '0 18px 44px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.10)';
const DRAFT_SCHEMA_VERSION = 1;
const LAST_DRAFT_STORAGE_KEY = `bizzy:onboarding-draft:last-key:v${DRAFT_SCHEMA_VERSION}`;
const DEFAULT_FORM_DATA = {
  business_name: '',
  founded_year: '',
  industry: '',
  team_size: '',
  annual_revenue: '',
  state: '',
  services_offered: '',
  billing_model: BILLING_MODELS[0],
  top_challenge: '',
};

const getDraftStorageKey = (userId) =>
  userId ? `bizzy:onboarding-draft:${userId}:v${DRAFT_SCHEMA_VERSION}` : null;

const readDraft = (storageKey) => {
  if (!storageKey || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed.formData || null;
  } catch (err) {
    console.warn('[BusinessWizard] draft restore failed:', err);
    return null;
  }
};

const readInitialDraft = () => {
  if (typeof window === 'undefined') return null;
  const userId = window.localStorage.getItem('user_id');
  const storageKey = getDraftStorageKey(userId);
  const draft = readDraft(storageKey);
  return draft ? { ...DEFAULT_FORM_DATA, ...draft } : null;
};

const writeDraft = (storageKey, formData) => {
  if (!storageKey || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_DRAFT_STORAGE_KEY, storageKey);
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        formData,
        updated_at: new Date().toISOString(),
      })
    );
  } catch (err) {
    console.warn('[BusinessWizard] draft save failed:', err);
  }
};

const clearDraft = (storageKey) => {
  if (!storageKey || typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey);
    if (window.localStorage.getItem(LAST_DRAFT_STORAGE_KEY) === storageKey) {
      window.localStorage.removeItem(LAST_DRAFT_STORAGE_KEY);
    }
  } catch {
    // ignore storage failures
  }
};

const hasDraftValues = (formData) =>
  Boolean(
    formData.business_name ||
      formData.founded_year ||
      formData.industry ||
      formData.team_size ||
      formData.annual_revenue ||
      formData.state ||
      formData.services_offered ||
      formData.top_challenge ||
      formData.billing_model !== DEFAULT_FORM_DATA.billing_model
  );

// ----- Small UI helpers -----
const AUTH_BG =
  'radial-gradient(820px 520px at 50% 34%, rgba(255,255,255,0.045), transparent 66%),' +
  'radial-gradient(700px 520px at 50% 58%, rgba(32,216,155,0.045), transparent 74%),' +
  'linear-gradient(180deg, #060807 0%, #020303 62%, #000 100%)';
const PANEL_BG = 'linear-gradient(180deg, rgba(15,18,17,0.82), rgba(8,10,10,0.86))';
const BORDER = 'rgba(255,255,255,0.105)';
const TEXT_MUTED = 'rgba(245,247,251,0.78)';

const Section = ({ title, subtitle, children }) => (
  <div
    className="rounded-[18px] p-4 shadow-[0_18px_52px_rgba(0,0,0,0.34)] md:p-5"
    style={{ background: PANEL_BG, border: `1px solid ${BORDER}` }}
  >
    <div className="mb-3">
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {subtitle && <p className="text-xs leading-5" style={{ color: TEXT_MUTED }}>{subtitle}</p>}
    </div>
    <div
      className="h-px w-full mb-4 rounded-full"
      style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent)' }}
    />
    {children}
  </div>
);

const Label = ({ children, required = false, htmlFor }) => (
  <label
    htmlFor={htmlFor}
    className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em]"
    style={{ color: TEXT_MUTED }}
  >
    <span>{children}</span>
    {required && (
      <span className="text-[9px] uppercase tracking-[0.12em] text-white/42">
        Required
      </span>
    )}
  </label>
);
const Input = ({ value, ...props }) => {
  const generatedId = useId();
  const id = props.id || props.name || generatedId;
  const name = props.name || props.id || generatedId;
  return (
    <input
      {...props}
      id={id}
      name={name}
      value={value ?? ''}
      className={`h-10 w-full rounded-[13px] border border-white/[0.13] bg-[#111513] px-3 text-sm text-white/90 outline-none
                  shadow-[inset_0_1px_0_rgba(255,255,255,0.04),inset_0_-8px_16px_rgba(0,0,0,0.14)]
                  transition placeholder:text-white/30
                  focus:border-emerald-300/30 focus:bg-[#151817] focus:ring-2 focus:ring-emerald-300/12 ${props.className||''}`}
    />
  );
};
const dropdownBaseClass =
  'h-10 w-full flex items-center justify-between gap-2 rounded-[13px] border border-white/[0.13] bg-[#111513] px-3 text-sm text-white/90 focus:outline-none transition shadow-[inset_0_1px_0_rgba(255,255,255,0.04),inset_0_-8px_16px_rgba(0,0,0,0.14)]';

const Dropdown = ({ id, value, onChange, options, placeholder = 'Select…', className = '', maxHeight = 240 }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const generatedId = useId();
  const buttonId = id || generatedId;
  const normalized = useMemo(() => {
    return (options || []).map((opt) =>
      typeof opt === 'string'
        ? { label: opt, value: opt }
        : { label: opt.label ?? opt.value, value: opt.value }
    );
  }, [options]);
  const selected = normalized.find((opt) => opt.value === value);

  useEffect(() => {
    const handler = (e) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      <button
        id={buttonId}
        type="button"
        className={`${dropdownBaseClass} ${open ? 'border-[rgba(52,211,153,0.45)] ring-1 ring-[rgba(52,211,153,0.28)]' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`truncate ${selected ? 'text-white' : 'text-white/40'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <svg
          className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24"
          stroke="currentColor"
          fill="none"
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div
        className={`absolute left-0 right-0 z-40 mt-2 origin-top rounded-[14px] border border-white/[0.13] bg-[#101312] shadow-[0_25px_60px_rgba(0,0,0,0.65)] backdrop-blur transition-all duration-200 ease-out ${
          open ? 'opacity-100 scale-100 translate-y-0' : 'pointer-events-none opacity-0 scale-95 -translate-y-1'
        }`}
      >
        <div className="dropdown-scroll" style={{ maxHeight, overflowY: 'auto' }}>
          {normalized.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`w-full px-3 py-2 text-left text-sm transition hover:bg-white/5 ${
                opt.value === value ? 'text-white' : 'text-white/70'
              }`}
              onClick={() => {
                onChange?.({ target: { value: opt.value } });
                setOpen(false);
              }}
            >
              {opt.label}
            </button>
          ))}
          {normalized.length === 0 && <div className="px-4 py-2 text-xs text-white/50">No options</div>}
        </div>
      </div>
    </div>
  );
};
const TextArea = (props) => {
  const generatedId = useId();
  const id = props.id || props.name || generatedId;
  const name = props.name || props.id || generatedId;
  return (
    <textarea
      {...props}
      id={id}
      name={name}
      value={props.value || ''}
      className="min-h-[84px] w-full rounded-[13px] border border-white/[0.13] bg-[#111513] px-3 py-2 text-sm text-white/90 outline-none transition placeholder:text-white/30 focus:border-emerald-300/30 focus:bg-[#151817] focus:ring-2 focus:ring-emerald-300/12"
    />
  );
};
// ----- Page -----
const BusinessWizard = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [formData, setFormData] = useState(() => readInitialDraft() || DEFAULT_FORM_DATA);
  const [existingBusinessId, setExistingBusinessId] = useState(null);
  const [draftReady, setDraftReady] = useState(false);
  const [animateEntry] = useState(() => {
    if (typeof window === 'undefined') return false;
    const shouldAnimate = window.sessionStorage.getItem('bizzy:animate-setup-once') === '1';
    if (shouldAnimate) {
      window.sessionStorage.removeItem('bizzy:animate-setup-once');
    }
    return shouldAnimate;
  });
  const draftStorageKey = useMemo(() => getDraftStorageKey(user?.id), [user?.id]);

  const accent = useMemo(() => ACCENT_HEX, []);
  const ctaStyle = useMemo(
    () => ({
      background: CTA_BG,
      color: CTA_TEXT,
      boxShadow: CTA_GLOW,
      borderColor: 'rgba(255,255,255,0.16)',
    }),
    []
  );
  const cameFromSettings = useMemo(() => {
    const params = new URLSearchParams(location.search || '');
    return Boolean(location.state?.fromSettings) || params.get('from') === 'settings';
  }, [location.search, location.state]);
  const showBackToSettings = Boolean(existingBusinessId && cameFromSettings);
  // subtle pulse used by the header dot
  const pulseCSS = `
    @keyframes bizzy-pulse {
      0%   { transform: scale(1);   box-shadow: 0 0 12px rgba(52,211,153,0.35); }
      50%  { transform: scale(1.08); box-shadow: 0 0 24px rgba(52,211,153,0.65); }
      100% { transform: scale(1);   box-shadow: 0 0 12px rgba(52,211,153,0.35); }
    }
  `;

  const setField = (name, value) => {
    setFormData((prev) => {
      const next = { ...prev, [name]: value };
      if (draftReady && draftStorageKey && !existingBusinessId) {
        if (hasDraftValues(next)) writeDraft(draftStorageKey, next);
        else clearDraft(draftStorageKey);
      }
      return next;
    });
  };

  const hasRequiredFields =
    formData.business_name &&
    formData.industry &&
    formData.team_size &&
    formData.state &&
    formData.services_offered;

  const canFinish = hasRequiredFields && !loading;

  useEffect(() => {
    setDraftReady(false);
    if (!user?.id) return;
    let alive = true;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('business_profiles')
          .select('*')
          .eq('user_id', user.id)
          .limit(1);
        if (!alive) return;
        if (error) {
          setDraftReady(true);
          return;
        }
        if (!data || data.length === 0) {
          const draft = readDraft(getDraftStorageKey(user.id));
          if (draft && alive) {
            setExistingBusinessId(null);
            setFormData({
              ...DEFAULT_FORM_DATA,
              ...draft,
            });
          }
          if (alive) setDraftReady(true);
          return;
        }
        const record = data[0];
        setExistingBusinessId(record.id);
        clearDraft(getDraftStorageKey(user.id));
        const normalize = (val, fallback = '') => (val === null || val === undefined ? fallback : val);

        setFormData((prev) => ({
          ...prev,
          ...record,
          business_name: normalize(record.business_name, prev.business_name),
          industry: normalize(record.industry, prev.industry),
          state: normalize(record.state, prev.state),
          services_offered: normalize(record.services_offered, prev.services_offered),
          annual_revenue: normalize(record.annual_revenue, prev.annual_revenue),
          founded_year: normalize(record.founded_year, prev.founded_year),
          team_size: normalize(record.team_size, prev.team_size),
          billing_model: normalize(record.billing_model, prev.billing_model),
          top_challenge: normalize(record.top_challenge, prev.top_challenge),
        }));
        setDraftReady(true);
      } catch (err) {
        console.warn('[BusinessWizard] preload failed:', err);
        if (alive) setDraftReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!draftReady || !draftStorageKey || existingBusinessId) return;
    if (!hasDraftValues(formData)) {
      clearDraft(draftStorageKey);
      return;
    }
    writeDraft(draftStorageKey, formData);
  }, [draftReady, draftStorageKey, existingBusinessId, formData]);

  useEffect(() => {
    if (!draftReady || !draftStorageKey || existingBusinessId) return undefined;
    const saveCurrentDraft = () => {
      if (hasDraftValues(formData)) writeDraft(draftStorageKey, formData);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') saveCurrentDraft();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', saveCurrentDraft);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', saveCurrentDraft);
    };
  }, [draftReady, draftStorageKey, existingBusinessId, formData]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canFinish) return;
    setError('');
    setLoading(true);
    try {
      const { error: userProfileError } = await ensureUserProfile(user);
      if (userProfileError) throw userProfileError;

      const {
        founded_year,
        ...profileRow
      } = formData;

      const foundedYearInt =
        founded_year === "" || founded_year === null || founded_year === undefined
          ? null
          : Number.parseInt(String(founded_year), 10);
      const founded_year_safe = Number.isFinite(foundedYearInt) ? foundedYearInt : null;

      const payload = {
        ...profileRow,
        user_id: user.id,
        team_size: parseInt(formData.team_size || '0', 10),
        founded_year: founded_year_safe,
      };
      let businessId = existingBusinessId;
      if (existingBusinessId) {
        const { error: updateErr } = await updateBusinessProfile(existingBusinessId, payload);
        if (updateErr) throw updateErr;
      } else {
        const { data: createdBusiness, error: businessError } = await createBusinessProfile(payload);
        if (businessError) throw businessError;
        businessId = createdBusiness?.[0]?.id;
        const { error: linkError } = await supabase
          .from('user_business_link')
          .insert([{ user_id: user.id, business_id: businessId, role: 'owner' }]);
        if (linkError) throw linkError;
      }

      if (businessId) {
        clearDraft(draftStorageKey);
        localStorage.setItem('isProfileComplete', 'true');
        localStorage.setItem('currentBusinessId', businessId);
        localStorage.setItem('bizzy:business_name', payload.business_name || '');
        localStorage.setItem('bizzy:industry', payload.industry || '');
        if (import.meta?.env?.DEV) {
          console.log("[BusinessWizard] saved profile", { businessId, payload });
          const { data: check, error: checkErr } = await supabase
            .from('business_profiles')
            .select('id, business_name, industry, founded_year')
            .eq('id', businessId)
            .single();
          console.log("[BusinessWizard] verify business_profiles", check, checkErr);
        }
        try { window.dispatchEvent(new Event('bizzy:onboarding-flags-updated')); } catch { /* ignore */ }
        setExistingBusinessId(businessId);
      }
      navigate(cameFromSettings ? '/dashboard/settings?tab=Business' : '/dashboard');
    } catch (err) {
      setError(err?.message || 'An error occurred during setup.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const { body } = document;
    const prevOverflow = body.style.overflow;
    const prevBg = body.style.background;
    body.style.overflow = 'hidden';
    body.style.background = 'var(--bg)';
    return () => {
      body.style.overflow = prevOverflow;
      body.style.background = prevBg;
    };
  }, []);

  return (
    <div
      className={`${animateEntry ? 'bizzy-auth-page' : ''} relative min-h-screen w-screen overflow-hidden text-white bizzy-bg-textured`}
      style={{ '--accent': accent, background: AUTH_BG }}
    >
      <style>{`
        ${pulseCSS}
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        .dropdown-scroll { -ms-overflow-style: none; scrollbar-width: none; }
        .dropdown-scroll::-webkit-scrollbar { width: 0; height: 0; }
        .dropdown-scroll::-webkit-scrollbar-thumb { background: transparent; }
        .dropdown-scroll::-webkit-scrollbar-track { background: transparent; }
      `}</style>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          boxShadow: 'inset 0 0 140px rgba(0,0,0,0.68)',
          filter: 'saturate(92%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[46%] h-[520px] w-[min(980px,88vw)] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[54px]"
        style={{
          background:
            'radial-gradient(64% 105% at 50% 42%, rgba(255,255,255,0.055), transparent 70%), radial-gradient(70% 115% at 50% 60%, rgba(32,216,155,0.045), transparent 78%)',
          opacity: 0.58,
          mixBlendMode: 'screen',
        }}
      />

      <div className="relative z-10 h-screen w-full overflow-hidden">
        <div className="no-scrollbar h-full overflow-y-auto px-4 py-8 sm:py-10">
          <div
            className={`${animateEntry ? 'bizzy-auth-card-wrap' : ''} relative mx-auto w-full max-w-4xl text-white`}
          >
            {showBackToSettings ? (
            <div className="absolute right-0 top-1 z-10">
              <button
                type="button"
                onClick={() => navigate('/dashboard/settings?tab=Business')}
                className="inline-flex items-center gap-2 px-1 py-1 text-sm font-semibold text-white/58 transition hover:text-white focus:outline-none focus-visible:text-white"
              >
                ← Settings
              </button>
            </div>
            ) : null}
        <div className="relative flex flex-col items-center gap-3 text-center">
          <div
            className="h-12 w-12 rounded-full border border-emerald-300/32 bg-white/[0.07] p-[6px] shadow-[0_12px_28px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.08)]"
            style={{
              boxShadow: `0 0 16px rgba(52,211,153,0.30)`
            }}
          >
            <img src={bizzyLogo} alt="Bizzi logo" className="h-full w-full rounded-full object-contain bg-[#0F1115]" />
          </div>
          <div>
            <div className="mb-2 text-[12px] font-light uppercase tracking-[0.5em] text-white/[0.74]">Bizzi</div>
            <h2 className="text-2xl font-semibold tracking-[-0.01em] text-white md:text-[1.7rem]">Set up your business</h2>
            <p className="mx-auto mt-1 max-w-2xl text-sm leading-5 text-white/58">
              Bizzi uses these signals to tailor your workspace and chat guidance.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="relative mt-6 space-y-4">
          <Section
            title="Business identity"
            subtitle="Let's ground Bizzi in the core details needed to tailor your workspace."
          >
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <Label htmlFor="setup-business-name" required>Business Name</Label>
                <Input
                  id="setup-business-name"
                  name="business_name"
                  autoComplete="organization"
                  value={formData.business_name}
                  onChange={(e)=>setField('business_name', e.target.value)}
                  placeholder="e.g., Summit Roofing & Repairs"
                  required
                />
              </div>
              <div>
                <Label htmlFor="setup-industry" required>Industry</Label>
                <Dropdown
                  id="setup-industry"
                  value={formData.industry}
                  onChange={(e)=>setField('industry', e.target.value)}
                  options={[{ value: '', label: 'Select industry' }, ...INDUSTRIES.map((i) => ({ value: i, label: i }))]}
                  placeholder="Select industry"
                />
              </div>
              <div>
                <Label htmlFor="setup-team-size" required>Team size</Label>
                <Input
                  id="setup-team-size"
                  name="team_size"
                  type="number"
                  min={1}
                  value={formData.team_size}
                  onChange={(e)=>setField('team_size', e.target.value)}
                  placeholder="e.g., 8"
                  required
                />
              </div>
              <div>
                <Label htmlFor="setup-annual-revenue">Annual revenue</Label>
                <Dropdown
                  id="setup-annual-revenue"
                  value={formData.annual_revenue}
                  onChange={(e)=>setField('annual_revenue', e.target.value)}
                  placeholder="Select..."
                  options={[{ value: '', label: 'Select...' }, ...revenueBands.map((b) => ({ value: b, label: b }))]}
                />
              </div>
              <div>
                <Label htmlFor="setup-founded-year">Founded year</Label>
                <Input
                  id="setup-founded-year"
                  name="founded_year"
                  autoComplete="off"
                  type="number"
                  min={1990}
                  max={new Date().getFullYear()}
                  value={formData.founded_year}
                  onChange={(e)=>setField('founded_year', e.target.value)}
                  placeholder="2014"
                />
              </div>
              <div>
                <Label htmlFor="setup-state" required>State / province</Label>
                <Dropdown
                  id="setup-state"
                  value={formData.state}
                  onChange={(e)=>setField('state', e.target.value)}
                  options={[{ value: '', label: 'Select state' }, ...STATES.map((s) => ({ value: s, label: s }))]}
                  placeholder="Select state"
                />
              </div>
              <div>
                <Label htmlFor="setup-services-offered" required>Services offered</Label>
                <Input
                  id="setup-services-offered"
                  name="services_offered"
                  autoComplete="off"
                  value={formData.services_offered}
                  onChange={(e)=>setField('services_offered', e.target.value)}
                  placeholder="Remodeling, renovations, home repair"
                  required
                />
              </div>
              <div>
                <Label htmlFor="setup-billing-model">Billing model</Label>
                <Dropdown
                  id="setup-billing-model"
                  value={formData.billing_model}
                  onChange={(e)=>setField('billing_model', e.target.value)}
                  options={BILLING_MODELS}
                />
              </div>
              <div className="md:col-span-2">
                <div className="mb-1.5 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <Label htmlFor="setup-top-challenge">Biggest headache right now</Label>
                  <span className="text-[11px] text-white/40">
                    Optional, used to personalize Bizzi chat responses.
                  </span>
                </div>
                <TextArea
                  id="setup-top-challenge"
                  name="top_challenge"
                  autoComplete="off"
                  value={formData.top_challenge}
                  onChange={(e)=>setField('top_challenge', e.target.value)}
                  placeholder="Cash swings, lead quality, labor utilization, project margins, etc."
                />
              </div>
              <div className="md:col-span-2 text-xs text-white/48">
                <div className="flex items-center gap-2">
                  <Info size={14} className="text-white/36" />
                  You can adjust these later in Settings → Preferences.
                </div>
              </div>
            </div>
          </Section>

          {/* Errors */}
          {error && <p className="text-rose-400 text-sm">{error}</p>}

          <div className="flex items-center justify-end pt-1">
            <button
              type="submit"
              disabled={!canFinish}
              className={`inline-flex h-10 items-center gap-2 rounded-[12px] border px-6 text-sm font-semibold transition hover:bg-white/[0.14] ${
                !canFinish ? 'bg-white/10 text-white/40 cursor-not-allowed' : ''
              }`}
              style={!canFinish ? undefined : ctaStyle}
            >
              {loading ? 'Setting up...' : 'Finish Setup'} <ArrowRight size={16} />
            </button>
          </div>
        </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BusinessWizard;
