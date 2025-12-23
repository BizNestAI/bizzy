// src/pages/UserAdmin/BusinessWizard.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createBusinessProfile, updateBusinessProfile } from '../../services/businessService';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../services/supabaseClient.js';
import { Check, ArrowRight, ArrowLeft, Info } from 'lucide-react';
import bizzyLogo from '../../assets/bizzy-logo.png';

// ----- Options (expandable later) -----
const INDUSTRIES = [
  'Home Services','Construction','Roofing','HVAC','Plumbing','Electrical',
  'Remodeling','Landscaping','Cleaning','Painting','Flooring','Windows & Doors','General Contracting','Other'
];
const TIMEZONES = (Intl.supportedValuesOf?.('timeZone') || []).sort((a,b)=>a.localeCompare(b));
const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN',
  'MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','Other'];
const GOALS = [
  'Grow reviews',
  'Improve margins',
  'Reduce tax surprises',
  'Drive more leads',
  'Automate follow-ups',
  'Better forecasting',
  'Streamline scheduling',
];
const MARKETING_CHANNELS = [
  'Word of mouth',
  'Google Ads',
  'Meta / Instagram',
  'Email marketing',
  'Door-to-door / canvassing',
  'Partnerships',
];
const BILLING_MODELS = ['Per project', 'Recurring service', 'Time & materials', 'Hybrid'];
const ACCOUNTING_STACK = ['QuickBooks Online', 'QuickBooks Desktop', 'Xero', 'Wave', 'Other'];
const OPS_PLATFORMS = ['Jobber', 'Housecall Pro', 'ServiceTitan', 'HubSpot', 'None yet'];
const OWNER_ROLES = ['Owner / CEO', 'COO / Operations', 'Finance lead', 'Office manager'];
const revenueBands = ['$0-100k','$100-250k','$250-500k','$500k-1M','$1-2M','$2-5M','$5M+'];
const CTA_BG = '#E1E7F5';
const CTA_TEXT = '#05070B';
const CTA_GLOW = 'rgba(186,198,255,0.45)';

// ----- Small UI helpers -----
const PANEL_BG = 'rgba(20,22,27,0.92)';
const BORDER = 'rgba(191,191,191,0.25)';
const TEXT_MUTED = 'rgba(229,235,245,0.75)';

function hexToChromeGlow(hex, alpha = 0.45) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

const Section = ({ title, subtitle, children }) => (
  <div
    className="rounded-3xl p-5 md:p-6 shadow-[0_20px_45px_rgba(0,0,0,0.45)]"
    style={{ background: PANEL_BG, border: `1px solid ${BORDER}` }}
  >
    <div className="mb-3">
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      {subtitle && <p className="text-sm" style={{ color: TEXT_MUTED }}>{subtitle}</p>}
    </div>
    <div className="h-px w-full mb-4 rounded-full"
         style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent)' }} />
    {children}
  </div>
);

const Label = ({ children, required = false }) => (
  <label
    className="text-sm font-medium mb-1 flex items-center gap-2"
    style={{ color: TEXT_MUTED }}
  >
    <span>{children}</span>
    {required && (
      <span className="text-[10px] uppercase tracking-[0.12em] text-white/60">
        Required
      </span>
    )}
  </label>
);
const Input = ({ value, ...props }) => (
  <input
    {...props}
    value={value ?? ''}
    className={`w-full px-3 py-2 rounded-xl bg-[#0F1115] border border-white/10 outline-none text-white placeholder:text-white/40
                focus:ring-2 focus:ring-[rgba(191,191,191,0.65)] ${props.className||''}`}
  />
);
const dropdownBaseClass =
  'w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[#0F1115] border border-white/10 text-sm text-white focus:outline-none transition shadow-[0_6px_20px_rgba(0,0,0,0.35)]';

const Dropdown = ({ value, onChange, options, placeholder = 'Select…', className = '', maxHeight = 240 }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
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
        type="button"
        className={`${dropdownBaseClass} ${open ? 'border-white/30' : ''}`}
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
        className={`absolute left-0 right-0 z-40 mt-2 origin-top rounded-2xl border border-white/12 bg-[#101218] shadow-[0_25px_60px_rgba(0,0,0,0.65)] backdrop-blur transition-all duration-200 ease-out ${
          open ? 'opacity-100 scale-100 translate-y-0' : 'pointer-events-none opacity-0 scale-95 -translate-y-1'
        }`}
      >
        <div className="dropdown-scroll" style={{ maxHeight, overflowY: 'auto' }}>
          {normalized.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`w-full text-left px-4 py-2 text-sm hover:bg-white/5 transition ${
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
const TextArea = (props) => (
  <textarea
    {...props}
    value={props.value || ''}
    className="w-full rounded-xl bg-[#0F1115] border border-white/10 text-white px-3 py-2 min-h-[96px] outline-none focus:ring-2 focus:ring-[var(--accent)]/55"
  />
);
const Toggle = ({ checked, onChange, label }) => (
  <button
    type="button"
    onClick={() => onChange(!checked)}
    className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm border
               ${checked ? 'border-[var(--accent)] text-[var(--accent)] shadow-[0_0_12px_var(--accent)]' : 'border-white/15 text-white/80'}`}
  >
    {checked ? <Check size={14}/> : <Info size={14}/>} {label}
  </button>
);

