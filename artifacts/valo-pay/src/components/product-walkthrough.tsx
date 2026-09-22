import { useRef, useState } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  CirclePlay,
  CreditCard,
  LayoutDashboard,
  Mail,
  ScanLine,
  UserRoundCheck,
} from "lucide-react";
import { Button } from "./ui/button";

const screens = [
  {
    name: "Collections",
    icon: LayoutDashboard,
    hint: "Review the working day",
    path: "/overview",
    title: "Start with the work that needs attention",
    description:
      "See outstanding instalments, proposed matches and overdue exceptions. Follow the evidence into reconciliation and a dated daily close.",
    exercise: "Open a sample customer and follow their collection history.",
    boundary: "Records and collection decisions use synthetic data.",
  },
  {
    name: "Pay-by-bank",
    icon: CreditCard,
    hint: "Follow a payment",
    path: "/pay-by-bank",
    title: "From checkout to a reconciled receipt",
    description:
      "Create a sample checkout for an instalment. Follow authorisation, a pending browser return and a confirmed or uncertain provider outcome.",
    exercise: "Try an unknown result before confirming the sample receipt.",
    boundary:
      "Payment authorisation and provider responses are simulated. No money moves.",
  },
  {
    name: "Credit Desk",
    icon: UserRoundCheck,
    hint: "Understand an assessment",
    path: "/credit-desk",
    title: "Put the evidence beside the recommendation",
    description:
      "Inspect evidence quality, affordability and score factors. See how a separate reviewer records the outcome and an applicant explanation.",
    exercise:
      "Grant the two applicant permissions, then compare sample evidence scenarios.",
    boundary:
      "The rule score is illustrative. No real loan is approved or disbursed.",
  },
  {
    name: "Cash Desk",
    icon: ChartNoAxesCombined,
    hint: "Plan business cash",
    path: "/cash-desk",
    title: "See what is available and what comes next",
    description:
      "Explore cash positions and forecast scenarios for a separate sample SME, then review accounting drafts, VAT evidence and payroll funding.",
    exercise:
      "Grant business-account permission, then set up the sample Cash Desk.",
    boundary: "No live bank feeds, accounting posting, tax filing or payouts.",
  },
];
export const PILOT_EMAIL = "obeidpeter1@gmail.com";
export const PILOT_CONTACT = `mailto:${PILOT_EMAIL}?subject=${encodeURIComponent("Valo Pay pilot enquiry")}&body=${encodeURIComponent("Hello, I would like to discuss a Valo Pay pilot.\n\nOrganisation and my role:\nWorkflow of interest (Collections / Pay-by-bank / Credit Desk / Cash Desk):\nThe problem we want to solve:\nCurrent payment provider, banks and business software (names only):\nApproximate monthly workflow volume:\nDesired pilot timing:\n\nPlease do not include customer records, bank details or credentials.")}`;

