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
  Router as WouterRouter,
  Redirect
} from 'wouter';
import { ClerkProvider, SignIn, SignUp, Show } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';

import { WorkspaceProvider } from '@/lib/workspace-context';
import { Layout } from '@/components/layout';

// Pages
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

const queryClient = new QueryClient();

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <WorkspaceProvider>
          <TooltipProvider>
            <RoutedErrorBoundary>
              <Switch>
                <Route path="/sign-in/*?" component={SignInPage} />
                <Route path="/sign-up/*?" component={SignUpPage} />
                <Route>
                  <Layout>
                    <Switch>
                      <Route path="/" component={OverviewPage} />
                      <Route path="/customers" component={CustomersPage} />
                      <Route path="/customers/:id" component={CustomerTimelinePage} />
                      <Route path="/reconciliation" component={ReconciliationPage} />
                      <Route path="/exceptions" component={ExceptionsPage} />
                      <Route path="/policies" component={PoliciesPage} />
                      {/* Placeholders for others */}
                      <Route path="/mandates" component={MandatesPage} />
                      <Route path="/collections" component={CollectionsPage} />
                      <Route path="/reports" component={ReportsPage} />
                      <Route path="/evidence" component={EvidencePage} />
                      <Route path="/audit" component={AuditPage} />
                      <Route path="/settings" component={SettingsPage} />
                      <Route component={NotFound} />
                    </Switch>
                  </Layout>
                </Route>
              </Switch>
            </RoutedErrorBoundary>
            <Toaster />
          </TooltipProvider>
        </WorkspaceProvider>
      </QueryClientProvider>
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
