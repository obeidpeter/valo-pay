// Clerk loads as a chunk of its own, beside the pages (audit of 23 September,
// item 12): its arrival reports the session without remounting a page, and
// Clerk's own components render under its provider, in their place on the page.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { Router } from "wouter";
import { SignIn } from "@clerk/react";
import { AuthShow, ClerkLoader, ClerkSlot, useSessionUser, useSignOut } from "@/lib/auth";

vi.unmock("@/lib/auth");
const clerk = vi.hoisted(() => ({ signOut: () => {}, signedOut: 0 }));
vi.mock("@clerk/react", async () => {
  const React = await import("react");
  const Provided = React.createContext(false);
  return {
    ClerkProvider: ({ children }: { children: React.ReactNode }) => <Provided.Provider value>{children}</Provided.Provider>,
    useAuth: () => {
      if (!React.useContext(Provided)) throw new Error("useAuth outside ClerkProvider");
      return { userId: "user_sample", orgId: "org_sample", isLoaded: true };
    },
    useClerk: () => ({ signOut: async () => { clerk.signedOut += 1; } }),
    SignIn: () => <section aria-label={React.useContext(Provided) ? "Sign-in under Clerk's provider" : "Sign-in outside Clerk's provider"} />,
  };
});
vi.mock("@clerk/react/internal", () => ({ publishableKeyFromHost: () => "pk_test_sample" }));

function Session() {
  const { userId, isLoaded } = useSessionUser();
  const signOut = useSignOut();
  return <><p>{isLoaded ? `Signed in as ${userId}` : "Waiting for Clerk"}</p><button onClick={signOut}>Sign out</button></>;
}
/** State a remount would lose. */
function Draft() {
  const [value, setValue] = useState("");
  return <input aria-label="Draft" value={value} onChange={(event) => setValue(event.target.value)} />;
}

it("reports Clerk's session when its chunk arrives, keeps the page mounted and places Clerk's form in the page", async () => {
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const load = arrived.then(() => import("@/lib/clerk-session"));
  render(
    <Router>
      <ClerkLoader load={load}>
        <Session />
        <Draft />
        <AuthShow when="signed-in"><p>Only when signed in</p></AuthShow>
        <div data-testid="place"><ClerkSlot><SignIn /></ClerkSlot></div>
      </ClerkLoader>
    </Router>,
  );
  expect(screen.getByText("Waiting for Clerk")).toBeTruthy();
  expect(screen.queryByText("Only when signed in")).toBeNull();
  expect(screen.queryByRole("region")).toBeNull();
  const draft = screen.getByLabelText("Draft") as HTMLInputElement;
  act(() => { draft.focus(); });
  fireEvent.change(draft, { target: { value: "typed before Clerk arrived" } });

  await act(async () => { arrive(); await load; });
  await screen.findByText("Signed in as user_sample");
  expect(screen.getByText("Only when signed in")).toBeTruthy();
  // The same input, with its value and focus: Clerk's arrival did not remount the page.
  expect(screen.getByLabelText("Draft")).toBe(draft);
  expect(draft.value).toBe("typed before Clerk arrived");
  expect(document.activeElement).toBe(draft);
  // Clerk's form renders under Clerk's provider, where the page placed it.
  expect(within(screen.getByTestId("place")).getByRole("region", { name: "Sign-in under Clerk's provider" })).toBeTruthy();
  screen.getByRole("button", { name: "Sign out" }).click();
  await waitFor(() => expect(clerk.signedOut).toBe(1));
});

it("keeps sign-in unavailable, and shows neither signed-in nor signed-out content, without Clerk", () => {
  render(<><AuthShow when="signed-out"><p>Signed out</p></AuthShow><AuthShow when="signed-in"><p>Signed in</p></AuthShow><Session /></>);
  expect(screen.queryByText("Signed out")).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(screen.getByText("Signed in as null")).toBeTruthy();
});
