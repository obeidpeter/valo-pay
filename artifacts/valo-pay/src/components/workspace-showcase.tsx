import { useRef, useState } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  Check,
  CircleDot,
  FileCheck2,
  Landmark,
  LayoutDashboard,
  ShieldCheck,
} from "lucide-react";
import { BrandMark } from "./brand";

export const publicWorkspaces = [
  {
    name: "Collections",
    icon: LayoutDashboard,
    path: "/overview",
    lead: "Keep every collection in view.",
    description:
      "Bring mandates, payment matching, exceptions and daily close into one clear operating picture.",
    details: ["Mandates & retries", "Reconciliation", "Customer timelines"],
    preview: "A clear next step for every payment",
    note: "Matched receipts stay separate from items that still need review.",
  },
  {
    name: "Pay-by-bank",
    icon: Landmark,
    path: "/pay-by-bank",
    lead: "Follow the payment through.",
    description:
      "Explore a one-time checkout, review its authorisation and follow the receipt into reconciliation.",
    details: ["Amount-bound checkout", "Receipt verification", "Refund review"],
    preview: "Authorisation is only the beginning",
    note: "Returning from a bank screen does not mean a payment has been confirmed.",
  },
  {
    name: "Credit Desk",
    icon: ShieldCheck,
    path: "/credit-desk",
    lead: "Make the evidence clear.",
    description:
      "Inspect sample financial evidence, an explained rule score and repayment capacity before a separate review.",
    details: ["Evidence quality", "Affordability", "Independent review"],
    preview: "Evidence first. A considered decision.",
    note: "Illustrative rule scores are not validated credit ratings or lending decisions.",
  },
  {
    name: "Cash Desk",
    icon: Building2,
    path: "/cash-desk",
    lead: "Plan the work ahead.",
    description:
      "Explore business cash, forecasts, accounting drafts, VAT evidence and reviewed payroll funding.",
    details: ["Cash scenarios", "Accounting & VAT", "Payroll planning"],
    preview: "See today. Prepare for the next 30 days.",
    note: "Forecasts are planning estimates. Exports do not post entries, file tax or pay employees.",
  },
] as const;