/** Uses the actual console, loaded only after an explicit choice; no decorative mock data or autoplay. */
export function ProductWalkthrough() {
  const [active, setActive] = useState(0);
  const [started, setStarted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const loadButton = useRef<HTMLButtonElement>(null);
  const closePreview = () => {
    setStarted(false);
    setLoaded(false);
    requestAnimationFrame(() => loadButton.current?.focus());
  };
  const screen = screens[active]!;
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [path, hash] = screen.path.split("#");
  const source = `${basePath}${path}${path!.includes("?") ? "&" : "?"}embedded=1${hash ? `#${hash}` : ""}`;
  return (
    <section
      id="product-tour"
      className="lp-section lp-product-tour"
      aria-labelledby="product-tour-title"
    >
      <div className="public-container">
        <div className="lp-section-intro lp-split-intro">
          <p className="lp-section-kicker">Explore the real workspace</p>
          <h2 id="product-tour-title">
            Take a closer look.{" "}
            <br />
            Then try it yourself.
          </h2>
          <p>
            Choose a workflow, see what to expect, then load the actual console.
            Everything here runs on sample data.
          </p>
        </div>
        <div
          className="lp-tour-tabs"
          role="group"
          aria-label="Choose a product screen"
        >
          {screens.map((item, index) => (
            <button
              key={item.name}
              className="lp-tour-step"
              aria-pressed={active === index}
              aria-controls="tour-preview"
              onClick={() => {
                if (active !== index) {
                  setStarted(false);
                  setLoaded(false);
                  setActive(index);
                }
              }}
            >
              <item.icon aria-hidden="true" />
              <span>
                <span>
                  {String(index + 1).padStart(2, "0")} · {item.name}
                </span>
                <span>{item.hint}</span>
              </span>
              <ArrowRight aria-hidden="true" />
            </button>
          ))}
        </div>
        <div id="tour-preview" className="lp-tour-shell">
          <div className="lp-tour-toolbar">
            <span>
              <span aria-hidden="true" className="lp-tour-indicator" />{" "}
              {started ? "Interactive sandbox" : "Explore the workspace"}
            </span>
            <div>
              {started && (
                <Button variant="ghost" size="sm" onClick={closePreview}>
                  Close preview
                </Button>
              )}
              <Button asChild variant="ghost" size="sm">
                <Link href={screen.path}>
                  Open full screen{" "}
                  <ArrowUpRight aria-hidden="true" className="ml-1 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
          <div className="lp-tour-copy" aria-live="polite">
            <h3>{screen.title}</h3>
            <p>{screen.description}</p>
          </div>
          <div className="lp-tour-frame">
            {started ? (
              <>
                <p className="lp-tour-load-status" role="status">
                  {loaded
                    ? `${screen.name} preview loaded. Sample data only.`
                    : "Loading preview… You can also open it full screen."}
                </p>
                <iframe
                  key={source}
                  src={source}
                  title={`Interactive Valo Pay ${screen.name.toLowerCase()} preview — sample data`}
                  onLoad={() => setLoaded(true)}
                />
              </>
            ) : (
              <div className="lp-tour-placeholder">
                <span className="lp-tour-play">
                  <CirclePlay aria-hidden="true" />
                </span>
                <p>Try this in {screen.name}</p>
                <span>{screen.exercise}</span>
                <Button
                  ref={loadButton}
                  size="lg"
                  onClick={() => setStarted(true)}
                >
                  Load interactive preview{" "}
                  <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />
                </Button>
                <span className="lp-tour-start-note">
                  No sign-in needed. The preview opens only when you choose.
                </span>
              </div>
            )}
          </div>
          <div className="lp-tour-footnote">
            <ScanLine aria-hidden="true" />
            <p>
              <strong>{screen.boundary}</strong> Closing the preview does not
              undo your sample changes. Anonymous work does not transfer when
              you sign in to an account-linked workspace. On a phone, open full
              screen for more room.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function PilotEnquiry() {
  return (
    <section
      id="pilot"
      className="lp-section lp-pilot"
      aria-labelledby="pilot-title"
    >
      <div className="public-container">
        <div className="lp-pilot-inner">
          <div>
            <p className="lp-section-kicker">Plan a focused pilot</p>
            <h2 id="pilot-title">
              Start with one problem{" "}
              <br />
              worth solving.
            </h2>
            <p>
              Tell us which workflow matters to your team: collections,
              pay-by-bank, credit assessment or business cash. Include your
              current provider and software names so we can discuss scope,
              access and success measures.
            </p>
            <p className="lp-pilot-note">
              Please keep customer records, bank details and credentials out of
              your enquiry. An enquiry does not activate a service or start
              billing.
            </p>
          </div>
          <div className="lp-pilot-actions">
            <span className="lp-icon-tile">
              <Mail aria-hidden="true" />
            </span>
            <h3>Let’s talk about your workflow</h3>
            <Button asChild size="lg">
              <a href={PILOT_CONTACT}>
                Discuss a pilot{" "}
                <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />
              </a>
            </Button>
            <a href={`mailto:${PILOT_EMAIL}`}>{PILOT_EMAIL}</a>
            <span>Opens your email app · You choose when to send</span>
          </div>
        </div>
      </div>
    </section>
  );
}
