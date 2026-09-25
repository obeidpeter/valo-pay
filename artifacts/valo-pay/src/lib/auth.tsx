import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { ClerkSessionProps } from './clerk-session';

const configuredKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const localHost = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(window.location.hostname);

/**
 * Replit derives a managed Clerk key from the deployment host, so sign-in is
 * available wherever the app is served from a real domain. On a local host
 * with no configured key there is no Clerk to reach, and the anonymous
 * synthetic sandbox runs on its own (frontend contract: accessible without login).
 * True only where Clerk will be loaded, so the session below comes from Clerk.
 */
export const authEnabled = Boolean(configuredKey) || !localHost;

/**
 * Clerk's code (about 90 kB) is not in the page shell: it is fetched as its
 * own chunk, only where sign-in is wanted, starting as the app loads so it
 * arrives while the first page renders (lib/clerk-session.tsx).
 */
const clerkSession = authEnabled ? import('./clerk-session') : null;

export type SessionUser = { userId: string | null; orgId?: string | null; isLoaded: boolean };
/** The signed-in person as Clerk reports them, and the way to sign out. */
export type Session = SessionUser & { signOut: () => void };
type Provided = Session & { available: boolean };
const anonymous: Provided = { available: false, userId: null, isLoaded: true, signOut: () => {} };
const waiting: Provided = { available: true, userId: null, isLoaded: false, signOut: () => {} };
const SessionContext = createContext<Provided>(anonymous);

/** The signed-in user, or the anonymous sandbox where sign-in is unavailable; `isLoaded` is false until Clerk has answered. */
export function useSessionUser(): SessionUser {
  return useContext(SessionContext);
}

/** A sign-out function, or a no-op when sign-in is unavailable. */
export function useSignOut(): () => void {
  return useContext(SessionContext).signOut;
}

/** Renders its children for the given session state once Clerk has answered; renders nothing when sign-in is unavailable. */
export function AuthShow({ when, children }: { when: 'signed-in' | 'signed-out'; children: ReactNode }) {
  const { available, userId, isLoaded } = useContext(SessionContext);
  if (!available || !isLoaded || (when === 'signed-in') !== Boolean(userId)) return null;
  return <>{children}</>;
}

type Placed = { node: HTMLElement; content: ReactNode };
/** Where Clerk's own components are placed in the page: each renders under Clerk's provider, into its slot's place. */
export class ClerkSlots {
  private slots = new Map<string, Placed>();
  private listeners = new Set<() => void>();
  private current: Array<[string, Placed]> = [];
  set(id: string, node: HTMLElement, content: ReactNode): void { this.slots.set(id, { node, content }); this.changed(); }
  delete(id: string): void { if (this.slots.delete(id)) this.changed(); }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = (): Array<[string, Placed]> => this.current;
  private changed(): void { this.current = [...this.slots]; this.listeners.forEach((listener) => listener()); }
}
const SlotContext = createContext<ClerkSlots | null>(null);

/**
 * Clerk's own components (its sign-in form, the organisation switcher and
 * re-verification) need Clerk's provider around them. That provider renders
 * beside the pages rather than around them, so its arrival never remounts a
 * page: what is placed here is rendered under it, into this place in the
 * page, once Clerk has loaded. Nothing shows before then, as Clerk's own
 * components show nothing until Clerk has loaded.
 */
export function ClerkSlot({ children }: { children: ReactNode }) {
  const slots = useContext(SlotContext);
  const id = useId();
  const [node, setNode] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { if (slots && node) slots.set(id, node, children); }, [slots, node, id, children]);
  useLayoutEffect(() => () => { slots?.delete(id); }, [slots, id]);
  return <div ref={setNode} className="contents" />;
}

/**
 * The session for the pages below: the anonymous sandbox where sign-in is
 * unavailable, otherwise Clerk's, reported by Clerk's provider once its chunk
 * has loaded. Until then the session is not loaded, as it is until Clerk
 * itself has answered; if the chunk cannot be fetched, sign-in stays
 * unavailable and the workspace starts anonymously after its wait.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (!clerkSession) return <>{children}</>;
  return <ClerkLoader load={clerkSession}>{children}</ClerkLoader>;
}

/** The session from Clerk's chunk once `load` brings it, rendering Clerk's provider beside `children`; AuthProvider's, where sign-in is wanted. */
export function ClerkLoader({ load, children }: { load: Promise<{ ClerkSession: ComponentType<ClerkSessionProps> }>; children: ReactNode }) {
  const [session, setSession] = useState<Provided>(waiting);
  const report = useCallback((next: Session) => setSession({ ...next, available: true }), []);
  const [slots] = useState(() => new ClerkSlots());
  const [Clerk, setClerk] = useState<ComponentType<ClerkSessionProps> | null>(null);
  useEffect(() => {
    let current = true;
    load.then((module) => { if (current) setClerk(() => module.ClerkSession); }, () => undefined);
    return () => { current = false; };
  }, [load]);
  return (
    <SessionContext.Provider value={session}>
      <SlotContext.Provider value={slots}>
        {children}
        {Clerk && <Clerk onSession={report} slots={slots} />}
      </SlotContext.Provider>
    </SessionContext.Provider>
  );
}
