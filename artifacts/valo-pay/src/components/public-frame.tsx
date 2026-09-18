import { type ReactNode } from 'react';
import { Link } from 'wouter';
import { ArrowLeft } from 'lucide-react';
import { BrandLockup } from '@/components/brand';
import '@/public-pages.css';

/**
 * The frame every public page shares (sign-in, sign-up, not found): the skip
 * link, the brand lockup and one way back to the start, the same on each so
 * a visitor recognises where they are (consistency). The landing page has
 * its own header because it also carries the section links and the ways in.
 */
export function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="public-site min-h-screen bg-background text-foreground">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">Skip to main content</a>
      <header className="public-header">
        <div className="public-container flex items-center justify-between gap-4 py-5">
          <BrandLockup />
          <Link href="/" className="public-back inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" /> Back to home</Link>
        </div>
      </header>
      {children}
    </div>
  );
}
