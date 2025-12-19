// /src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./styles/prose-bizzy.css";

import Login from "./pages/UserAdmin/Login";
import Signup from "./pages/UserAdmin/Signup";
import ResetPassword from "./pages/UserAdmin/ResetPassword";
import BusinessWizard from "./pages/UserAdmin/BusinessWizard";
import SettingsHome from "./pages/Settings/SettingsHome";

import AccountingDashboard from "./pages/Accounting/AccountingDashboard";
import MarketingDashboard from "./pages/Marketing/MarketingDashboard";
import TaxDashboard from "./pages/Tax/TaxDashboard";
import BizzyPanel from "./pages/Bizzy/BizzyPanel";
import ChatHome from "./pages/Bizzy/ChatHome.jsx";

import Forecasts from "./pages/accounting/Forecasts";
import Reports from "./pages/accounting/Reports";
import BookkeepingCleanup from "./pages/accounting/BookkeepingCleanup.jsx";

import DeductionsPage from "./pages/Tax/DeductionsPage";

import ProtectedRoute from "./components/UserAdmin/ProtectedRoute";
import { AuthProvider } from "./context/AuthContext";
import { BusinessProvider, useBusiness } from "./context/BusinessContext";
import { BizzyChatProvider } from "./context/BizzyChatContext";
import { PeriodProvider } from "./context/PeriodContext";

import { InsightsUnreadProvider } from "./insights/InsightsUnreadContext"; // ⬅️ NEW

import FullDashboardLayout from "./layout/FullDashboardLayout";
import "./index.css";

import CalendarHub from "./pages/calendar/CalendarHub.jsx";
import EmailPage from "./pages/email/EmailPage.jsx";
import ActivityHub from "./pages/Activity/ActivityHub.jsx";

import DocsLibraryPage from "./pages/Docs/DocsLibraryPage.jsx";
import DocDetail from "./pages/Docs/DocDetail.jsx";

import ReviewsPage from "./pages/Marketing/ReviewsPage.jsx";
import SocialCaptionPage from "./pages/Marketing/SocialCaptionPage.jsx";
import CompanionPage from "./pages/companion/CompanionPage.jsx";
import JobsDashboard from "./pages/LeadsJobs/JobsDashboard.jsx";

const AffordabilityPage = React.lazy(() => import("./pages/Accounting/Affordability.jsx"));
const ScenariosPage = React.lazy(() => import("./pages/Accounting/Scenarios.jsx"));

/* -------------------------- Helpers / Wrappers -------------------------- */
function WithUnreadProvider({ children }) {
  const { currentBusiness } = useBusiness?.() || {};
  const businessId =
    currentBusiness?.id ||
    localStorage.getItem("currentBusinessId") ||
    "";

  return (
    <InsightsUnreadProvider businessId={businessId}>
      {children}
    </InsightsUnreadProvider>
  );
}

function ReviewsPageWrapper() {
  const { currentBusiness } = useBusiness();
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId") || "";
  return <ReviewsPage businessId={businessId} />;
}

function DocsPageWrapper() {
  const { currentBusiness } = useBusiness();
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId") || "";
  return <DocsLibraryPage businessId={businessId} />;
}

function DocDetailWrapper() {
  const { currentBusiness } = useBusiness();
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId") || "";
  return <DocDetail businessId={businessId} />;
}

function AffordabilityPageWrapper() {
  const { currentBusiness } = useBusiness();
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId") || "";
  const userId = localStorage.getItem("user_id") || "";
  return (
    <React.Suspense fallback={<div className="p-6 text-white/70">Loading…</div>}>
      <AffordabilityPage businessId={businessId} userId={userId} />
    </React.Suspense>
  );
}

function ScenariosPageWrapper() {
  const { currentBusiness } = useBusiness();
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId") || "";
  const userId = localStorage.getItem("user_id") || "";
  return (
    <React.Suspense fallback={<div className="p-6 text-white/70">Loading…</div>}>
      <ScenariosPage businessId={businessId} userId={userId} />
    </React.Suspense>
  );
}

/* -------------------------- Render -------------------------- */
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PeriodProvider syncUrl writeUrl autoSnapToCurrentMonth>
          <Routes>
            {/* Public / auth */}
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/reset-password" element={<ResetPassword />} />

            {/* Setup wizard (protected) */}
            <Route
              path="/setup"
              element={
                <ProtectedRoute>
                  <BusinessProvider>
                    <BusinessWizard />
                  </BusinessProvider>
                </ProtectedRoute>
              }
            />

            {/* Legacy /dashboard -> /chat */}
            <Route path="/dashboard" element={<Navigate to="/chat" replace />} />

            {/* Chat (protected) */}
            <Route
              path="/chat"
              element={
                <ProtectedRoute>
                  <BusinessProvider>
                    <WithUnreadProvider>
                      <BizzyChatProvider>
                        <FullDashboardLayout />
                      </BizzyChatProvider>
                    </WithUnreadProvider>
                  </BusinessProvider>
                </ProtectedRoute>
              }
            >
              <Route index element={<ChatHome />} />
            </Route>

            {/* Dashboards (protected) */}
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <BusinessProvider>
                    <WithUnreadProvider>
                      <BizzyChatProvider>
                        <FullDashboardLayout />
                      </BizzyChatProvider>
                    </WithUnreadProvider>
                  </BusinessProvider>
                </ProtectedRoute> 
              }
            >
              {/* children render inside <Outlet/> */}
              <Route path="bizzy" element={<BizzyPanel />} />
              <Route path="companion" element={<CompanionPage />} />
              <Route path="leads-jobs" element={<JobsDashboard />} />
              <Route path="jobs" element={<JobsDashboard />} />

              {/* Accounting */}
              <Route path="accounting" element={<AccountingDashboard />} />
              <Route path="accounting/bookkeeping" element={<BookkeepingCleanup />} />
              <Route path="accounting/forecasts" element={<Forecasts />} />
              <Route path="accounting/reports" element={<Reports />} />
              <Route
                path="accounting/affordability"
                element={
                  <React.Suspense fallback={<div className="p-6 text-white/70">Loading…</div>}>
                    <AffordabilityPageWrapper />
                  </React.Suspense>
                }
              />
              <Route
                path="accounting/scenarios"
                element={
                  <React.Suspense fallback={<div className="p-6 text-white/70">Loading…</div>}>
                    <ScenariosPageWrapper />
                  </React.Suspense>
                }
              />

              {/* Marketing */}
              <Route path="marketing" element={<MarketingDashboard />} />
              <Route path="marketing/reviews" element={<ReviewsPageWrapper />} />
              <Route path="marketing/captions" element={<SocialCaptionPage />} />

              {/* Email */}
              <Route path="email" element={<EmailPage />} />

              {/* Tax */}
              <Route path="tax" element={<TaxDashboard />} />
              <Route path="tax/deductions" element={<DeductionsPage />} />

              {/* Calendar */}
              <Route path="calendar" element={<CalendarHub />} />

              {/* Activity */}
              <Route path="activity" element={<ActivityHub />} />

              {/* Docs */}
              <Route path="bizzy-docs" element={<DocsLibraryPage />} />
              <Route path="bizzy-docs/:id" element={<DocDetailWrapper />} />

              {/* Settings */}
              <Route path="settings" element={<SettingsHome />} />
            </Route>
          </Routes>
        </PeriodProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