/** Switching this illustrative preview never reads an account or creates a workspace. */
export function WorkspaceShowcase() {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const item = publicWorkspaces[active]!;
  return (
    <figure
      className="lp-showcase"
      aria-label="Explore four Valo Pay workspaces with illustrative sample data"
    >
      <div className="lp-showcase-chrome">
        <span>
          <BrandMark /> Workspace preview
        </span>
        <span className="lp-sample-label">
          <span aria-hidden="true" /> Sample data
        </span>
      </div>
      <div
        className="lp-showcase-tabs"
        role="tablist"
        aria-label="Preview a workspace"
      >
        {publicWorkspaces.map((workspace, index) => (
          <button
            key={workspace.name}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`workspace-tab-${index}`}
            aria-selected={active === index}
            tabIndex={active === index ? 0 : -1}
            aria-controls="workspace-preview"
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % 4
                  : event.key === "ArrowLeft"
                    ? (index + 3) % 4
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 3
                        : null;
              if (next !== null) {
                event.preventDefault();
                setActive(next);
                tabs.current[next]?.focus();
              }
            }}
          >
            <workspace.icon aria-hidden="true" />
            <span>{workspace.name}</span>
          </button>
        ))}
      </div>
      <div
        className="lp-showcase-panel"
        role="tabpanel"
        id="workspace-preview"
        aria-labelledby={`workspace-tab-${active}`}
        tabIndex={0}
      >
        <div className="lp-showcase-panel-head">
          <span className="lp-showcase-overline">{item.name}</span>
          <h2>{item.preview}</h2>
        </div>
        {active === 0 && (
          <>
            <div className="lp-showcase-total">
              <div>
                <span>Matched to instalments</span>
                <strong>
                  ₦67,000<span>.00</span>
                </strong>
              </div>
              <span className="lp-preview-status">
                <Check aria-hidden="true" /> 2 matched
              </span>
            </div>
            <ul
              className="lp-showcase-records"
              aria-label="Illustrative payment records"
            >
              <li>
                <span className="lp-person-mark" aria-hidden="true">
                  AO
                </span>
                <span>
                  <strong>Ada Okonkwo</strong>
                  <small>Instalment 1 · Matched</small>
                </span>
                <strong>₦42,000</strong>
              </li>
              <li>
                <span className="lp-person-mark" aria-hidden="true">
                  TB
                </span>
                <span>
                  <strong>Túndé Bakare</strong>
                  <small>Instalment 2 · Matched</small>
                </span>
                <strong>₦25,000</strong>
              </li>
              <li>
                <span className="lp-person-mark is-review" aria-hidden="true">
                  CO
                </span>
                <span>
                  <strong>Chiamaka Obi</strong>
                  <small>Proposed match · Needs review</small>
                </span>
                <strong>₦18,000</strong>
              </li>
            </ul>
          </>
        )}
        {active === 1 && (
          <>
            <div className="lp-showcase-total">
              <div>
                <span>Sample one-time checkout</span>
                <strong>
                  ₦18,000<span>.00</span>
                </strong>
              </div>
              <span className="lp-preview-status is-pending">
                Pending receipt
              </span>
            </div>
            <ol
              className="lp-payment-stages"
              aria-label="Illustrative payment verification steps"
            >
              <li>
                <Check aria-hidden="true" />
                <span>
                  <strong>Review the payment</strong>
                  <small>Amount, recipient and instalment are linked.</small>
                </span>
              </li>
              <li>
                <Check aria-hidden="true" />
                <span>
                  <strong>Record authorisation</strong>
                  <small>One payment, with its own permission.</small>
                </span>
              </li>
              <li className="is-current">
                <CircleDot aria-hidden="true" />
                <span>
                  <strong>Wait for receipt evidence</strong>
                  <small>Only a confirmed receipt can be reconciled.</small>
                </span>
              </li>
            </ol>
          </>
        )}
        {active === 2 && (
          <>
            <div className="lp-credit-state">
              <span>
                <FileCheck2 aria-hidden="true" />
              </span>
              <div>
                <small>Illustrative assessment</small>
                <strong>Ready for lender review</strong>
                <p>
                  The evidence supports the conversation. The lender makes the
                  decision.
                </p>
              </div>
            </div>
            <dl className="lp-credit-checks">
              <div>
                <dt>Account-read permission</dt>
                <dd>Separate grant</dd>
              </div>
              <div>
                <dt>Assessment permission</dt>
                <dd>Separate grant</dd>
              </div>
              <div>
                <dt>Evidence & affordability</dt>
                <dd>Explainable checks</dd>
              </div>
              <div>
                <dt>Final outcome</dt>
                <dd>Independent reviewer</dd>
              </div>
            </dl>
          </>
        )}
        {active === 3 && (
          <>
            <div className="lp-showcase-total">
              <div>
                <span>Sample available business cash</span>
                <strong>
                  ₦24.2<span>m</span>
                </strong>
              </div>
              <span className="lp-preview-status">NGN · Sample SME</span>
            </div>
            <div
              className="lp-cash-scenarios"
              aria-label="Illustrative cash planning scenarios"
            >
              <div>
                <span>Base case · day 30</span>
                <strong>₦30.5m</strong>
                <i aria-hidden="true" style={{ width: "100%" }} />
              </div>
              <div>
                <span>Downside · day 30</span>
                <strong>₦17.58m</strong>
                <i aria-hidden="true" style={{ width: "57.6%" }} />
              </div>
            </div>
            <p className="lp-cash-scenario-note">
              Compare slower receipts with the same committed outgoings.
            </p>
            <div className="lp-cash-tags">
              <span>Accounting drafts</span>
              <span>VAT evidence</span>
              <span>Payroll funding</span>
            </div>
          </>
        )}
        <div className="lp-showcase-panel-foot">
          <p>{item.note}</p>
          <Link href={item.path}>
            Explore {item.name}
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </div>
      </div>
      <figcaption>
        Illustrative sample workflows. No live bank connection or financial
        instruction.
      </figcaption>
    </figure>
  );
}

export function LandingWorkspaces() {
  return (
    <section
      id="what"
      className="lp-section lp-workspaces-section"
      aria-labelledby="workspaces-title"
    >
      <span
        id="connected-banking"
        className="lp-anchor-alias"
        aria-hidden="true"
      />
      <div className="public-container">
        <div className="lp-section-intro lp-split-intro">
          <p className="lp-section-kicker">
            One platform. Four focused workspaces.
          </p>
          <h2 id="workspaces-title">
            Start with the work{" "}
            <br />
            you need to do.
          </h2>
          <p>
            Follow a collection, inspect a credit assessment or plan business
            cash. Each workspace keeps its own records, permissions and review
            steps.
          </p>
        </div>
        <div className="lp-workspace-grid">
          {publicWorkspaces.map((item, index) => (
            <article key={item.name} className="lp-workspace-card">
              <div className="lp-workspace-card-top">
                <span className="lp-icon-tile">
                  <item.icon aria-hidden="true" />
                </span>
                <span>0{index + 1}</span>
              </div>
              <p className="lp-workspace-category">{item.name}</p>
              <h3>{item.lead}</h3>
              <p>{item.description}</p>
              <ul aria-label={`${item.name} features`}>
                {item.details.map((detail) => (
                  <li key={detail}>
                    <Check aria-hidden="true" />
                    {detail}
                  </li>
                ))}
              </ul>
              <Link href={item.path}>
                Explore {item.name}
                <ArrowRight aria-hidden="true" />
              </Link>
            </article>
          ))}
        </div>
        <div className="lp-permission-bridge">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>Connected by context. Governed by permission.</strong>
            <p>
              A permission to read data does not authorise a payment, a lending
              decision or an accounting entry.
            </p>
          </div>
          <Link href="/connections">
            View permissions & readiness <ArrowUpRight aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