// ----- Page -----
const BusinessWizard = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [formData, setFormData] = useState({
    business_name: '',
    owner_name: '',
    owner_role: OWNER_ROLES[0],
    founded_year: '',
    website_url: '',
    industry: '',
    team_size: '',
    annual_revenue_band: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    state: '',
    operating_area: '',
    services_offered: '',
    service_radius: '',
    average_job_size: '',
    billing_model: BILLING_MODELS[0],
    accounting_stack: ACCOUNTING_STACK[0],
    ops_platform: OPS_PLATFORMS[0],
    marketing_channels: [],
    google_review_link: '',
    facebook_page_url: '',
    insights_focus: [],
    accept_sample_data: true,
    top_challenge: '',
    win_definition: '',
  });
  const [existingBusinessId, setExistingBusinessId] = useState(null);

  const accent = useMemo(() => '#C6D3FF', []);
  const ctaStyle = useMemo(
    () => ({ background: CTA_BG, color: CTA_TEXT, boxShadow: `0 0 24px ${CTA_GLOW}` }),
    []
  );
  // subtle pulse used by the header dot
  const pulseCSS = `
    @keyframes bizzy-pulse {
      0%   { transform: scale(1);   box-shadow: 0 0 12px rgba(198,211,255,0.45); }
      50%  { transform: scale(1.08); box-shadow: 0 0 26px rgba(198,211,255,0.85); }
      100% { transform: scale(1);   box-shadow: 0 0 12px rgba(198,211,255,0.45); }
    }
  `;

  const setField = (name, value) => setFormData(prev => ({ ...prev, [name]: value }));

  const canNext1 =
    formData.business_name &&
    formData.industry &&
    formData.team_size &&
    formData.timezone &&
    formData.state;

  const canNext2 = formData.operating_area && formData.services_offered;
  const prioritiesComplete = formData.top_challenge && formData.win_definition;
  const canFinish = canNext1 && canNext2 && prioritiesComplete && !loading;
  const nextDisabled =
    (step === 1 && !canNext1) ||
    (step === 2 && (!canNext2 || loading));

  useEffect(() => {
    if (!user?.id) return;
    let alive = true;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('business_profiles')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: true })
          .limit(1);
        if (!alive || error || !data || data.length === 0) return;
        const record = data[0];
        setExistingBusinessId(record.id);
        const meta = record.profile_meta || {};
        const normalize = (val, fallback = '') => (val === null || val === undefined ? fallback : val);
        const normalizeArray = (val) => (Array.isArray(val) ? val : []);

        setFormData((prev) => ({
          ...prev,
          ...record,
          business_name: normalize(record.business_name, prev.business_name),
          industry: normalize(record.industry, prev.industry),
          state: normalize(record.state, prev.state),
          operating_area: normalize(record.operating_area, prev.operating_area),
          services_offered: normalize(record.services_offered, prev.services_offered),
          service_radius: normalize(meta.service_radius ?? record.service_radius, prev.service_radius),
          annual_revenue_band: normalize(record.annual_revenue_band, prev.annual_revenue_band),
          website_url: normalize(meta.website_url ?? record.website_url, prev.website_url),
          owner_name: normalize(meta.owner_name ?? record.owner_name, prev.owner_name),
          owner_role: normalize(meta.owner_role, prev.owner_role),
          founded_year: normalize(meta.founded_year ?? record.founded_year, prev.founded_year),
          team_size: normalize(record.team_size, prev.team_size),
          billing_model: normalize(meta.billing_model ?? record.billing_model, prev.billing_model),
          accounting_stack: normalize(meta.accounting_stack ?? record.accounting_stack, prev.accounting_stack),
          ops_platform: normalize(meta.ops_platform ?? record.ops_platform, prev.ops_platform),
          marketing_channels: normalizeArray(meta.marketing_channels ?? record.marketing_channels ?? prev.marketing_channels),
          google_review_link: normalize(record.google_review_link, prev.google_review_link),
          facebook_page_url: normalize(record.facebook_page_url, prev.facebook_page_url),
          top_challenge: normalize(meta.top_challenge, prev.top_challenge),
          win_definition: normalize(meta.win_definition, prev.win_definition),
        }));
      } catch (err) {
        console.warn('[BusinessWizard] preload failed:', err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [user?.id]);

  const toggleGoal = (g) =>
    setFormData(prev => {
      const current = Array.isArray(prev.insights_focus) ? prev.insights_focus : [];
      const set = new Set(current);
      set.has(g) ? set.delete(g) : set.add(g);
      return { ...prev, insights_focus: Array.from(set) };
    });

  const toggleChip = (field, value) =>
    setFormData(prev => {
      const current = Array.isArray(prev[field]) ? prev[field] : [];
      const set = new Set(current);
      set.has(value) ? set.delete(value) : set.add(value);
      return { ...prev, [field]: Array.from(set) };
    });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canFinish) return;
    setError('');
    setLoading(true);
    try {
      const {
        owner_name,
        owner_role,
        founded_year,
        website_url,
        service_radius,
        average_job_size,
        billing_model,
        accounting_stack,
        ops_platform,
        top_challenge,
        win_definition,
        ...profileRow
      } = formData;

      const profileMeta = {
        owner_name,
        owner_role,
        founded_year,
        website_url,
        service_radius,
        average_job_size,
        billing_model,
        accounting_stack,
        ops_platform,
        marketing_channels: formData.marketing_channels,
        top_challenge,
        win_definition,
      };

      const payload = {
        ...profileRow,
        user_id: user.id,
        team_size: parseInt(formData.team_size || '0', 10),
        profile_meta: profileMeta,
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
        localStorage.setItem('isProfileComplete', 'true');
        localStorage.setItem('currentBusinessId', businessId);
        setExistingBusinessId(businessId);
      }
      navigate('/dashboard');
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
    body.style.background = '#03060C';
    return () => {
      body.style.overflow = prevOverflow;
      body.style.background = prevBg;
    };
  }, []);

  return (
    <div className="relative min-h-screen w-screen text-white" style={{ '--accent': accent }}>
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
          background:
            'radial-gradient(900px circle at 18% 8%, rgba(79,133,255,0.2), transparent 45%), ' +
            'radial-gradient(700px circle at 80% 85%, rgba(135,255,223,0.15), transparent 55%), ' +
            'linear-gradient(135deg, rgba(6,9,16,0.95), rgba(3,4,8,1))'
        }}
      />

      <div className="relative z-10 h-screen w-full overflow-hidden">
        <div className="no-scrollbar h-full overflow-y-auto px-4 py-12">
          <div
            className="relative w-full max-w-5xl mx-auto rounded-[32px] border backdrop-blur-xl p-6 md:p-10 space-y-7"
            style={{
              borderColor: BORDER,
              background: 'linear-gradient(145deg, rgba(24,27,34,0.9), rgba(8,10,15,0.96))',
              boxShadow: '0 80px 140px rgba(0,0,0,0.65)',
            }}
          >
            <div className="absolute right-6 top-6">
              <button
                type="button"
                onClick={() => navigate('/dashboard/settings')}
                className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-white/5"
                style={{ border: '1px solid rgba(165,167,169,0.22)', color: 'var(--text-2)' }}
              >
                ← Settings
              </button>
            </div>
        <div className="flex flex-col items-center gap-3 text-center">
          <div
            className="h-14 w-14 rounded-full p-[6px]"
            style={{
              border: `1px solid ${hexToChromeGlow('#BFBFBF', 0.35)}`,
              boxShadow: `0 0 20px rgba(191,191,191,0.35)`
            }}
          >
            <img src={bizzyLogo} alt="Bizzi logo" className="h-full w-full rounded-full object-contain bg-[#0F1115]" />
          </div>
          <div>
            <h2 className="text-2xl md:text-3xl font-semibold">Set up your business</h2>
            <p className="text-sm" style={{ color: TEXT_MUTED }}>
              Bizzi uses these signals to prime insights, automate outreach, and keep guidance on-brand.
            </p>
          </div>
        </div>

        {/* Stepper */}
        <div className="flex items-center justify-center gap-2 text-xs">
          {[1,2,3].map((n) => (
            <div
              key={n}
              className={`h-2 w-20 rounded-full transition-all ${
                n <= step ? 'bg-white shadow-[0_0_12px_rgba(255,255,255,0.45)]' : 'bg-white/15'
              }`}
            />
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* STEP 1 — BASICS */}
          {step === 1 && (
            <Section
              title="Business identity"
              subtitle="Let’s ground Bizzi in who you are and who leads the operation."
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <Label required>Business Name</Label>
                  <Input
                    name="business_name"
                    value={formData.business_name}
                    onChange={(e)=>setField('business_name', e.target.value)}
                    placeholder="e.g., Summit Roofing & Repairs"
                    required
                  />
                </div>
                <div>
                  <Label>Owner / main contact</Label>
                  <Input
                    name="owner_name"
                    value={formData.owner_name}
                    onChange={(e)=>setField('owner_name', e.target.value)}
                    placeholder="e.g., Alex Summit"
                  />
                </div>
                <div>
                  <Label>Role</Label>
                  <Dropdown
                    value={formData.owner_role}
                    onChange={(e)=>setField('owner_role', e.target.value)}
                    options={OWNER_ROLES}
                  />
                </div>
                <div>
                  <Label required>Industry</Label>
                  <Dropdown
                    value={formData.industry}
                    onChange={(e)=>setField('industry', e.target.value)}
                    options={[{ value: '', label: 'Select industry' }, ...INDUSTRIES.map((i) => ({ value: i, label: i }))]}
                    placeholder="Select industry"
                  />
                </div>
                <div>
                  <Label required>Team size</Label>
                  <Input
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
                  <Label>Annual revenue (band)</Label>
                  <Dropdown
                    value={formData.annual_revenue_band}
                    onChange={(e)=>setField('annual_revenue_band', e.target.value)}
                    placeholder="Select…"
                    options={[{ value: '', label: 'Select…' }, ...revenueBands.map((b) => ({ value: b, label: b }))]}
                  />
                </div>
                <div>
                  <Label>Founded year</Label>
                  <Input
                    name="founded_year"
                    type="number"
                    min={1990}
                    max={new Date().getFullYear()}
                    value={formData.founded_year}
                    onChange={(e)=>setField('founded_year', e.target.value)}
                    placeholder="2014"
                  />
                </div>
                <div>
                  <Label>Website</Label>
                  <Input
                    name="website_url"
                    value={formData.website_url}
                    onChange={(e)=>setField('website_url', e.target.value)}
                    placeholder="https://yourdomain.com"
                  />
                </div>
                <div>
                  <Label required>Timezone</Label>
                  <Dropdown
                    value={formData.timezone}
                    onChange={(e)=>setField('timezone', e.target.value)}
                    options={[{ value: '', label: 'Select timezone' }, ...TIMEZONES.map((tz) => ({ value: tz, label: tz }))]}
                    placeholder="Select timezone"
                    maxHeight={260}
                  />
                </div>
                <div>
                  <Label required>State / province</Label>
                  <Dropdown
                    value={formData.state}
                    onChange={(e)=>setField('state', e.target.value)}
                    options={[{ value: '', label: 'Select state' }, ...STATES.map((s) => ({ value: s, label: s }))]}
                    placeholder="Select state"
                  />
                </div>
              </div>
            </Section>
          )}

          {/* STEP 2 — OPERATIONS */}
          {step === 2 && (
            <Section
              title="How you operate"
              subtitle="Bizzi blends this with live data to craft recommendations."
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <Label required>Primary operating area</Label>
                  <Input
                    name="operating_area"
                    value={formData.operating_area}
                    onChange={(e)=>setField('operating_area', e.target.value)}
                    placeholder="e.g., Raleigh-Durham metro / 27601"
                    required
                  />
                </div>
                <div>
                  <Label>Service radius</Label>
                  <Input
                    name="service_radius"
                    value={formData.service_radius}
                    onChange={(e)=>setField('service_radius', e.target.value)}
                    placeholder="e.g., 45 miles or 3 counties"
                  />
                </div>
                <div>
                  <Label required>Services offered</Label>
                  <Input
                    name="services_offered"
                    value={formData.services_offered}
                    onChange={(e)=>setField('services_offered', e.target.value)}
                    placeholder="Roof repair, new installs, gutter cleaning"
                    required
                  />
                </div>
                <div>
                  <Label>Average job size</Label>
                  <Input
                    name="average_job_size"
                    value={formData.average_job_size}
                    onChange={(e)=>setField('average_job_size', e.target.value)}
                    placeholder="$12k"
                  />
                </div>
                <div>
                  <Label>Billing model</Label>
                  <Dropdown
                    value={formData.billing_model}
                    onChange={(e)=>setField('billing_model', e.target.value)}
                    options={BILLING_MODELS}
                  />
                </div>
                <div>
                  <Label>Accounting system</Label>
                  <Dropdown
                    value={formData.accounting_stack}
                    onChange={(e)=>setField('accounting_stack', e.target.value)}
                    options={ACCOUNTING_STACK}
                  />
                </div>
                <div>
                  <Label>Field ops / CRM</Label>
                  <Dropdown
                    value={formData.ops_platform}
                    onChange={(e)=>setField('ops_platform', e.target.value)}
                    options={OPS_PLATFORMS}
                  />
                </div>
                <div className="md:col-span-2">
                  <Label>Marketing channels you rely on</Label>
                  <div className="flex flex-wrap gap-2">
                    {MARKETING_CHANNELS.map((channel) => (
                      <Toggle
                        key={channel}
                        checked={(Array.isArray(formData.marketing_channels) ? formData.marketing_channels : []).includes(channel)}
                        onChange={() => toggleChip('marketing_channels', channel)}
                        label={channel}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <Label>Google review link</Label>
                  <Input
                    name="google_review_link"
                    value={formData.google_review_link}
                    onChange={(e)=>setField('google_review_link', e.target.value)}
                    placeholder="https://g.page/r/..."
                  />
                </div>
                <div>
                  <Label>Facebook / socials</Label>
                  <Input
                    name="facebook_page_url"
                    value={formData.facebook_page_url}
                    onChange={(e)=>setField('facebook_page_url', e.target.value)}
                    placeholder="https://facebook.com/your-page"
                  />
                </div>
              </div>
            </Section>
          )}

          {/* STEP 3 — PREFERENCES */}
          {step === 3 && (
            <Section
              title="Priorities"
              subtitle="Share the context Bizzi should remember when suggesting moves."
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <Label>Focus areas for Bizzi</Label>
                  <div className="flex flex-wrap gap-2">
                    {GOALS.map(g => (
                      <Toggle
                        key={g}
                        checked={(Array.isArray(formData.insights_focus) ? formData.insights_focus : []).includes(g)}
                        onChange={()=>toggleGoal(g)}
                        label={g}
                      />
                    ))}
                  </div>
                </div>
                <div className="md:col-span-2">
                  <Label required>Biggest headache right now</Label>
                  <TextArea
                    name="top_challenge"
                    value={formData.top_challenge}
                    onChange={(e)=>setField('top_challenge', e.target.value)}
                    placeholder="Cash swings, lead quality, labor utilization, etc."
                    required
                  />
                </div>
                <div className="md:col-span-2">
                  <Label required>“Bizzi was a win” if… (next 90 days)</Label>
                  <TextArea
                    name="win_definition"
                    value={formData.win_definition}
                    onChange={(e)=>setField('win_definition', e.target.value)}
                    placeholder="e.g., Keep AR under $25k and automate weekly marketing recap."
                    required
                  />
                </div>
                <div className="md:col-span-2">
                  <Label>Allow sample data until I connect integrations</Label>
                  <Toggle
                    checked={formData.accept_sample_data}
                    onChange={(v)=>setField('accept_sample_data', v)}
                    label={formData.accept_sample_data ? 'Enabled' : 'Disabled'}
                  />
                </div>
                <div className="text-xs" style={{ color: TEXT_MUTED }}>
                  <div className="flex items-center gap-2">
                    <Info size={14} className="text-white/40" />
                    You can adjust these later in Settings → Preferences.
                  </div>
                </div>
              </div>
            </Section>
          )}

          {/* Errors */}
          {error && <p className="text-rose-400 text-sm">{error}</p>}

          {/* Footer buttons */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setStep((s)=>Math.max(1, s-1))}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-white/15 hover:bg-white/5"
              disabled={step === 1 || loading}
            >
              <ArrowLeft size={16}/> Back
            </button>

            {step < 3 ? (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  if (!nextDisabled) setStep((s)=>Math.min(3, s+1));
                }}
                className={`inline-flex items-center gap-2 px-5 py-2 rounded-md transition ${
                  nextDisabled ? 'bg-white/10 text-white/40 cursor-not-allowed' : ''
                }`}
                style={nextDisabled ? undefined : ctaStyle}
                disabled={nextDisabled}
              >
                Next <ArrowRight size={16} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canFinish}
                className={`inline-flex items-center gap-2 px-6 py-2 rounded-md transition ${
                  !canFinish ? 'bg-white/10 text-white/40 cursor-not-allowed' : ''
                }`}
                style={!canFinish ? undefined : ctaStyle}
              >
                {loading ? 'Setting up…' : 'Finish Setup'}
              </button>
            )}
          </div>
        </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BusinessWizard;
