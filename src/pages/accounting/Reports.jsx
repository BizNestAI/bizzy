// /src/pages/Accounting/Reports.jsx
import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBusiness } from '../../context/BusinessContext';
import PNLArchiveViewer from '../../components/accounting/PNLArchiveViewer';
import AgendaWidget from '../Calendar/AgendaWidget.jsx';
import { useRightExtras } from '../../insights/RightExtrasContext';
import LiveModePlaceholder from '../../components/common/LiveModePlaceholder.jsx';
import { shouldUseDemoData } from '../../services/demo/demoClient.js';
import useIntegrationManager from '../../hooks/useIntegrationManager.js';

export default function Reports() {
  const { currentBusiness } = useBusiness();
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId");
  const { setRightExtras } = useRightExtras();
  const navigate = useNavigate();
  const usingDemo = shouldUseDemoData(currentBusiness);
  const integrationManager = useIntegrationManager({ businessId });
  const qbStatus = integrationManager?.getStatus?.("quickbooks")?.status || "disconnected";
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

  if (!canView) {
    return <LiveModePlaceholder title="Connect QuickBooks to view archived reports" />;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white px-4 py-6">
      <PNLArchiveViewer />
    </div>
  );
}
