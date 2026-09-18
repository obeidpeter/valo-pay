import {
  Component,
  useEffect,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { LookedFor, Notice } from '@/components/notice';
import { PublicFrame } from '@/components/public-frame';
import { formatDate } from '@/lib/formatters';

/** What the fallback needs: the error, and a way to try the page again. */
export interface ErrorFallbackProps {
  error: Error;
  resetError: () => void;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  FallbackComponent?: ComponentType<ErrorFallbackProps>;
  /** Changing this clears a caught error. Pass the route to recover on navigation. */
  resetKey?: unknown;
  /** Told the caught error, and null once it is cleared, so a parent can reflect the state (the layout's page title). */
  onErrorChange?: (error: Error | null) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string') {
    return new Error(value);
  }
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

/**
 * What a page that stopped working says: that it did, that an error on a
 * page changes no record, the time and the address for a report, and two
 * ways on (Nielsen 1 and 9; Dix: recoverability; Shneiderman: simple error
 * handling). It never shows a stack trace or an API response to a lender's
 * staff; the error's message can carry internals, so it is printed in
 * development only. The links are plain anchors rather than router links,
 * so the notice works outside the router too and a click starts the page
 * afresh rather than re-entering the state that broke.
 */
export function ErrorNotice({ error, resetError }: ErrorFallbackProps) {
  const [at] = useState(() => new Date().toISOString());
  const where = window.location.pathname;
  useEffect(() => {
    const previous = document.title;
    document.title = 'Page error · Valo Pay';
    return () => { document.title = previous; };
  }, []);
  return (
    <Notice
      role="alert"
      title="This page stopped working"
      actions={<>
        <Button onClick={resetError}>Try again</Button>
        <Button asChild variant="outline"><a href={`${basePath}/overview`}>Go to the overview</a></Button>
      </>}
    >
      <p>The page hit an error it could not recover from. An error on a page does not change any record; if you had just confirmed an action, its result is in the <a href={`${basePath}/audit`} className="font-medium text-primary underline-offset-4 hover:underline">audit log</a>.</p>
      <p>If it happens again, tell us the time and the address: <LookedFor>{formatDate(at)}</LookedFor>, <LookedFor>{where}</LookedFor>.</p>
      {import.meta.env.DEV ? (
        <details className="text-xs">
          <summary className="cursor-pointer">Technical details (development only)</summary>
          <pre className="mt-2 overflow-x-auto rounded bg-secondary p-3 text-foreground">{error.message || String(error)}</pre>
        </details>
      ) : null}
    </Notice>
  );
}

/** The fallback outside the console: the notice in the public frame. Inside the console the layout passes ErrorNotice on its own, so the sidebar stays. */
function DefaultFallback(props: ErrorFallbackProps) {
  return (
    <PublicFrame>
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16 focus:outline-none">
        <ErrorNotice {...props} />
      </main>
    </PublicFrame>
  );
}

/** Catches a render error below it and shows the notice in its place; reports the error to the browser console and to onErrorChange. */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: toError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      'ErrorBoundary caught an error:',
      toError(error),
      info.componentStack,
    );
    this.props.onErrorChange?.(toError(error));
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (
      this.state.error !== null &&
      prevProps.resetKey !== this.props.resetKey
    ) {
      this.resetError();
    }
  }

  resetError = (): void => {
    this.setState({ error: null });
    this.props.onErrorChange?.(null);
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    const Fallback = this.props.FallbackComponent ?? DefaultFallback;
    return <Fallback error={error} resetError={this.resetError} />;
  }
}
