// /src/pages/Accounting/Reports.jsx
import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBusiness } from '../../context/BusinessContext';
import PNLArchiveViewer from '../../components/Accounting/PNLArchiveViewer';
import AgendaWidget from '../Calendar/AgendaWidget.jsx';
import { useRightExtras } from '../../insights/RightExtrasContext';
import LiveModePlaceholder from '../../components/common/LiveModePlaceholder.jsx';
import { shouldUseDemoData } from '../../services/demo/demoClient.js';
import useIntegrationManager from '../../hooks/useIntegrationManager.js';
import { useAdminView } from '../../context/AdminViewContext.jsx';

export default function Reports() {
  const { currentBusiness } = useBusiness();
  const adminView = useAdminView();
  const businessId = adminView.active ? adminView.businessId : (currentBusiness?.id || localStorage.getItem("currentBusinessId"));
  const { setRightExtras } = useRightExtras();
  const navigate = useNavigate();
  const usingDemo = shouldUseDemoData(currentBusiness);
  const integrationManager = useIntegrationManager({ businessId });
  const qbStatus = integrationManager?.getStatus?.("quickbooks")?.status || (adminView.active ? "loading" : "disconnected");
  const qbStatusLoading = adminView.active && ["loading", "connecting"].includes(qbStatus);
  const canView = usingDemo || qbStatus === "connected";

  useEffect(() => {
    if (!businessId) return;
    const el = (
      <AgendaWidget
        businessId={businessId}
        module="financials"
        onOpenCalendar={() => navigate('/dashboard/calendar')}
      />
    );
    setRightExtras(el);
    return () => setRightExtras(null);
  }, [businessId, navigate, setRightExtras]);

  if (qbStatusLoading) {
    return (
      <div className="min-h-screen text-white px-3 md:px-4 pt-0 pb-8 bg-transparent">
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-sm text-white/55">
          Loading persisted report archive...
        </div>
      </div>
    );
  }

  if (!canView) {
    return <LiveModePlaceholder title="Connect QuickBooks to view archived reports" />;
  }

  return (
    <div className="min-h-screen text-white px-3 md:px-4 pt-0 pb-8 bg-transparent">
      <PNLArchiveViewer />
    </div>
  );
}
