import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Suspense, type ReactNode } from "react";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/contexts/AuthContext";
import AppLayout from "@/components/layout/AppLayout";
import Login from "@/pages/Login";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { lazyWithReload } from "@/lib/lazyWithReload";

// Lazy-load heavy routes so the initial bundle stays small and the CRM feels
// snappy. lazyWithReload recovers from post-deploy stale-chunk errors by
// reloading the page once instead of showing an error screen.
const LeadsPage = lazyWithReload(() => import("@/pages/LeadsPage"));
const LeadDetailPage = lazyWithReload(() => import("@/pages/LeadDetailPage"));
const SchedulePage = lazyWithReload(() => import("@/pages/SchedulePage"));
const Analytics = lazyWithReload(() => import("@/pages/Analytics"));
const AreasPage = lazyWithReload(() => import("@/pages/AreasPage"));
const ActivityLogs = lazyWithReload(() => import("@/pages/ActivityLogs"));
const Settings = lazyWithReload(() => import("@/pages/Settings"));
const NotFound = lazyWithReload(() => import("@/pages/NotFound"));
const LeadCancellationRequests = lazyWithReload(() => import("@/pages/LeadCancellationRequests"));
const LeadPaymentRequests = lazyWithReload(() => import("@/pages/LeadPaymentRequests"));
const QuotePendingRequests = lazyWithReload(() => import("@/pages/QuotePendingRequests"));
const QuoMonitorPage = lazyWithReload(() => import("@/pages/quo-monitor/QuoMonitorPage"));
const CrmUpdates = lazyWithReload(() => import("@/pages/CrmUpdates"));
const MapViewPage = lazyWithReload(() => import("@/pages/MapViewPage"));
const TechniciansPage = lazyWithReload(() => import("@/pages/TechniciansPage"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      retry: 1,
    },
  },
});

function PageFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <div className="w-6 h-6 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
    </div>
  );
}

function ProtectedRoutes() {
  const { fullyAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!fullyAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <AppLayout />;
}

function LoginRoute() {
  const { loading, fullyAuthenticated } = useAuth();

  if (loading) {
    return null;
  }

  if (fullyAuthenticated) {
    return <Navigate to="/leads" replace />;
  }

  return <Login />;
}

function PageRoute({ navItem, children }: { navItem: string; children: ReactNode }) {
  const { canAccess, profileLoaded } = useAuth();

  if (!profileLoaded) {
    return <PageFallback />;
  }

  if (!canAccess(navItem)) {
    return <Navigate to="/leads" replace />;
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={<PageFallback />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginRoute />} />
            <Route path="/" element={<ProtectedRoutes />}>
              <Route index element={<Navigate to="/leads" replace />} />
              <Route path="leads" element={<PageRoute navItem="leads"><LeadsPage /></PageRoute>} />
              <Route path="leads/:id" element={<PageRoute navItem="leads"><LeadDetailPage /></PageRoute>} />
              <Route path="schedule" element={<PageRoute navItem="schedule"><SchedulePage /></PageRoute>} />
              <Route path="analytics" element={<PageRoute navItem="analytics"><Analytics /></PageRoute>} />
              <Route path="areas" element={<PageRoute navItem="areas"><AreasPage /></PageRoute>} />
              <Route path="map-view" element={<PageRoute navItem="map_view"><MapViewPage /></PageRoute>} />
              <Route path="technicians" element={<PageRoute navItem="technicians"><TechniciansPage /></PageRoute>} />

              <Route path="activity-logs" element={<PageRoute navItem="activity_logs"><ActivityLogs /></PageRoute>} />
              <Route path="quo-monitor" element={<PageRoute navItem="quo_monitor"><QuoMonitorPage /></PageRoute>} />
              <Route path="quo-dashboard" element={<PageRoute navItem="quo_monitor"><QuoMonitorPage /></PageRoute>} />
              <Route path="lead-cancellation-requests" element={<PageRoute navItem="cancellation_requests"><LeadCancellationRequests /></PageRoute>} />
              <Route path="lead-payment-requests" element={<PageRoute navItem="payment_requests"><LeadPaymentRequests /></PageRoute>} />
              <Route path="quote-pending" element={<PageRoute navItem="quote_pending_requests"><QuotePendingRequests /></PageRoute>} />
              <Route path="crm-updates" element={<PageRoute navItem="crm_updates"><CrmUpdates /></PageRoute>} />
              <Route path="settings" element={<PageRoute navItem="settings"><Settings /></PageRoute>} />
            </Route>
            <Route path="*" element={<Suspense fallback={<PageFallback />}><NotFound /></Suspense>} />
          </Routes>
        </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
