import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  assessCredit,
  createSyntheticCreditInput,
} from "../../api-server/src/domain/connected-credit";
import CreditDeskPage from "@/pages/credit-desk";

const mocks = vi.hoisted(() => ({
  api: {} as Record<string, any>,
  merchantId: "lender-a",
}));
vi.mock("@/lib/connected", () => ({ useConnected: () => mocks.api }));
vi.mock("@/lib/workspace-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-context")>()),
  useWorkspace: () => ({ merchantId: mocks.merchantId }),
}));
const now = "2026-09-21T10:00:00.000Z";
function assessment(
  scenario: "ready" | "high_commitments" | "thin_file" = "ready",
) {
  const input = createSyntheticCreditInput({
    tenantId: "lender-a",
    applicantId: "customer-a",
    applicationRef: "SYN-LOAN",
    now,
    scenario,
  });
  return {
    id: "assessment-a",
    customerId: "customer-a",
    customerName: "Sample Applicant",
    createdAt: now,
    createdBy: "Sandbox Operations",
    scenario,
    permissionRestricted: false,
    result: assessCredit(input, {
      tenantId: "lender-a",
      actorId: "Sandbox Operations",
      permissions: ["credit:assess"],
      now,
    }),
    reviews: [],
  };
}
beforeEach(() => {
  mocks.merchantId = "lender-a";
  mocks.api = {
    isLoading: false,
    error: null,
    pending: false,
    canWrite: true,
    run: vi.fn().mockResolvedValue(undefined),
    refetch: vi.fn(),
    data: {
      credit: {
        canAssess: true,
        canReview: false,
        actor: "Sandbox Operations",
        customers: [
          {
            id: "customer-a",
            name: "Sample Applicant",
            reference: "SYN-CUSTOMER",
            permissions: { accountRead: true, creditAssessment: true },
          },
        ],
        assessments: [],
        model: {
          name: "Illustrative salaried rulecard",
          version: "illustrative-rulecard-v1",
          validation: "Not validated for real lending",
          weights: [],
        },
        gate: {
          id: "G-CREDIT",
          enabled: false,
          requirements: ["Independent credit validation"],
        },
      },
    },
  };
});
describe("Credit Desk synthetic journeys", () => {
  it("shows missing separate permissions and a working setup destination", () => {
    mocks.api.data.credit.customers[0].permissions.creditAssessment = false;
    render(<CreditDeskPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Credit Desk" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Set up sample permissions/ })
        .getAttribute("href"),
    ).toBe("/connections");
    expect(screen.getByText(/Credit assessment: Required/)).toBeTruthy();
    expect(screen.getByText(/No real borrower is assessed/)).toBeTruthy();
    expect(mocks.api.run).not.toHaveBeenCalled();
  });
  it("submits explicit terms in integer kobo only after the operator gives a reason", async () => {
    const user = userEvent.setup();
    render(<CreditDeskPage />);
    await user.type(
      screen.getByLabelText("Reason for this assessment"),
      "Check affordability for the sample application",
    );
    await user.click(
      screen.getByRole("button", { name: /Run sample assessment/ }),
    );
    await waitFor(() =>
      expect(mocks.api.run).toHaveBeenCalledWith(
        "credit.assess",
        {
          customerId: "customer-a",
          scenario: "ready",
          principalKobo: 24_000_000,
          repaymentKobo: 9_000_000,
          termMonths: 3,
        },
        undefined,
        "Check affordability for the sample application",
      ),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "new immutable sample assessment",
    );
  });
  it("explains score and separates source provenance from the lending recommendation", async () => {
    mocks.api.data.credit.assessments = [assessment()];
    const user = userEvent.setup();
    render(<CreditDeskPage />);
    expect(screen.getByText(/Not a probability of default\./)).toBeTruthy();
    expect(screen.getByText("Why the score looks this way")).toBeTruthy();
    expect(screen.getByText("Ready for lender review")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Evidence" }));
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      "credit-tab-evidence",
    );
    expect(screen.getByText("Immutable evidence fingerprint")).toBeTruthy();
    expect(screen.getByText("90 days")).toBeTruthy();
  });
  it("does not translate thin history into a zero score or an enabled approval", () => {
    mocks.api.data.credit.assessments = [assessment("thin_file")];
    mocks.api.data.credit.actor = "Sandbox Finance";
    mocks.api.data.credit.canReview = true;
    render(<CreditDeskPage />);
    expect(screen.getByText("Score unavailable")).toBeTruthy();
    expect(
      (
        screen.getByRole("option", {
          name: "Record sample approval",
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("option", {
          name: "Record sample decline",
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("combobox", {
          name: "Reviewer outcome",
        }) as HTMLSelectElement
      ).value,
    ).toBe("");
  });
  it("blocks self-review in the interface and requires an explicit independent outcome", () => {
    mocks.api.data.credit.assessments = [assessment()];
    mocks.api.data.credit.canReview = true;
    render(<CreditDeskPage />);
    expect(
      (
        screen.getByRole("combobox", {
          name: "Reviewer outcome",
        }) as HTMLSelectElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/A different reviewer must complete this step/),
    ).toBeTruthy();
  });
  it("requires meaningful override evidence and keeps server rejection visible", async () => {
    mocks.api.data.credit.assessments = [assessment("high_commitments")];
    mocks.api.data.credit.actor = "Sandbox Finance";
    mocks.api.data.credit.canReview = true;
    mocks.api.run.mockRejectedValue(
      new Error("Current permission changed. Refresh the assessment."),
    );
    const user = userEvent.setup();
    render(<CreditDeskPage />);
    await user.selectOptions(
      screen.getByLabelText("Reviewer outcome"),
      "approve",
    );
    await user.type(
      screen.getByLabelText("What did you review?"),
      "Reviewed each source and all repayment commitments.",
    );
    await user.type(
      screen.getByLabelText("Explanation for the applicant"),
      "This exercise depends on additional verified evidence.",
    );
    await user.type(
      screen.getByLabelText("Reason for overriding the policy"),
      "Additional synthetic evidence was independently examined and documented.",
    );
    await user.click(
      screen.getByRole("button", { name: "Record sample review" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Current permission changed",
      ),
    );
    expect(mocks.api.run.mock.calls[0][1]).toMatchObject({
      expectedAssessmentVersion: 1,
      outcome: "approve",
      overrideRationale:
        "Additional synthetic evidence was independently examined and documented.",
    });
  });
  it("clears partially entered terms and review text when the lender changes", async () => {
    const user = userEvent.setup(),
      view = render(<CreditDeskPage />);
    await user.type(
      screen.getByLabelText("Reason for this assessment"),
      "Private note from the previous lender",
    );
    mocks.merchantId = "lender-b";
    view.rerender(<CreditDeskPage />);
    expect(
      (
        screen.getByLabelText(
          "Reason for this assessment",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });
});
