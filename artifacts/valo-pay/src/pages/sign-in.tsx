import { useEffect, type ReactNode } from "react";
import { Link } from "wouter";
import { SignIn, SignUp } from "@clerk/react";
import { dark } from "@clerk/themes";
import { useTheme } from "@/lib/theme";
import {
  ArrowLeftRight,
  ArrowRight,
  ChartNoAxesCombined,
  ChevronDown,
  FileCheck2,
  FolderCheck,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { PublicFrame } from "@/components/public-frame";
import { Button } from "@/components/ui/button";
import { authEnabled } from "@/lib/auth";
import "@/sign-in.css";

/**
 * Sign-in and sign-up share a branded welcome panel and a focused form.
 * On phones the form follows the welcome, before the supporting context. The form
 * itself is Clerk's, themed to the console's tokens, because it already
 * handles every strategy, its errors are in plain language and its labels are
 * visible.  Where Clerk is not configured there is no account to sign into,
 * and the page says so and offers the sandbox instead of a form that could
 * not work (visibility of system status; help users recognise and recover).
 */

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Clerk's form in the console's colours, type and radius. */
const appearance = {
  variables: {
    colorPrimary: "hsl(var(--primary))",
    colorText: "hsl(var(--foreground))",
    colorTextSecondary: "hsl(var(--muted-foreground))",
    colorBackground: "hsl(var(--card))",
    colorInputBackground: "hsl(var(--background))",
    colorInputText: "hsl(var(--foreground))",
    colorTextOnPrimaryBackground: "hsl(var(--primary-foreground))",
    colorDanger: "hsl(var(--destructive))",
    borderRadius: "0.75rem",
    fontFamily: "'Plus Jakarta Sans', sans-serif",
  },
  elements: {
    rootBox: "auth-clerk-root",
    cardBox: "auth-clerk-box",
    card: "auth-clerk-card",
    headerTitle: "auth-clerk-title",
    headerSubtitle: "auth-clerk-subtitle",
    formFieldInput: "auth-clerk-input",
    formButtonPrimary: "auth-clerk-submit",
    socialButtonsBlockButton: "auth-clerk-social",
    footer: "auth-clerk-footer",
    footerActionLink: "auth-clerk-link",
  },
} as const;

/** The same form on a dark console: Clerk's dark base theme with the console's dark tokens, so the door matches the room. */
const darkAppearance = {
  ...appearance,
  baseTheme: dark,
  variables: {
    ...appearance.variables,
    colorTextOnPrimaryBackground: "hsl(var(--primary-foreground))",
  },
};

function useClerkAppearance() {
  const { theme } = useTheme();
  return theme === "dark" ? darkAppearance : appearance;
}

function Shell({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · Valo Pay`;
  }, [title]);
  return (
    <PublicFrame className="auth-site">
      <main
        id="main"
        tabIndex={-1}
        className="public-container public-auth focus:outline-none"
      >
        <div className="auth-welcome">
          <p className="auth-eyebrow">
            <span aria-hidden="true" /> Your connected workspace
          </p>
          <h1>{title}</h1>
          <p className="auth-intro">{intro}</p>
          <p className="auth-workspace-state">
            <span aria-hidden="true" /> Explore with sample data
          </p>
        </div>
        <div className="auth-form-area">
          {children}
          <p className="auth-footnote">
            <ShieldCheck aria-hidden="true" />
            <span>Signing in does not activate live financial services.</span>
          </p>
        </div>
        <aside aria-labelledby="context-title" className="auth-context">
          <h2 id="context-title" className="auth-eyebrow">
            Your financial operations, together.
          </h2>
          <ul className="auth-suite" role="list">
            <li>
              <span className="auth-suite-icon">
                <ArrowLeftRight aria-hidden="true" />
              </span>
              <div>
                <h3>Collections &amp; pay-by-bank</h3>
                <p>
                  Follow customer timelines, match payments and explore a
                  simulated bank-payment journey.
                </p>
              </div>
              <span className="auth-suite-number" aria-hidden="true">
                01
              </span>
            </li>
            <li>
              <span className="auth-suite-icon">
                <FileCheck2 aria-hidden="true" />
              </span>
              <div>
                <h3>Credit Desk</h3>
                <p>
                  Check sample evidence and affordability, then record an
                  independent review.
                </p>
              </div>
              <span className="auth-suite-number" aria-hidden="true">
                02
              </span>
            </li>
            <li>
              <span className="auth-suite-icon">
                <ChartNoAxesCombined aria-hidden="true" />
              </span>
              <div>
                <h3>Cash Desk</h3>
                <p>
                  Explore business cash forecasts, accounting drafts, VAT
                  evidence and payroll funding plans.
                </p>
              </div>
              <span className="auth-suite-number" aria-hidden="true">
                03
              </span>
            </li>
          </ul>
          <div className="auth-saved-work">
            <FolderCheck aria-hidden="true" />
            <div>
              <h3>Why sign in?</h3>
              <p>
                Return to your account-linked workspace and its saved records.
                Anonymous sandbox changes are not copied into it.
              </p>
            </div>
          </div>
          <details className="auth-retention">
            <summary>
              How long is my workspace kept? <ChevronDown aria-hidden="true" />
            </summary>
            <p>
              Anonymous sandboxes may be cleared after 30 days without changes.
              Signed-in workspaces are not cleared by this inactivity rule.
            </p>
          </details>
          <p className="auth-custody">
            <ShieldCheck aria-hidden="true" />
            <span>
              These sample journeys do not connect real bank accounts, make
              lending decisions or move money. Live services need separate
              permissions, provider setup and approval. We never hold money.
            </span>
          </p>
        </aside>
      </main>
    </PublicFrame>
  );
}

/** When this host has no Clerk key there is no account to sign into: say so, say why, and offer the sandbox. */
function Unavailable({ action }: { action: "sign in" | "create an account" }) {
  return (
    <section
      aria-labelledby="unavailable-title"
      className="auth-unavailable auth-card"
    >
      <span className="auth-unavailable-icon">
        <LockKeyhole className="h-5 w-5" aria-hidden="true" />
      </span>
      <h2 id="unavailable-title">Sign-in is unavailable here</h2>
      <p>
        You cannot {action} at this address. You can explore the sandbox without
        an account.
      </p>
      <div className="auth-sandbox-note">
        <Sparkles aria-hidden="true" />
        <p>
          <strong>Try the connected workspace</strong>Explore collections,
          pay-by-bank, Credit Desk and Cash Desk with sample records. No real
          bank connection is needed.
        </p>
      </div>
      <div className="auth-unavailable-actions">
        <Button asChild className="gap-2">
          <Link href="/overview">
            Continue to the sandbox{" "}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">Back to home</Link>
        </Button>
      </div>
    </section>
  );
}

function SandboxOption() {
  return (
    <div className="auth-sandbox-option">
      <span className="auth-sandbox-divider">Just exploring?</span>
      <Link href="/overview" className="auth-sandbox-link">
        <span className="auth-sandbox-icon">
          <Sparkles aria-hidden="true" />
        </span>
        <span>
          <strong>Open the sandbox</strong>
          <span>No account or bank connection needed.</span>
        </span>
        <ArrowRight aria-hidden="true" />
      </Link>
    </div>
  );
}

/** The sign-in page: Clerk's form beside what signing in changes, or the unavailable notice on a host without a key. */
export function SignInPage() {
  const clerkAppearance = useClerkAppearance();
  return (
    <Shell
      title="Sign in to your workspace"
      intro="Return to the collections, credit reviews and business cash plans saved in your account."
    >
      {authEnabled ? (
        <>
          <SignIn
            routing="path"
            path={`${basePath}/sign-in`}
            signUpUrl={`${basePath}/sign-up`}
            fallbackRedirectUrl={`${basePath}/overview`}
            appearance={clerkAppearance}
          />
          <SandboxOption />
        </>
      ) : (
        <Unavailable action="sign in" />
      )}
    </Shell>
  );
}

/** The sign-up page, in the same shell. */
export function SignUpPage() {
  const clerkAppearance = useClerkAppearance();
  return (
    <Shell
      title="Create your workspace"
      intro="Create an account-linked workspace for collections, credit reviews and business cash planning."
    >
      {authEnabled ? (
        <>
          <SignUp
            routing="path"
            path={`${basePath}/sign-up`}
            signInUrl={`${basePath}/sign-in`}
            fallbackRedirectUrl={`${basePath}/overview`}
            appearance={clerkAppearance}
          />
          <SandboxOption />
        </>
      ) : (
        <Unavailable action="create an account" />
      )}
    </Shell>
  );
}
