import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useWorkspace } from '@/lib/workspace-context';
import { AuthShow, useSignOut } from '@/lib/auth';
import { Shield, Home, Users, FileText, ArrowRightLeft, CheckSquare, AlertTriangle, FileBarChart, HardDrive, FileCheck, Settings, Lock, LogOut, Menu } from 'lucide-react';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from './ui/sheet';
import { BrandLockup } from './brand';
import { ErrorBoundary, ErrorNotice } from './error-boundary';
import { focusMain } from '@/lib/focus';

/** The console's pages, in the one order they are listed: the sidebar, the phone drawer and the page title. */
const navItems = [
  { href: '/overview', label: 'Overview', icon: Home },
  { href: '/customers', label: 'Customers', icon: Users },
  { href: '/mandates', label: 'Mandates', icon: FileText },
  { href: '/collections', label: 'Collections', icon: ArrowRightLeft },
  { href: '/reconciliation', label: 'Reconciliation', icon: CheckSquare },
  { href: '/exceptions', label: 'Exceptions', icon: AlertTriangle },
  { href: '/policies', label: 'Policies & Templates', icon: Shield },
  { href: '/reports', label: 'Reports', icon: FileBarChart },
  { href: '/evidence', label: 'Evidence & Commercial', icon: FileCheck },
  { href: '/audit', label: 'Audit Log', icon: HardDrive },
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
      {navItems.map(item => {
        const active = location === item.href || location.startsWith(`${item.href}/`);
        return (
          <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined} onClick={onNavigate} className={`flex items-center gap-3 px-3 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${spacious ? 'py-3' : 'py-2'} ${active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>
            <item.icon className="h-4 w-4" aria-hidden="true" />
            {item.label}
          </Link>
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
            <LogOut className="h-4 w-4" aria-hidden="true" /> Sign Out
          </Button>
          <div className="text-xs font-mono text-muted-foreground bg-secondary px-2 py-1 rounded">
            {role || 'User'}
          </div>
        </div>
      </AuthShow>
      <AuthShow when="signed-out">
        <Link href="/sign-in" className="flex items-center justify-center gap-2 w-full bg-primary text-primary-foreground py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors mb-2">
          <Lock className="h-4 w-4" aria-hidden="true" /> Sign In
        </Link>
        <p className="text-xs text-center text-muted-foreground">Sign in to your own workspace</p>
      </AuthShow>
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { workspace, merchantId, setMerchantId, isLoading } = useWorkspace();
  const [location] = useLocation();
  const signOut = useSignOut();

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
  const lenderSelect = (id: string, className: string) => (
    <select id={id} className={className} value={merchantId || ''} onChange={(e) => setMerchantId(e.target.value)}>
      {workspace?.merchants.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  );

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* The first tab stop skips the banner, the lender selector and eleven links (universal design: low physical effort). */}
      <a href="#main" onClick={focusMain} className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">Skip to page content</a>
      {/* Sandbox banner: on a phone it keeps the sentence that matters and drops the restatement, so it stays one line. */}
      <div className="bg-warning text-warning-foreground px-4 py-2 text-sm font-medium flex items-center justify-center gap-2 border-b border-warning-border z-50">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>Sandbox · Synthetic data. We never hold money.<span className="hidden sm:inline"> No live operations permitted.</span></span>
        {workspace?.environment && <span className="ml-2 hidden sm:inline-block font-mono text-xs bg-warning-border px-2 py-0.5 rounded">MODE: {workspace.environment}</span>}
      </div>

      {/* Phone bar: the brand, the lender being worked on, and the drawer with the same pages as the sidebar. */}
      <div className="md:hidden sticky top-0 z-40 flex items-center gap-2 border-b bg-card px-3 py-2">
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
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 border-r bg-card flex flex-col hidden md:flex shrink-0">
          <div className="p-4 border-b h-16 flex items-center justify-between">
            <BrandLockup descriptor={false} />
            <span className="text-xs text-muted-foreground font-mono">STAGE 1</span>
          </div>

          {/* Lender selector */}
          {workspace && workspace.merchants.length > 0 && (
            <div className="p-4 border-b">
              <label htmlFor="lender-sidebar" className="text-xs font-semibold text-muted-foreground uppercase mb-2 block">Active lender</label>
              {lenderSelect('lender-sidebar', 'w-full bg-secondary text-secondary-foreground rounded-md text-sm p-2 border-none ring-1 ring-border')}
            </div>
          )}

          <nav aria-label="Pages" className="flex-1 overflow-y-auto p-4 space-y-1">
            <NavLinks location={location} />
          </nav>

          <div className="p-4 border-t mt-auto">
            <AuthBlock role={workspace?.role} signOut={signOut} />
          </div>
        </aside>

        {/* Main Content */}
        <main id="main" tabIndex={-1} className="flex-1 overflow-auto bg-background focus:outline-none">
          <div className="p-4 sm:p-6 md:p-8 max-w-7xl mx-auto" aria-busy={isLoading && !workspace}>
            {/* Until the workspace arrives the pages have no lender to show, so the page area says what is happening instead.
                A page that stops working keeps the sidebar and the lender selector as the way out. */}
            {isLoading && !workspace
              ? <p role="status" className="text-sm text-muted-foreground">Loading your workspace…</p>
              : <ErrorBoundary resetKey={location} FallbackComponent={ErrorNotice} onErrorChange={setPageError}>{children}</ErrorBoundary>}
          </div>
        </main>
      </div>
    </div>
  );
}
