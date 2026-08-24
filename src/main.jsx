// /src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
import "./styles/prose-bizzy.css";

import Login from "./pages/UserAdmin/Login";
import Signup from "./pages/UserAdmin/Signup";
import EmailConfirmation from "./pages/UserAdmin/EmailConfirmation";
import ResetPassword from "./pages/UserAdmin/ResetPassword";
import BusinessWizard from "./pages/UserAdmin/BusinessWizard";
import SettingsHome from "./pages/Settings/SettingsHome";

import AccountingDashboard from "./pages/accounting/AccountingDashboard";
import MarketingDashboard from "./pages/Marketing/MarketingDashboard";
import TaxDashboard from "./pages/Tax/TaxDashboard";
import TaxCalculationWorkpaper from "./pages/Tax/TaxCalculationWorkpaper.jsx";
import BizzyPanel from "./pages/Bizzy/BizzyPanel";
import ChatHome from "./pages/Bizzy/ChatHome.jsx";

import Forecasts from "./pages/accounting/Forecasts";
import Reports from "./pages/accounting/Reports";
import BookkeepingCleanup from "./pages/accounting/BookkeepingCleanup.jsx";
import ReconciledTransactions from "./pages/accounting/ReconciledTransactions.jsx";
import Reconciliations from "./pages/accounting/Reconciliations.jsx";
import AccountingRules from "./pages/accounting/Rules.jsx";

import ProtectedRoute from "./components/UserAdmin/ProtectedRoute";
import { AuthProvider } from "./context/AuthContext";
import { BusinessProvider, useBusiness } from "./context/BusinessContext";
import { AdminViewProvider, useAdminView } from "./context/AdminViewContext.jsx";
import { BizzyChatProvider } from "./context/BizzyChatContext";
import { PeriodProvider } from "./context/PeriodContext";

import { InsightsUnreadProvider } from "./insights/InsightsUnreadContext"; // ⬅️ NEW

import FullDashboardLayout from "./layout/FullDashboardLayout";
import "./index.css";
import { installTabVisibilityMotionGuard } from "./utils/tabVisibilityMotionGuard";

import CalendarHub from "./pages/Calendar/CalendarHub.jsx";
import EmailPage from "./pages/Email/EmailPage.jsx";
import ActivityHub from "./pages/Activity/ActivityHub.jsx";

import DocsLibraryPage from "./pages/Docs/DocsLibraryPage.jsx";
import DocDetail from "./pages/Docs/DocDetail.jsx";

import ReviewsPage from "./pages/Marketing/ReviewsPage.jsx";
import SocialCaptionPage from "./pages/Marketing/SocialCaptionPage.jsx";
import CompanionPage from "./pages/Companion/CompanionPage.jsx";
import JobsDashboard from "./pages/LeadsJobs/JobsDashboard.jsx";
import MonthlyReviewConsole from "./pages/Admin/MonthlyReviewConsole.jsx";
import AdminLogin from "./pages/Admin/AdminLogin.jsx";
import AdminViewRedeem from "./pages/AdminView/AdminViewRedeem.jsx";
import AdminProtectedRoute from "./components/Admin/AdminProtectedRoute.jsx";
import { getAdminRoutePath, getCurrentApplicationSurface } from "./utils/applicationSurface.js";

const AffordabilityPage = React.lazy(() => import("./pages/accounting/Affordability.jsx"));
const ScenariosPage = React.lazy(() => import("./pages/accounting/Scenarios.jsx"));

installTabVisibilityMotionGuard();

/* -------------------------- Helpers / Wrappers -------------------------- */
function WithUnreadProvider({ children }) {
  const { currentBusiness } = useBusiness?.() || {};
  const adminView = useAdminView();
  const businessId =
    (adminView.active ? adminView.businessId : null) ||
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
  const adminView = useAdminView();
  const businessId = (adminView.active ? adminView.businessId : null) || currentBusiness?.id || localStorage.getItem("currentBusinessId") || "";
  return <ReviewsPage businessId={businessId} />;
}

function DocsPageWrapper() {
  const { currentBusiness } = useBusiness();
  const adminView = useAdminView();
  const businessId = (adminView.active ? adminView.businessId : null) || currentBusiness?.id || localStorage.getItem("currentBusinessId") || "";
  return <DocsLibraryPage businessId={businessId} />;
}

function DocDetailWrapper() {
  const { currentBusiness } = useBusiness();
  const adminView = useAdminView();
  const businessId = (adminView.active ? adminView.businessId : null) || currentBusiness?.id || localStorage.getItem("currentBusinessId") || "";
  return <DocDetail businessId={businessId} />;
}

function ChatRedirect() {
  const location = useLocation();
  const search = location?.search || "";
  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.log("[Router] redirecting /chat -> /dashboard/bizzi/chat", search);
  }
  return <Navigate to={`/dashboard/bizzi/chat${search}`} replace />;
}

function CustomerRouteFallback() {
  const adminView = useAdminView();
  if (adminView.active) {
    return (
      <div className="min-h-screen bg-[#050606] px-6 py-10 text-white">
        <div className="mx-auto mt-[12vh] max-w-lg rounded-[18px] border border-white/12 bg-[#111312] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.48)]">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-200/80">Admin View</p>
          <h1 className="mt-3 text-2xl font-semibold">Section unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-white/62">
            This section is unavailable in read-only Admin View.
          </p>
        </div>
      </div>
    );
  }
  return <Navigate to={applicationSurface === "admin" ? "/" : "/dashboard/bizzi/chat"} replace />;
}

