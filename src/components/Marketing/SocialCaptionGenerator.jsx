// src/components/Marketing/SocialCaptionGenerator.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "@supabase/auth-helpers-react";
import { Loader2, Wand2, Copy, Check, Hash, Image as ImageIcon, ChevronDown } from "lucide-react";
import { savePostToGallery } from "../../services/savePostToGallery";
import { supabase } from "../../services/supabaseClient";
import { safeFetch } from "../../utils/safeFetch";
import { toTitleCasePlatform } from "../../utils/formatters";
import Banner from "../ui/Banner";
import SampleDataRibbon from "../ui/SampleDataRibbon";
import CardHeader from "../ui/CardHeader";

/* ------------ Bizzy hard cap + helper ------------- */
const BIZZY_CAP = 500;
function clampCaption(str = "", limit = BIZZY_CAP) {
  if (!str) return "";
  if (str.length <= limit) return str;
  const slice = str.slice(0, limit);
  const lastSentence = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (lastSentence >= limit - 80) return slice.slice(0, lastSentence + 1).trim() + " …";
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 0) return slice.slice(0, lastSpace).trim() + " …";
  return slice.trim() + " …";
}

/* --------------- Config ---------------- */
const POST_TYPES = ["Tip", "Promo", "Testimonial", "Before/After", "Seasonal Offer"];
const PLATFORMS  = ["Instagram", "Facebook", "LinkedIn"];
const TONES      = ["Friendly", "Professional", "Bold", "Educational", "Witty"];
const CTA_PRESETS = ["Book Now", "Get a Free Estimate", "Call Today", "Send a DM", "Learn More"];
const PLATFORM_LIMITS = {
  instagram: { chars: 2200,  hashtagsMax: 30 },
  facebook:  { chars: 63206, hashtagsMax: 50 },
  linkedin:  { chars: 3000,  hashtagsMax: 10 },
};
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const INPUT_BASE =
  "w-full rounded-xl bg-white/[0.06] ring-1 ring-white/12 border border-white/5 " +
  "px-3 py-2 text-sm text-white placeholder:text-white/40 outline-none transition " +
  "focus:ring-2 focus:ring-[#d7e0ff]/40 focus:border-[#d7e0ff]/40";

const SELECT_BASE =
  "appearance-none w-full rounded-xl px-3 py-2 text-sm text-white " +
  "bg-gradient-to-r from-white/[0.08] to-white/[0.03] border border-white/10 ring-1 ring-inset ring-white/15 " +
  "outline-none transition focus:ring-2 focus:ring-[#d7e0ff]/50 focus:border-[#d7e0ff]/40";

const GENERATED_TEXTAREA =
  "generated-caption-field w-full min-h-[160px] rounded-2xl bg-black/35 ring-1 ring-white/15 border border-white/5 " +
  "px-4 py-3 text-sm text-white placeholder:text-white/40 resize-vertical focus:ring-2 focus:ring-white/40 focus:bg-black/45";

