// src/layout/NavRailBusinessBadge.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "../services/supabaseClient";
import { useBusiness } from "../context/BusinessContext";
import { ACCENT_HEX, ACCENT_SOFT } from "../config/accent";

function hexToRgba(hex, alpha = 1) {
  let c = (hex || "").replace("#", "");
  if (c.length === 3) c = c.split("").map((s) => s + s).join("");
  const n = parseInt(c || "000000", 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function initialsFromName(name = "") {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) {
    const w = words[0];
    const first = w[0] || "";
    const second = w[1] || w[w.length - 1] || "";
    return (first + second).toUpperCase();
  }
  const first = words[0][0] || "";
  const second = words[1][0] || words[words.length - 1][0] || "";
  return (first + second).toUpperCase();
}

export default function NavRailBusinessBadge() {
  const { currentBusiness } = useBusiness?.() || {};
  const businessId = useMemo(
    () =>
      currentBusiness?.id ||
      localStorage.getItem("currentBusinessId") ||
      localStorage.getItem("business_id") ||
      null,
    [currentBusiness?.id]
  );

  const [profile, setProfile] = useState({
    business_name: currentBusiness?.business_name || "",
    industry: currentBusiness?.industry || "",
    state: currentBusiness?.state || "",
    team_size: currentBusiness?.team_size || "",
    owner_name: currentBusiness?.owner_name || "",
    owner_role: currentBusiness?.owner_role || "",
    founded_year: currentBusiness?.founded_year || "",
  });

  useEffect(() => {
    if (!currentBusiness) return;
    setProfile((prev) => ({
      ...prev,
      business_name: currentBusiness.business_name || prev.business_name,
      industry: currentBusiness.industry || prev.industry,
      state: currentBusiness.state || prev.state,
      team_size: currentBusiness.team_size || prev.team_size,
      owner_name: currentBusiness.owner_name || prev.owner_name,
      owner_role: currentBusiness.owner_role || prev.owner_role,
      founded_year: currentBusiness.founded_year || prev.founded_year,
    }));
  }, [
    currentBusiness?.business_name,
    currentBusiness?.industry,
    currentBusiness?.state,
    currentBusiness?.team_size,
    currentBusiness?.owner_name,
    currentBusiness?.owner_role,
    currentBusiness?.founded_year,
  ]);

  useEffect(() => {
    let cancelled = false;
    const needsFetch =
      !!businessId &&
      (!profile.business_name || !profile.owner_name || !profile.founded_year);
    if (!needsFetch) return;
    (async () => {
      const { data, error } = await supabase
        .from("business_profiles")
        .select("id,business_name,industry,state,team_size,owner_name,owner_role,founded_year")
        .eq("id", businessId)
        .single();
      if (cancelled) return;
      if (!error && data) {
        setProfile((prev) => ({
          ...prev,
          business_name: data.business_name || prev.business_name,
          industry: data.industry || "",
          state: data.state || "",
          team_size: data.team_size || "",
          owner_name: data.owner_name || "",
          owner_role: data.owner_role || "",
          founded_year: data.founded_year || "",
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, profile.business_name]);

  const initials = initialsFromName(profile.business_name);
  const label = profile.business_name || "Business";
  const baseAccent = useMemo(() => ACCENT_HEX, []);
  const accentSoft = useMemo(() => ACCENT_SOFT, []);
  const chips = [
    profile.industry && { label: profile.industry },
    profile.state && { label: profile.state },
  ].filter(Boolean);

  const [open, setOpen] = useState(false);
  const openTooltip = useCallback(() => setOpen(true), []);
  const closeTooltip = useCallback(() => setOpen(false), []);
  const badgeRef = React.useRef(null);
  const tooltipRef = React.useRef(null);
  const [tooltipPos, setTooltipPos] = useState(null);

  const updateTooltipPos = useCallback(() => {
    if (!badgeRef.current) return;
    const rect = badgeRef.current.getBoundingClientRect();
    const tooltipH = tooltipRef.current?.offsetHeight || 260; // fallback for first paint
    const viewportH = window.innerHeight || 800;
    const margin = 16;
    const desiredTop = rect.top + 4; // slightly lower
    const clampTop = Math.max(margin, Math.min(desiredTop, viewportH - margin - tooltipH));
    const maxHeight = Math.max(120, viewportH - margin * 2);
    setTooltipPos({
      position: "fixed",
      left: rect.right + 28, // match chat history offset from rail
      top: clampTop,
      maxHeight,
      transform: "none",
      zIndex: 20,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateTooltipPos();
    const onResize = () => updateTooltipPos();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open, updateTooltipPos]);

  // Keep a stable top across re-enters if already measured
  useEffect(() => {
    if (!open || !tooltipRef.current || !tooltipPos) return;
    const measuredTop = tooltipPos.top;
    setTooltipPos((prev) => {
      if (!prev) return prev;
      return { ...prev, top: measuredTop };
    });
  }, [open]);

  return (
    <div className="relative bizzy-business-badge" style={{ pointerEvents: "auto" }}>
      <button
        type="button"
        ref={badgeRef}
        onClick={() => console.log("Business switcher coming soon")}
        className="w-8 h-8 rounded-full backdrop-blur-sm text-[11px] font-semibold tracking-wide flex items-center justify-center transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/30"
        title={label}
        aria-label={label}
        style={{
          backgroundColor: "var(--input-bg)",
          border: `1px solid ${hexToRgba(baseAccent, 0.55)}`,
          boxShadow: `0 0 0 1px ${hexToRgba(baseAccent, 0.22)}, 0 0 10px ${accentSoft}`,
        }}
        onMouseEnter={openTooltip}
        onMouseLeave={closeTooltip}
        onFocus={openTooltip}
        onBlur={closeTooltip}
      >
        {initials}
      </button>
      <div
        role="tooltip"
        className="absolute left-full bottom-0 ml-3 transition bizzy-business-badge-tooltip"
        ref={tooltipRef}
        style={{
          transform: tooltipPos?.transform || "translateY(-8px) translateX(-6px)",
          zIndex: tooltipPos?.zIndex || 20,
          maxHeight: tooltipPos?.maxHeight || "70vh",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          left: tooltipPos?.left,
          top: tooltipPos?.top,
          position: tooltipPos?.position || "absolute",
        }}
      >
        <div
          className="min-w-[240px] max-w-[280px] rounded-2xl border backdrop-blur-lg shadow-[0_14px_38px_rgba(0,0,0,0.50)] px-3.5 py-3 pointer-events-auto space-y-2.5"
          style={{
            backgroundColor: "var(--surface-graphite)",
            borderColor: "var(--surface-border)",
          }}
        >
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-white truncate">{label}</div>
            </div>
          </div>

          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip, idx) => (
                <span
                  key={`${chip.label}-${idx}`}
                  className="text-[10px] px-2.5 py-[4px] rounded-full bg-white/8 border border-white/12 text-white/80 truncate"
                >
                  {chip.label}
                </span>
              ))}
              {profile.team_size ? (
                <span className="text-[10px] px-2.5 py-[4px] rounded-full bg-white/8 border border-white/12 text-white/80 truncate">
                  Team: {profile.team_size}
                </span>
              ) : null}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 text-[11px] text-white/75">
            <div className="flex flex-col gap-1">
              <span className="text-white/45 text-[10px] uppercase tracking-[0.04em]">Owner</span>
              <span className="truncate">
                {profile.owner_name || "—"}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-white/45 text-[10px] uppercase tracking-[0.04em]">Founded</span>
              <span className="truncate">{profile.founded_year || "—"}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
