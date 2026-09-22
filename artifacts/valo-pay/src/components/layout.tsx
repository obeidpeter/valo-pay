import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useWorkspace } from '@/lib/workspace-context';
import { AuthShow, useSignOut } from '@/lib/auth';
import { Shield, Home, Users, FileText, ArrowRightLeft, CheckSquare, AlertTriangle, FileBarChart, HardDrive, FileCheck, Settings, Lock, LogOut, Menu, Sun, Moon, ChevronRight, Layers, Landmark, Building2, ShieldCheck, Link2 } from 'lucide-react';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from './ui/sheet';
import { BrandLockup } from './brand';
import { ErrorBoundary, ErrorNotice } from './error-boundary';
import { focusMain, useDialogActivationTracking } from '@/lib/focus';
import { formatDate } from '@/lib/formatters';
import { useTheme } from '@/lib/theme';
import { SandboxGuide } from './sandbox-guide';
import { useQueuePosition } from '@/lib/queue-position';

/** The console's pages, in the one order they are listed: the sidebar, the phone drawer and the page title. */
const navItems = [
  { href: '/overview', label: 'Overview', icon: Home },
  { href: '/customers', label: 'Customers', icon: Users },
  { href: '/mandates', label: 'Mandates', icon: FileText },
  { href: '/collections', label: 'Collections', icon: ArrowRightLeft },
  { href: '/reconciliation', label: 'Reconciliation', icon: CheckSquare },
  { href: '/exceptions', label: 'Exceptions', icon: AlertTriangle },
  { href: '/pay-by-bank', label: 'Pay-by-bank', icon: Landmark },
  { href: '/credit-desk', label: 'Credit Desk', icon: ShieldCheck },
  { href: '/cash-desk', label: 'Cash Desk', icon: Building2 },
  { href: '/connections', label: 'Permissions & readiness', icon: Link2 },
  { href: '/policies', label: 'Policies & templates', icon: Shield },
  { href: '/reports', label: 'Reports', icon: FileBarChart },
  { href: '/evidence', label: 'Evidence & readiness', icon: FileCheck },
  { href: '/audit', label: 'Audit log', icon: HardDrive },
  { href: '/settings', label: 'Settings', icon: Settings },
];

/** The breakpoint at which the sidebar replaces the phone bar; the same value as Tailwind's `md`. */
const SIDEBAR_QUERY = '(min-width: 768px)';

/**
 * One list of links for the sidebar and the phone drawer, so the console is
 * learnt once and looks the same on every screen. The drawer's rows are taller
 * because they are pressed with a thumb, not a pointer.
 */