export default function SocialCaptionGenerator({ businessId, fullWidth = false }) {
  const user = useUser();

  // Inputs
  const [businessProfile, setBusinessProfile] = useState(null);
  const [postType, setPostType] = useState("");
  const [platform, setPlatform] = useState("");
  const [tone, setTone] = useState("Friendly");
  const [includeEmojis, setIncludeEmojis] = useState(true);
  const [includeHashtags, setIncludeHashtags] = useState(true);
  const [customNotes, setCustomNotes] = useState("");
  const [targetAudience, setTargetAudience] = useState("");

  // Output
  const [caption, setCaption] = useState("");
  const [category, setCategory] = useState("");
  const [cta, setCTA] = useState("");
  const [imageIdea, setImageIdea] = useState("");
  const [hashtags, setHashtags] = useState([]);
  const [variations, setVariations] = useState([]);
  const [activeVar, setActiveVar] = useState(0);

  // UI
  const [loading, setLoading] = useState(false);
  const [isMock, setIsMock] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [savingDraft, setSavingDraft] = useState(false);
  const [savedDraftId, setSavedDraftId] = useState(null);
  const [galleryHover, setGalleryHover] = useState(false);

  // ⬇️ Neutralized input style (no bright blues)
  const inputBase = INPUT_BASE;

  useEffect(() => { if (postType && platform && errMsg) setErrMsg(""); }, [postType, platform]);

  useEffect(() => {
    async function fetchProfile() {
      if (!user) return;
      const { data } = await supabase.from("marketing_profile").select("*").eq("user_id", user.id).maybeSingle();
      if (data) setBusinessProfile(data);
    }
    fetchProfile();
  }, [user]);

  // Limits & meter
  const normalizedPlatform = (platform || "").toLowerCase();
  const platformLimits = PLATFORM_LIMITS[normalizedPlatform] || PLATFORM_LIMITS.instagram;
  const hardLimit = Math.min(platformLimits.chars, BIZZY_CAP);
  const charCount = caption.length;
  const charPct = Math.max(0, Math.min(100, (charCount / hardLimit) * 100));
  const canSave = !!caption && !!postType && !!platform && !!user;

  // Prompt notes
  const composedNotes = useMemo(() => {
    const parts = [];
    if (targetAudience) parts.push(`Target audience: ${targetAudience}`);
    if (tone) parts.push(`Tone: ${tone}`);
    parts.push(`Hard character cap: ${BIZZY_CAP}`);
    parts.push(`Include emojis: ${includeEmojis ? "yes" : "no"}`);
    parts.push(`Include hashtags: ${includeHashtags ? "yes" : "no"}`);
    if (customNotes) parts.push(customNotes);
    if (businessProfile?.services?.length) parts.push(`Services offered: ${businessProfile.services.join(", ")}`);
    return parts.join(" | ");
  }, [targetAudience, tone, includeEmojis, includeHashtags, customNotes, businessProfile]);

  async function handleGenerate({ variationsCount = 1 } = {}) {
    if (!postType || !platform) { setErrMsg("Choose a Post Type and Platform first."); return; }
    setErrMsg(""); setLoading(true); setStatusMessage("Generating…");

    try {
      const safeProfile = businessProfile ?? {
        business_type: "Home Services",
        location: "",
        target_audience: targetAudience || "",
        services: [],
      };

      async function genOnce() {
        const response = await safeFetch("/api/marketing/captions/generate", {
          method: "POST",
          body: { businessProfile: safeProfile, postType, notes: composedNotes, platform: normalizedPlatform },
        });
        const data = response?.data ?? response;
        const meta = response?.meta || null;
        return {
          caption: data.caption || "",
          category: data.category || postType,
          cta: data.cta || "",
          imageIdea: data.imageIdea || "",
          hashtags: Array.isArray(data.hashtags) ? data.hashtags : [],
          meta: meta || null,
        };
      }

      const generated = [];
      for (let i = 0; i < variationsCount; i++) {
         
        generated.push(await genOnce());
      }

      const normalized = generated.map(r => ({ ...r, caption: clampCaption(r.caption, hardLimit) }));
      const first = normalized[0];

      setCaption(first.caption);
      setCategory(first.category);
      setCTA(first.cta);
      setImageIdea(first.imageIdea);
      setHashtags(first.hashtags);
      setIsMock(Boolean(first.meta?.is_mock));
      setVariations(normalized);
      setActiveVar(0);
      setStatusMessage(variationsCount > 1 ? `Generated ${variationsCount} variations!` : "Generated!");

      requestAnimationFrame(() => {
        document.getElementById("caption-output")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (e) {
      setErrMsg(e?.message || "Failed to generate caption.");
    } finally {
      setLoading(false);
    }
  }

  function applyVariation(idx) {
    const v = variations[idx];
    if (!v) return;
    setCaption(v.caption);
    setCategory(v.category);
    setCTA(v.cta);
    setImageIdea(v.imageIdea);
    setHashtags(v.hashtags);
    setActiveVar(idx);
  }

  async function handleSave() {
    if (!canSave || savingDraft) return;
    setSavingDraft(true);
    setStatusMessage("Saving…");

    const toSave = clampCaption(caption, hardLimit);
    const { data, error } = await savePostToGallery({
      userId: user.id,
      businessId,
      caption: toSave,
      category: postType || category,
      cta,
      imageIdea,
      platform: normalizedPlatform,
      metrics: {},
    });

    setSavingDraft(false);
    if (error) {
      setStatusMessage("Error saving post.");
      window.dispatchEvent(new CustomEvent("bizzy:toast", {
        detail: { title: "Save failed", body: error.message || "Please try again.", severity: "error" }
      }));
      return;
    }
    setSavedDraftId(data?.id || null);
    setStatusMessage("Saved to gallery!");
    window.dispatchEvent(new CustomEvent("bizzy:toast", {
      detail: { title: "Saved", body: "Draft stored in Post Gallery.", severity: "success" }
    }));
  }

  function addHashtag(tag) {
    if (!includeHashtags) return;
    const already = new RegExp(`(^|\\s)#${tag}(\\s|$)`, "i").test(caption);
    const next = caption.trim() + (already ? "" : ` #${tag}`);
    setCaption(clampCaption(next.trim(), hardLimit));
  }
  function copyCaption() {
    navigator.clipboard.writeText(caption);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className={`w-full ${fullWidth ? "max-w-none" : "max-w-3xl mx-auto"} rounded-2xl bg-transparent text-white`}>
      {isMock && <SampleDataRibbon text="Sample output" />}

      <div className="px-4 sm:px-6 py-5 space-y-6">
        <header>
          <CardHeader
            title="SOCIAL MEDIA CAPTION GENERATOR"
            size="sm"
            dense
            className="mb-2"
            titleClassName="text-[13px] tracking-[0.3em]"
          />
          <p className="text-[12px] text-white/65 max-w-2xl">
            Choose a post type and platform, feed Bizzi any notes, and I’ll ship captions, CTA recs, and hashtag sets you can drop straight into your calendar.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            {[
              { label: "Tone", value: tone },
              { label: "Emojis", value: includeEmojis ? "Enabled" : "Muted" },
              { label: "Hashtags", value: includeHashtags ? "Enabled" : "Hidden" },
              { label: "Platform", value: platform ? toTitleCasePlatform(platform) : "Select" },
            ].map((chip) => (
              <span
                key={chip.label}
                className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-white/70"
              >
                <span className="text-white/50 uppercase tracking-widest text-[9px]">{chip.label}</span>
                <span className="text-[11px] text-white">{chip.value}</span>
              </span>
            ))}
          </div>
        </header>

        {errMsg && (
          <div>
            <Banner variant="error" title="Can’t generate right now">
              {errMsg}
            </Banner>
          </div>
        )}

        <div className="space-y-6">
          <SectionCard title="Creative Controls" description="Dial in the creative brief Bizzi uses as a blueprint.">
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Post Type">
                  <ChromeSelect
                    value={postType}
                    onChange={(e) => setPostType(e.target.value)}
                    options={POST_TYPES}
                    placeholder="Select"
                  />
                </Field>
                <Field label="Platform">
                  <ChromeSelect
                    value={platform}
                    onChange={(e) => setPlatform(e.target.value)}
                    options={PLATFORMS}
                    placeholder="Select"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Field label="Tone">
                  <ChromeSelect value={tone} onChange={(e) => setTone(e.target.value)} options={TONES} />
                </Field>
                <Field label="Emojis">
                  <Toggle checked={includeEmojis} onChange={setIncludeEmojis} />
                </Field>
                <Field label="Hashtags">
                  <Toggle checked={includeHashtags} onChange={setIncludeHashtags} />
                </Field>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Target Audience (optional)">
                  <input
                    className={inputBase}
                    value={targetAudience}
                    onChange={(e) => setTargetAudience(e.target.value)}
                    placeholder="e.g., homeowners in Charlotte"
                  />
                </Field>
                <Field label="CTA Preset (optional)">
                  <ChromeSelect
                    value={cta}
                    onChange={(e) => setCTA(e.target.value)}
                    options={CTA_PRESETS}
                    placeholder="Choose a preset"
                  />
                </Field>
              </div>

              <Field label="Custom Notes">
                <textarea
                  rows={2}
                  className={inputBase}
                  value={customNotes}
                  onChange={(e) => setCustomNotes(e.target.value)}
                  placeholder="Details to include: offer, location, job type, testimonial snippet, etc."
                />
              </Field>

              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  onClick={() => handleGenerate({ variationsCount: 1 })}
                  className="flex-1 py-2 rounded-xl bg-gradient-to-r from-white/25 via-white/15 to-white/5 ring-1 ring-white/15 text-sm font-semibold flex items-center justify-center gap-2 transition disabled:opacity-60"
                  disabled={loading}
                >
                  {loading ? <Loader2 className="animate-spin" size={16} /> : <Wand2 size={16} />}
                  {loading ? "Generating…" : "Generate caption"}
                </button>
                <button
                  onClick={() => handleGenerate({ variationsCount: 3 })}
                  className="px-4 py-2 rounded-xl ring-1 ring-white/15 text-sm text-white/80 hover:text-white transition disabled:opacity-60"
                  disabled={loading}
                >
                  Need 3 variations?
                </button>
              </div>

              {statusMessage && <p className="text-[12px] text-white/70">{statusMessage}</p>}
            </div>
          </SectionCard>
        </div>

        <SectionCard
          title="Generated story"
          description="Refine, copy, and save. Hashtags and image cues stay synced to the selected platform."
        >
          {!caption && (
            <div className="text-sm text-white/60">
              Fill in the controls above and click Generate to preview Bizzi’s copy.
            </div>
          )}

          {!!caption && (
            <>
              {variations.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5 mb-3">
                  {variations.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => applyVariation(i)}
                      className={`px-2.5 py-0.5 rounded-full text-[11px] ring-1 ring-inset ${
                        activeVar === i ? "ring-white/60 bg-white/15" : "ring-white/15 hover:ring-white/30"
                      }`}
                    >
                      V{i + 1}
                    </button>
                  ))}
                </div>
              )}

              <div id="caption-output" className="grid grid-cols-1 lg:grid-cols-5 gap-5 items-start">
                <div className="lg:col-span-3 space-y-4">
                  <Field label="Generated caption">
                    <textarea
                      rows={5}
                      className={GENERATED_TEXTAREA}
                      value={caption}
                      onChange={(e) => setCaption(clampCaption(e.target.value, hardLimit))}
                    />
                  </Field>

                  <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
                    <CharacterMeter
                      hardLimit={hardLimit}
                      platformLimit={platformLimits}
                      count={charCount}
                      pct={charPct}
                      platformKey={normalizedPlatform}
                    />
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-white/4 p-3 space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={copyCaption}
                        className="px-3 py-1.5 rounded-xl ring-1 ring-white/15 hover:ring-white/30 text-[13px] flex items-center gap-2"
                      >
                        {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
                      </button>
                      <div
                        className="relative"
                        onMouseEnter={() => setGalleryHover(true)}
                        onMouseLeave={() => setGalleryHover(false)}
                      >
                        <button
                          onClick={handleSave}
                          disabled={!canSave || savingDraft}
                          className={`px-3 py-1.5 rounded-xl text-[13px] font-semibold flex items-center gap-2 transition ${
                            (!canSave || savingDraft)
                              ? "bg-emerald-900/30 cursor-not-allowed"
                              : "bg-emerald-500/80 hover:bg-emerald-500"
                          }`}
                        >
                          {savingDraft ? "Saving…" : "Save to gallery"}
                        </button>
                        <p
                          className={`text-[11px] text-white/65 mt-1 text-center transition-all duration-200 ${
                            galleryHover ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1"
                          }`}
                        >
                          Gallery coming soon!
                        </p>
                      </div>
                      {savedDraftId && (
                        <a
                          href="/dashboard/marketing/gallery"
                          className="px-3 py-1.5 rounded-xl ring-1 ring-white/15 hover:ring-white/30 text-[13px]"
                        >
                          Open gallery
                        </a>
                      )}
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-2 space-y-3">
                  {includeHashtags && !!hashtags?.length && (
                    <Field label={`Suggested hashtags (${hashtags.length})`}>
                      <div className="flex flex-wrap gap-1.5">
                        {hashtags.slice(0, platformLimits.hashtagsMax).map((h) => (
                          <button
                            key={h}
                            onClick={() => addHashtag(h)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-white/10 ring-1 ring-inset ring-white/15 hover:ring-white/30 transition"
                          >
                            <Hash size={12} /> #{h}
                          </button>
                        ))}
                      </div>
                    </Field>
                  )}

                  {imageIdea && (
                    <Field label="Image idea">
                      <div className="text-[13px] text-white/80 flex items-start gap-2">
                        <ImageIcon size={14} className="mt-0.5" />
                        <span>{imageIdea}</span>
                      </div>
                    </Field>
                  )}

                  <Field label={`${toTitleCasePlatform(platform)} preview`}>
                    <div className="rounded-2xl bg-black/30 ring-1 ring-white/15 p-3 text-[13px] leading-relaxed whitespace-pre-wrap min-h-[120px]">
                      {caption}
                    </div>
                  </Field>
                </div>
              </div>
            </>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

/* ---------- UI bits (compact) ---------- */
function SectionCard({ title, description, children, className = "" }) {
  return (
    <div
      className={`rounded-[26px] border border-white/10 bg-gradient-to-b from-white/6 via-white/3 to-transparent p-5 shadow-[0_30px_80px_rgba(0,0,0,0.45)] ${className}`}
    >
      <div className="mb-4">
        <h3 className="text-sm font-semibold tracking-[0.25em] text-white/70 uppercase">{title}</h3>
        {description && <p className="mt-1 text-xs text-white/60">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[12px] text-white/65 mb-0.5">{label}</div>
      {children}
    </label>
  );
}

function CharacterMeter({ hardLimit, platformLimit, count, pct, platformKey }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-white/60">
        <span>
          Limit: {hardLimit.toLocaleString()} (Bizzi cap)
          {` · Platform allows ${platformLimit.chars.toLocaleString()}`}
          {platformKey === "instagram" && ` · ${platformLimit.hashtagsMax} hashtags`}
        </span>
        <span className={count > hardLimit ? "text-rose-300" : "text-white"}>
          {count.toLocaleString()} / {hardLimit.toLocaleString()}
        </span>
      </div>
      <div className="mt-1 h-1 w-full bg-white/10 rounded">
        <div
          className={`h-1 rounded ${count > hardLimit ? "bg-rose-500" : "bg-white/80"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}


function ChromeSelect({ value, onChange, options = [], placeholder = "Select", className = "" }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (!open) return;
      if (triggerRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function handleKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const label = value || placeholder;

  const emitChange = (next) => {
    const syntheticEvent = { target: { value: next } };
    onChange?.(syntheticEvent);
    setOpen(false);
  };

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        className={`${SELECT_BASE} pr-10 flex items-center justify-between text-left`}
        aria-haspopup="listbox"
        aria-expanded={open ? "true" : "false"}
      >
        <span className={value ? "text-white" : "text-white/55"}>{label}</span>
        <ChevronDown className={`h-4 w-4 text-white/70 transition-transform ${open ? "-scale-y-100" : ""}`} />
      </button>

      <div
        ref={menuRef}
        className={`absolute left-0 right-0 mt-1 origin-top rounded-2xl border border-white/12 bg-[#050608]/95 backdrop-blur-xl ring-1 ring-black/40 shadow-[0_25px_60px_rgba(0,0,0,0.55)] overflow-hidden z-30 transition-all duration-200 ${
          open ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none"
        }`}
        role="listbox"
      >
        {options.map((opt) => {
          const active = opt === value;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => emitChange(opt)}
              className={`w-full text-left px-3 py-2 text-sm transition flex items-center justify-between ${
                active ? "bg-white/10 text-white" : "text-white/75 hover:bg-white/5"
              }`}
            >
              <span>{opt}</span>
              {active && <span className="text-white/70 text-xs">Selected</span>}
            </button>
          );
        })}
        {!options.length && (
          <div className="px-3 py-2 text-sm text-white/40">No options</div>
        )}
      </div>
    </div>
  );
}

// Neutral toggle with emerald accent when on
function Toggle({ checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`w-[52px] h-[28px] rounded-full border transition relative ring-1 ring-inset ${
        checked
          ? "bg-emerald-500/25 border-emerald-400/40"
          : "bg-white/10 border-white/15"
      }`}
      aria-pressed={checked}
    >
      <span
        className={`absolute top-1 left-1 w-[24px] h-[24px] rounded-full bg-white transition-transform ${
          checked ? "translate-x-[24px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}
