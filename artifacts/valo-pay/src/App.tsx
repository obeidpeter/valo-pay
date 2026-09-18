import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { focusMain } from '@/lib/focus';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFoundPage from '@/pages/not-found';
import {
  Route,
  Switch,
  matchRoute,
  useLocation,
  useRouter,
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

/** Every address the console has a page for. Anything else is not found, and gets no workspace. */
const consoleRoutes: Array<{ path: string; component: ComponentType<any> }> = [
  { path: '/overview', component: OverviewPage },
  { path: '/customers', component: CustomersPage },
  { path: '/customers/:id', component: CustomerTimelinePage },
  { path: '/reconciliation', component: ReconciliationPage },
  { path: '/exceptions', component: ExceptionsPage },
  { path: '/policies', component: PoliciesPage },
  { path: '/mandates', component: MandatesPage },
  { path: '/collections', component: CollectionsPage },
  { path: '/reports', component: ReportsPage },
  { path: '/evidence', component: EvidencePage },
  { path: '/audit', component: AuditPage },
  { path: '/settings', component: SettingsPage },
];

/**
 * The console mounts once for every address it has a page for, so the
 * workspace and the chosen lender survive navigation. Any other address gets
 * the not-found page outside the workspace provider: a mistyped address or a
 * stray crawler creates no sandbox (frontend contract, Pages).
 */
function Console() {
  const [location] = useLocation();
  const { parser } = useRouter();
  const known = consoleRoutes.some((route) => matchRoute(parser, route.path, location)[0]);
  if (!known) return <NotFoundPage />;
  return (
    <WorkspaceProvider>
      <Layout>
        <Switch>
          {consoleRoutes.map((route) => <Route key={route.path} path={route.path} component={route.component} />)}
        </Switch>
      </Layout>
    </WorkspaceProvider>
  );
}

/**
 * After in-app navigation, focus moves to the page's main region, as it would
 * on a page load, so keyboard and screen-reader users start at the top of what
 * changed instead of on a link that may no longer exist.
 */
function RouteFocus() {
  const [location] = useLocation();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (previous.current !== null && previous.current !== location) focusMain();
    previous.current = location;
  }, [location]);
  return null;
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
                  opens the console. */}
              <Route path="/" component={LandingPage} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route component={Console} />
            </Switch>
          </RoutedErrorBoundary>
          <RouteFocus />
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
