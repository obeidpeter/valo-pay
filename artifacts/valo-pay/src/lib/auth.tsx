import { type ReactNode } from 'react';
import { Show, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';

const configuredKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const localHost = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(window.location.hostname);

/**
 * Replit derives a managed Clerk key from the deployment host, so sign-in is
 * available wherever the app is served from a real domain. On a local host
 * with no configured key there is no Clerk to reach, and the anonymous
 * synthetic sandbox runs on its own (frontend contract: accessible without login).
 */
const signInWanted = Boolean(configuredKey) || !localHost;
export const clerkPublishableKey = signInWanted ? publishableKeyFromHost(window.location.hostname, configuredKey) || undefined : undefined;
/** True only when a ClerkProvider will be mounted, so the Clerk hooks below are never used without one. */
export const authEnabled = Boolean(clerkPublishableKey);

type SessionUser = { userId: string | null; isLoaded: boolean };
function useClerkSessionUser(): SessionUser {
  const { userId, isLoaded } = useAuth();
  return { userId: userId ?? null, isLoaded };
}
function useAnonymousSessionUser(): SessionUser {
  return { userId: null, isLoaded: true };
}
/** Stable at module load, so the same hook is used for the life of the app. */
export const useSessionUser: () => SessionUser = authEnabled ? useClerkSessionUser : useAnonymousSessionUser;

function useClerkSignOut(): () => void {
  const { signOut } = useClerk();
  return () => { void signOut(); };
}
function useNoSignOut(): () => void {
  return () => {};
}
export const useSignOut: () => () => void = authEnabled ? useClerkSignOut : useNoSignOut;

/** Renders its children for the given session state; renders nothing when sign-in is unavailable. */
export function AuthShow({ when, children }: { when: 'signed-in' | 'signed-out'; children: ReactNode }) {
  if (!authEnabled) return null;
  return <Show when={when}>{children}</Show>;
}