function NavLinks({ location, spacious = false, onNavigate }: { location: string; spacious?: boolean; onNavigate?: () => void }) {
  return (
    <>
      {navItems.map((item, index) => {
        const active = location === item.href || location.startsWith(`${item.href}/`);
        return (
          <React.Fragment key={item.href}>
          {[0, 6, 10, 14].includes(index) && <p className={`nav-group-label ${index > 0 ? 'mt-2' : 'mt-0'}`}>{index === 0 ? 'Collections' : index === 6 ? 'Connected banking' : index === 10 ? 'Oversight' : 'Workspace'}</p>}
          <Link href={item.href} aria-current={active ? 'page' : undefined} onClick={onNavigate} className={`console-nav-link flex items-center gap-3 px-3 rounded-lg text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${spacious ? 'py-3' : 'py-1.5'} ${active ? 'is-active' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>
            <item.icon className="h-4 w-4" aria-hidden="true" />
            {item.label}
          </Link>
          </React.Fragment>
        );
      })}
    </>
  );
}

/** Sign in or sign out, the same block at the foot of the sidebar and of the drawer. */
function AuthBlock({ role, signOut }: { role: string | undefined; signOut: () => void }) {
  return (
    <>
      <AuthShow when="signed-in">
        <div className="flex items-center justify-between mb-4">
          <Button variant="ghost" size="sm" onClick={() => signOut()} className="gap-2 text-muted-foreground">
            <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
          </Button>
          <div className="text-xs font-mono text-muted-foreground bg-secondary px-2 py-1 rounded">
            {role || 'User'}
          </div>
        </div>
      </AuthShow>
      <AuthShow when="signed-out">
        <Link href="/sign-in" className="flex items-center justify-center gap-2 w-full bg-primary text-primary-foreground py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors mb-2">
          <Lock className="h-4 w-4" aria-hidden="true" /> Sign in
        </Link>
        <p className="text-xs text-center text-muted-foreground">Keep a workspace linked to your account</p>
      </AuthShow>
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  useDialogActivationTracking();
  const search = useSearch();
  const embedded = new URLSearchParams(search).get('embedded') === '1';
  const { workspace, merchantId, setMerchantId, isLoading } = useWorkspace();
  const [location] = useLocation();
  const signOut = useSignOut();
  const { theme, setChoice } = useTheme();
  const mainRef = useRef<HTMLElement>(null);
  useQueuePosition(mainRef, `${location}?${search}`, `${merchantId}:${workspace?.actor}:${workspace?.role}`);

  // The title names the page, or says the page stopped working while the boundary below shows its notice.
  const [pageError,setPageError]=useState<Error|null>(null);
  useEffect(()=>{document.title=`${pageError?"Page error":navItems.find(n=>n.href===location)?.label||"Customer timeline"} · Valo Pay`;},[location,pageError]);

  // The phone drawer. It opens with focus on the first page, closes when a page is chosen in it or the
  // address changes (the browser's back), and then focus goes to the page content as it does after the
  // sidebar; closed any other way (Escape, the close button, a tap outside) focus returns to the Menu
  // button. It also closes if the window grows past the sidebar breakpoint, where its button is no longer shown.
  const [menuOpen, setMenuOpen] = useState(false);
  const openedAt = useRef(location);
  const currentLocation = useRef(location);
  currentLocation.current = location;
  const drawerPages = useRef<HTMLElement>(null);
  useEffect(() => { if (location !== openedAt.current) setMenuOpen(false); }, [location]);
  useEffect(() => {
    const sidebar = window.matchMedia(SIDEBAR_QUERY);
    const onChange = () => { if (sidebar.matches) setMenuOpen(false); };
    sidebar.addEventListener('change', onChange);
    return () => sidebar.removeEventListener('change', onChange);
  }, []);
  // Paper carries what the screen's chrome carried: the lender, the sandbox notice, and when it was printed.
  // The time is taken again as the print dialog opens, since a page can sit open for a day before it is printed.
  const lender = workspace?.merchants.find(m => m.id === merchantId);
  const lenderName = lender?.name;
  const pageTitle = navItems.find(n => n.href === location)?.label || 'Customer timeline';
  const [printedAt, setPrintedAt] = useState(() => formatDate(new Date().toISOString()));
  useEffect(() => {
    const stamp = () => setPrintedAt(formatDate(new Date().toISOString()));
    window.addEventListener('beforeprint', stamp);
    return () => window.removeEventListener('beforeprint', stamp);
  }, []);
  const lenderSelect = (id: string, className: string) => (
    <select id={id} className={className} value={merchantId || ''} onChange={(e) => setMerchantId(e.target.value)}>
      {workspace?.merchants.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  );

  return (
    <div className="console-shell h-dvh min-h-0 flex flex-col bg-background print:block print:h-auto print:min-h-0">
      {/* The first tab stop skips the banner, the lender selector and eleven links (universal design: low physical effort). */}
      <a href="#main" onClick={focusMain} className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">Skip to page content</a>
      {/* The banner and the phone bar are the page's header landmark, so no content sits outside a landmark. */}
      <header>
      {/* Sandbox banner: on a phone it keeps the sentence that matters and drops the restatement, so it stays one line. */}
      <div className="environment-strip px-4 py-2 text-[11px] font-medium flex items-center justify-center gap-2 border-b z-50 print:hidden">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>Sandbox · Sample data. We never hold money.<span className="hidden sm:inline"> Live instructions are disabled.</span></span>
        {workspace?.environment && <span className="ml-2 hidden sm:inline-block text-[10px] uppercase tracking-wider rounded border px-2 py-0.5">Environment: {workspace.environment}</span>}
      </div>

      {/* Phone bar: the brand, the lender being worked on, and the drawer with the same pages as the sidebar. */}
      <div className="md:hidden sticky top-0 z-40 flex items-center gap-2 border-b bg-card px-3 py-2 print:hidden">
        <BrandLockup descriptor={false} compact className="shrink-0" />
        <label htmlFor="lender-phone" className="sr-only">Active lender</label>
        {lenderSelect('lender-phone', 'min-w-0 flex-1 rounded-md border bg-secondary p-2 text-sm text-secondary-foreground')}
        <Sheet open={menuOpen} onOpenChange={(open) => { if (open) openedAt.current = location; setMenuOpen(open); }}>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" className="shrink-0 gap-2">
              <Menu className="h-4 w-4" aria-hidden="true" /> Menu
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-72 flex-col p-0" aria-describedby={undefined}
            onOpenAutoFocus={(event) => { event.preventDefault(); drawerPages.current?.querySelector('a')?.focus(); }}
            onCloseAutoFocus={(event) => { if (currentLocation.current !== openedAt.current) { event.preventDefault(); focusMain(); } }}>
            <SheetHeader className="border-b p-4 pr-12 text-left">
              <SheetTitle className="text-base">Menu</SheetTitle>
            </SheetHeader>
            <nav ref={drawerPages} aria-label="Pages" className="flex-1 overflow-y-auto p-3 space-y-1">
              <NavLinks location={location} spacious onNavigate={() => setMenuOpen(false)} />
            </nav>
            <div className="border-t p-4">
              <AuthBlock role={workspace?.role} signOut={signOut} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
      </header>
      <div className="flex flex-1 overflow-hidden print:block print:overflow-visible">
        {/* Sidebar */}
        <aside className="console-sidebar w-60 border-r bg-card flex flex-col hidden md:flex shrink-0 print:hidden">
          <div className="px-5 py-3 flex items-center justify-between">
            <BrandLockup descriptor={false} />
            <span className="text-[9px] tracking-widest uppercase text-muted-foreground border rounded px-1.5 py-1">Console</span>
          </div>

          {/* Lender selector */}
          {workspace && workspace.merchants.length > 0 && (
            <div className="mx-3 mb-1 rounded-xl border bg-background px-3 py-2.5">
              <label htmlFor="lender-sidebar" className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1 block">Active lender</label>
              {lenderSelect('lender-sidebar', 'w-full bg-transparent text-foreground rounded text-xs font-semibold py-1 border-none focus-visible:outline-2 focus-visible:outline-ring')}
            </div>
          )}

          <nav aria-label="Pages" className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5">
            <NavLinks location={location} />
          </nav>

          <div className="p-3 border-t mt-auto">
            {/* The sidebar has to fit a 720 px window with every page in view (measured in the design rationale), so this row stays one line high. */}
            <div className="flex items-center gap-3 [&:not(:last-child)]:mb-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary"><Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" /></span>
              <div className="min-w-0 flex-1"><p className="text-xs font-semibold">Sandbox workspace</p><p className="text-[10px] text-muted-foreground mt-0.5">Sample data only</p></div>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setChoice(theme === 'dark' ? 'light' : 'dark')}>
                {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
              </Button>
            </div>
            <AuthBlock role={workspace?.role} signOut={signOut} />
          </div>
        </aside>

        {/* Main Content */}
        <main ref={mainRef} id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-auto bg-background focus:outline-none print:overflow-visible">
          <div className="workspace-bar flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 md:px-8 print:hidden">
            <div className="hidden md:flex items-center gap-2 text-xs"><span className="text-muted-foreground">Workspace</span><ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" /><span className="font-medium">{pageTitle}</span></div>
            <p aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"><span>{workspace?.authenticated ? 'Role' : 'Demo role'}: <strong className="font-semibold">{workspace?.role || 'Loading…'}</strong></span>{lender?.mode && <span>Mode: <strong className="font-semibold">{lender.mode}</strong></span>}<span className="text-muted-foreground">Times in WAT</span></p>
          </div>
          <div className="console-content p-4 sm:p-6 md:p-8 max-w-[1440px] mx-auto print:max-w-none print:p-0" aria-busy={isLoading && !workspace}>
            {/* Print only: the provenance the screen's banner and sidebar carried. */}
            <div className="hidden print:block mb-6 border-b pb-3">
              <div className="flex items-baseline justify-between gap-4 text-sm">
                <span className="font-bold">Valo Pay · Sample data sandbox</span>
                {lenderName && <span>{lenderName}</span>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Sample data only. We never hold money. This is not a live payment record or a statement of account.</p>
            </div>
            {/* Until the workspace arrives the pages have no lender to show, so the page area says what is happening instead.
                A page that stops working keeps the sidebar and the lender selector as the way out. */}
            {isLoading && !workspace
              ? <p role="status" className="text-sm text-muted-foreground">Loading your workspace…</p>
              : <ErrorBoundary resetKey={location} FallbackComponent={ErrorNotice} onErrorChange={setPageError}>{!embedded && !['/pay-by-bank','/credit-desk','/cash-desk','/connections'].includes(location) && <SandboxGuide />}{children}</ErrorBoundary>}
            <p className="hidden print:block mt-8 border-t pt-3 text-xs text-muted-foreground">Printed {printedAt} from the Valo Pay sandbox · {pageTitle}{lenderName ? ` · ${lenderName}` : ''}.</p>
          </div>
        </main>
      </div>
    </div>
  );
}
