import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter
} from 'wouter';
import { ClerkProvider } from '@clerk/react';
import { authEnabled, clerkPublishableKey } from '@/lib/auth';

import { WorkspaceProvider } from '@/lib/workspace-context';
import { Layout } from '@/components/layout';

// Public pages: no workspace, no sandbox
import LandingPage from '@/pages/landing';
import { SignInPage, SignUpPage } from '@/pages/sign-in';

// Console pages
import OverviewPage from '@/pages/overview';
import CustomersPage from '@/pages/customers/index';
import CustomerTimelinePage from '@/pages/customers/[id]';
import ReconciliationPage from '@/pages/reconciliation';
import ExceptionsPage from '@/pages/exceptions';
import PoliciesPage from '@/pages/policies';

import MandatesPage from '@/pages/mandates';
import CollectionsPage from '@/pages/collections';
import ReportsPage from '@/pages/reports';
import EvidencePage from '@/pages/evidence';
import AuditPage from '@/pages/audit';
import SettingsPage from '@/pages/settings';

/** Shared by the app and reset between console tests. */
export const queryClient = new QueryClient();

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  const routes = (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RoutedErrorBoundary>
            <Switch>
              {/* The public pages sit outside the workspace provider: reading about the product or
                  signing in never creates a sandbox. The workspace request happens only once someone
                  opens the console (frontend contract, Pages). */}
              <Route path="/" component={LandingPage} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route>
                <WorkspaceProvider>
                  <Layout>
                    <Switch>
                      <Route path="/overview" component={OverviewPage} />
                      <Route path="/customers" component={CustomersPage} />
                      <Route path="/customers/:id" component={CustomerTimelinePage} />
                      <Route path="/reconciliation" component={ReconciliationPage} />
                      <Route path="/exceptions" component={ExceptionsPage} />
                      <Route path="/policies" component={PoliciesPage} />
                      <Route path="/mandates" component={MandatesPage} />
                      <Route path="/collections" component={CollectionsPage} />
                      <Route path="/reports" component={ReportsPage} />
                      <Route path="/evidence" component={EvidencePage} />
                      <Route path="/audit" component={AuditPage} />
                      <Route path="/settings" component={SettingsPage} />
                      <Route component={NotFound} />
                    </Switch>
                  </Layout>
                </WorkspaceProvider>
              </Route>
            </Switch>
          </RoutedErrorBoundary>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
  );

  // Without a reachable Clerk the anonymous sandbox still runs; see lib/auth.tsx.
  if (!authEnabled || !clerkPublishableKey) return routes;
  return (
    <ClerkProvider
      publishableKey={clerkPublishableKey}
      proxyUrl={clerkProxyUrl}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      {routes}
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
