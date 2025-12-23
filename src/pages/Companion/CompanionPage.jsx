// src/pages/companion/CompanionPage.jsx
import React, { useEffect } from "react";
import BizzyCompanion from "../../components/Bizzy/BizzyCompanion";
import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../Calendar/AgendaWidget.jsx";
import { useNavigate } from "react-router-dom";

export default function CompanionPage() {
  // Optional: publish Agenda into the right rail for consistency
  const { setRightExtras } = useRightExtras();
  const navigate = useNavigate();
  const businessId =
    localStorage.getItem("currentBusinessId") ||
    localStorage.getItem("business_id") ||
    "";

  useEffect(() => {
    setRightExtras(
      <AgendaWidget
        businessId={businessId}
        module="bizzy"
        onOpenCalendar={() => navigate("/dashboard/calendar")}
      />
    );
    return () => setRightExtras(null);
  }, [businessId, navigate, setRightExtras]);

  return (
    /**
     * Keep this root NON-scrolling (DashboardLayout owns scroll).
     * Use graphite tokens + consistent horizontal padding.
     */
    <div className="w-full px-3 md:px-4 pt-0 pb-24 bg-app text-primary">
      <div className="max-w-[1200px] mx-auto">
        <BizzyCompanion />
      </div>
    </div>
  );
}
