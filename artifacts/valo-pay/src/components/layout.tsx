import React, { ReactNode, useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import { useWorkspace } from '@/lib/workspace-context';
import { AuthShow, useSignOut } from '@/lib/auth';
import { Shield, Home, Users, FileText, ArrowRightLeft, CheckSquare, AlertTriangle, FileBarChart, HardDrive, FileCheck, Settings, Lock, LogOut } from 'lucide-react';
import { Button } from './ui/button';

export function Layout({ children }: { children: ReactNode }) {
  const { workspace, merchantId, setMerchantId } = useWorkspace();
  const [location,setLocation] = useLocation();
  const signOut = useSignOut();

  const navItems = [
    { href: '/', label: 'Overview', icon: Home },
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
  useEffect(()=>{document.title=`${navItems.find(n=>n.href===location)?.label||"Customer timeline"} · Valo Pay`;},[location]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Sandbox Banner */}
      <div className="bg-amber-100 text-amber-900 px-4 py-2 text-sm font-medium flex items-center justify-center gap-2 border-b border-amber-200 z-50">
        <AlertTriangle className="h-4 w-4" />
        Sandbox · Synthetic data. We never hold money. No live operations permitted.
        {workspace?.environment && <span className="ml-2 font-mono text-xs bg-amber-200 px-2 py-0.5 rounded">MODE: {workspace.environment}</span>}
      </div>

      <div className="md:hidden grid grid-cols-2 gap-2 border-b bg-card p-3">
        <select aria-label="Navigation" className="min-w-0 rounded border p-2 text-sm" value={navItems.find(n=>n.href===location)?.href||"/customers"} onChange={e=>setLocation(e.target.value)}>
          {navItems.map(n=><option key={n.href} value={n.href}>{n.label}</option>)}
        </select>
        <select aria-label="Active lender" className="min-w-0 rounded border p-2 text-sm" value={merchantId||""} onChange={e=>setMerchantId(e.target.value)}>
          {workspace?.merchants.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <AuthShow when="signed-out"><Link href="/sign-in" className="text-xs text-primary underline">Sign in to your workspace</Link></AuthShow>
        <AuthShow when="signed-in"><button className="text-left text-xs underline" onClick={()=>signOut()}>Sign out</button></AuthShow>
      </div>
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 border-r bg-card flex flex-col hidden md:flex shrink-0">
          <div className="p-4 border-b h-16 flex items-center justify-between">
            <span className="font-bold text-lg tracking-tight">Valo Pay</span>
            <span className="text-xs text-muted-foreground font-mono">STAGE 1</span>
          </div>

          {/* Merchant Selector (if multiple) */}
          {workspace && workspace.merchants.length > 0 && (
            <div className="p-4 border-b">
              <label className="text-xs font-semibold text-muted-foreground uppercase mb-2 block">Active Merchant</label>
              <select 
                className="w-full bg-secondary text-secondary-foreground rounded-md text-sm p-2 border-none ring-1 ring-border"
                value={merchantId || ''}
                onChange={(e) => setMerchantId(e.target.value)}
              >
                {workspace.merchants.map((m: any) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          )}

          <nav className="flex-1 overflow-y-auto p-4 space-y-1">
            {navItems.map(item => {
              const active = location === item.href || (item.href !== '/' && location.startsWith(item.href));
              return (
                <Link key={item.href} href={item.href} className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="p-4 border-t mt-auto">
            <AuthShow when="signed-in">
              <div className="flex items-center justify-between mb-4">
                <Button variant="ghost" size="sm" onClick={() => signOut()} className="gap-2 text-muted-foreground">
                  <LogOut className="h-4 w-4" /> Sign Out
                </Button>
                <div className="text-xs font-mono text-muted-foreground bg-secondary px-2 py-1 rounded">
                  {workspace?.role || 'User'}
                </div>
              </div>
            </AuthShow>
            <AuthShow when="signed-out">
              <Link href="/sign-in" className="flex items-center justify-center gap-2 w-full bg-primary text-primary-foreground py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors mb-2">
                <Lock className="h-4 w-4" /> Sign In
              </Link>
              <p className="text-xs text-center text-muted-foreground">Sign in to your own workspace</p>
            </AuthShow>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-auto bg-background">
          <div className="p-6 md:p-8 max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
