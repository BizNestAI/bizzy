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
    <div className="w-full pt-0 pb-24 bg-app text-primary">
      <div className="bizzy-page-width bizzy-page-width--workspace">
        <BizzyCompanion />
      </div>
    </div>
  );
}
