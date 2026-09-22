import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ProductWalkthrough,
  PILOT_CONTACT,
} from "@/components/product-walkthrough";
import { LandingSections } from "@/components/landing-sections";

afterEach(() => vi.unstubAllEnvs());

describe("public connected-product walkthrough", () => {
  it("requires a fresh choice to load each workspace and restores focus when closing it", async () => {
    const user = userEvent.setup();
    render(<ProductWalkthrough />);
    const choices = screen.getByRole("group", {
      name: "Choose a product screen",
    });
    const products = [
      { name: "Collections", route: "/overview" },
      { name: "Pay-by-bank", route: "/pay-by-bank" },
      { name: "Credit Desk", route: "/credit-desk" },
      { name: "Cash Desk", route: "/cash-desk" },
    ];
    expect(document.querySelector("iframe")).toBeNull();
    for (const product of products) {
      await user.click(
        within(choices).getByRole("button", { name: new RegExp(product.name) }),
      );
      expect(document.querySelector("iframe")).toBeNull();
      expect(
        screen
          .getByRole("link", { name: "Open full screen" })
          .getAttribute("href"),
      ).toBe(product.route);
      await user.click(
        screen.getByRole("button", { name: "Load interactive preview" }),
      );
      const frame = screen.getByTitle(
        `Interactive Valo Pay ${product.name.toLowerCase()} preview — sample data`,
      );
      expect(frame.getAttribute("src")).toBe(`${product.route}?embedded=1`);
      fireEvent.load(frame);
      expect(screen.getByRole("status").textContent).toContain(
        `${product.name} preview loaded`,
      );
    }
    await user.click(screen.getByRole("button", { name: "Close preview" }));
    expect(document.querySelector("iframe")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Load interactive preview" }),
      ),
    );
  });

  it("keeps connected workspace previews inside a mounted deployment path", async () => {
    vi.stubEnv("BASE_URL", "/pilot/");
    const user = userEvent.setup();
    render(<ProductWalkthrough />);
    await user.click(screen.getByRole("button", { name: /04 · Cash Desk/ }));
    await user.click(
      screen.getByRole("button", { name: "Load interactive preview" }),
    );
    expect(
      screen
        .getByTitle("Interactive Valo Pay cash desk preview — sample data")
        .getAttribute("src"),
    ).toBe("/pilot/cash-desk?embedded=1");
  });

  it("keeps account-transfer and live-connection limits available in native FAQ disclosures", async () => {
    const user = userEvent.setup();
    render(<LandingSections signedIn={false} />);
    const question = screen.getByText(
      "Do I need to sign in or connect a bank?",
    );
    const disclosure = question.closest("details")!;
    expect(disclosure.open).toBe(false);
    await user.click(question);
    expect(disclosure.open).toBe(true);
    expect(disclosure.textContent).toContain(
      "anonymous sample work does not transfer",
    );
    await user.click(question);
    expect(disclosure.open).toBe(false);
    expect(document.querySelector("iframe")).toBeNull();
    const contact = new URL(PILOT_CONTACT);
    expect(contact.pathname).toBe("obeidpeter1@gmail.com");
    expect(contact.searchParams.get("body")).toContain(
      "Collections / Pay-by-bank / Credit Desk / Cash Desk",
    );
    expect(contact.searchParams.get("body")).toContain("names only");
  });
});