function RootRedirect() {
  const location = useLocation();
  const search = location?.search || "";
  const hash = location?.hash || "";
  const params = new URLSearchParams(search || "");
  const hashParams = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const hasAuthConfirmationParams =
    params.has("code") ||
    params.has("token_hash") ||
    params.has("error") ||
    params.has("error_code") ||
    hashParams.has("access_token") ||
    hashParams.has("refresh_token") ||
    hashParams.has("token_hash") ||
    hashParams.has("error") ||
    hashParams.has("error_code");

  if (hasAuthConfirmationParams) {
    return <Navigate to={`/auth/confirm${search}${hash}`} replace />;
  }

  return <Navigate to="/dashboard/bizzi/chat" replace />;
}

function AdminRootRedirect() {
  return (
    <AdminProtectedRoute>
      <Navigate to={getAdminRoutePath("monthlyReview", applicationSurface)} replace />
    </AdminProtectedRoute>
  );
}

function LegacyDocRedirect() {
  const { id } = useParams();
  const location = useLocation();
  const search = location?.search || "";
  return <Navigate to={`/dashboard/bizzi-docs/${id || ""}${search}`} replace />;
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

const applicationSurface = getCurrentApplicationSurface();
const renderCustomerRoutes = applicationSurface !== "admin";
const renderAdminRoutes = applicationSurface === "admin" || applicationSurface === "development";
const renderDevelopmentAdminRoutes = applicationSurface === "development";

/* -------------------------- Render -------------------------- */
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <AdminViewProvider>
        <PeriodProvider syncUrl writeUrl autoSnapToCurrentMonth>
          <Routes>
            {renderAdminRoutes && (
              <>
                <Route path={getAdminRoutePath("root", applicationSurface)} element={<AdminRootRedirect />} />
                <Route path={getAdminRoutePath("login", applicationSurface)} element={<AdminLogin />} />
                <Route path="/auth/confirm" element={<EmailConfirmation />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route
                  path={getAdminRoutePath("monthlyReview", applicationSurface)}
                  element={
                    <AdminProtectedRoute>
                      <MonthlyReviewConsole />
                    </AdminProtectedRoute>
                  }
                />
              </>
            )}

            {renderCustomerRoutes && (
              <>
            {/* Public / auth */}
            <Route path="/" element={<RootRedirect />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/auth/confirm" element={<EmailConfirmation />} />
            <Route path="/admin-view/redeem" element={<AdminViewRedeem />} />
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

            {/* Legacy /chat redirect */}
            <Route
              path="/chat"
              element={
                <ProtectedRoute>
                  <ChatRedirect />
                </ProtectedRoute>
              }
            />

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
              <Route index element={<Navigate to="bizzi/chat" replace />} />
              <Route path="bizzi" element={<BizzyPanel />} />
              <Route path="bizzi/chat" element={<ChatHome />} />
              <Route path="bizzy" element={<Navigate to="/dashboard/bizzi" replace />} />
              <Route path="bizzy/chat" element={<Navigate to="/dashboard/bizzi/chat" replace />} />
              <Route path="companion" element={<CompanionPage />} />
              <Route path="leads-jobs" element={<JobsDashboard />} />
              <Route path="leads-jobs/collections" element={<JobsDashboard />} />
              <Route path="leads-jobs/job-costing" element={<JobsDashboard />} />
              <Route path="leads-jobs/bid-builder" element={<JobsDashboard />} />
              <Route path="leads-jobs/bid-builder/:bidId" element={<JobsDashboard />} />
              <Route path="leads-jobs/estimates" element={<JobsDashboard />} />
              <Route path="leads-jobs/change-orders" element={<JobsDashboard />} />
              <Route path="jobs" element={<JobsDashboard />} />
              <Route path="jobs/collections" element={<JobsDashboard />} />
              <Route path="jobs/job-costing" element={<JobsDashboard />} />
              <Route path="jobs/bid-builder" element={<JobsDashboard />} />
              <Route path="jobs/bid-builder/:bidId" element={<JobsDashboard />} />
              <Route path="jobs/estimates" element={<JobsDashboard />} />
              <Route path="jobs/change-orders" element={<JobsDashboard />} />

              {/* Accounting */}
              <Route path="accounting" element={<AccountingDashboard />} />
              <Route path="accounting/bookkeeping" element={<BookkeepingCleanup />} />
              <Route path="accounting/rules" element={<AccountingRules />} />
              <Route path="accounting/reconciled" element={<ReconciledTransactions />} />
              <Route path="accounting/reconciliations" element={<Reconciliations />} />
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
              <Route path="tax/calculation" element={<TaxCalculationWorkpaper />} />
              <Route path="tax/deductions" element={<Navigate to="/dashboard/tax" replace />} />

              {/* Calendar */}
              <Route path="calendar" element={<CalendarHub />} />

              {/* Activity */}
              <Route path="activity" element={<ActivityHub />} />

              {/* Docs */}
              <Route path="bizzi-docs" element={<DocsLibraryPage />} />
              <Route path="bizzi-docs/:id" element={<DocDetailWrapper />} />
              <Route path="bizzy-docs" element={<Navigate to="/dashboard/bizzi-docs" replace />} />
              <Route path="bizzy-docs/:id" element={<LegacyDocRedirect />} />

              {/* Settings */}
              <Route path="settings" element={<SettingsHome />} />

              {/* Internal Admin */}
              {renderDevelopmentAdminRoutes && (
                <Route
                  path="admin/monthly-review"
                  element={
                    <AdminProtectedRoute>
                      <MonthlyReviewConsole />
                    </AdminProtectedRoute>
                  }
                />
              )}
            </Route>
              </>
            )}

            <Route path="*" element={<CustomerRouteFallback />} />
          </Routes>
        </PeriodProvider>
        </AdminViewProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
