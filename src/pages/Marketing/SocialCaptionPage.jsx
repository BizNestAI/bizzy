import React, { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useBusiness } from "../../context/BusinessContext";
import useModuleTheme from "../../hooks/useModuleTheme";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader";
import SocialCaptionGenerator from "../../components/Marketing/SocialCaptionGenerator";
import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../Calendar/AgendaWidget.jsx";
import SyncButton from "../../components/Integrations/SyncButton.jsx";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";

const Card = ({ children, className = "" }) => (
  <div
    className={`relative rounded-[30px] border border-white/10 bg-gradient-to-br from-white/8 via-white/3 to-transparent p-4 sm:p-8 shadow-[0_35px_90px_rgba(0,0,0,0.55)] backdrop-blur-xl ${className}`}
  >
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-[30px] border border-white/5"
      style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)" }}
    />
    <div className="relative z-10">{children}</div>
  </div>
);

const heroGrad =
  "radial-gradient(circle at 15% 20%, rgba(59,130,246,0.25), transparent 55%)," +
  "radial-gradient(circle at 80% 10%, rgba(14,165,233,0.25), transparent 50%)," +
  "rgba(5,6,8,0.85)";

export default function SocialCaptionPage() {
  const { currentBusiness } = useBusiness();
  const navigate = useNavigate();
  const businessId = useMemo(
    () => currentBusiness?.id || localStorage.getItem("currentBusinessId") || "",
    [currentBusiness?.id]
  );
  const theme = useModuleTheme("marketing");
  const bgColor = theme?.bgClass || "bg-app";
  const textColor = theme?.textClass || "text-primary";

  const { setRightExtras } = useRightExtras();
  useEffect(() => {
    if (!businessId) {
      setRightExtras(null);
      return;
    }
    setRightExtras(
      <AgendaWidget
        businessId={businessId}
        module="marketing"
        onOpenCalendar={() => navigate("/dashboard/calendar")}
      />
    );
    return () => setRightExtras(null);
  }, [businessId, setRightExtras, navigate]);

  if (!shouldUseDemoData(currentBusiness)) {
    return <LiveModePlaceholder title="Connect social accounts to generate captions" />;
  }

  return (
    <div className={`w-full px-3 md:px-4 pt-0 pb-6 font-sans ${textColor} ${bgColor}`}>
      <ModuleHeader
        module="marketing"
        title="Caption Studio"
        subtitle="Generate scroll-stopping captions, CTAs, and hashtag sets for your campaigns."
        className="mb-6"
        right={<SyncButton label="Sync Socials" providers={["facebook", "instagram", "linkedin"]} />}
      />

      <div className="mx-auto w-full max-w-[1200px] space-y-6">
        <div
          className="rounded-[32px] border border-white/10 p-5 sm:p-7 relative overflow-hidden shadow-[0_35px_100px_rgba(0,0,0,0.55)]"
          style={{ background: heroGrad }}
        >
          <div
            aria-hidden
            className="absolute inset-0 opacity-20"
            style={{ backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.15) 1px, transparent 1px)", backgroundSize: "120px 120px" }}
          />
          <div className="relative z-10 grid gap-4 lg:grid-cols-[1.3fr_1fr] items-center">
            <div>
              <p className="uppercase tracking-[0.35em] text-xs text-white/65 mb-3">Campaign ready</p>
              <p className="text-sm text-white/75 max-w-xl">
                Feed Bizzi your brief, tones, and CTAs. I’ll craft captions, hashtags, and image prompts calibrated to each platform.
              </p>
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              {[
                { label: "Captions this week", value: "18" },
                { label: "Avg. save rate", value: "87%" },
                { label: "Time saved", value: "6.5 hrs" },
              ].map((stat) => (
                <div key={stat.label} className="rounded-2xl bg-white/10 border border-white/20 p-3 text-center">
                  <div className="text-2xl font-semibold text-white">{stat.value}</div>
                  <div className="text-[11px] uppercase tracking-wide text-white/60">{stat.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <Card className="mt-2">
          <SocialCaptionGenerator businessId={businessId} fullWidth />
        </Card>
      </div>
    </div>
  );
}
