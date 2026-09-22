import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { useUrlPagination } from "@/lib/use-url-pagination";

function Pager() {
  const pagination = useUrlPagination("lender-1");
  return <button onClick={() => pagination.setPage(1)}>Next from {pagination.page + 1}</button>;
}

describe("url pagination under a base path", () => {
  it("navigates relative to the router base instead of repeating it", () => {
    const location = memoryLocation({ path: "/app/mandates", record: true });
    render(
      <Router base="/app" hook={location.hook} searchHook={location.searchHook}>
        <Pager />
      </Router>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next from 1" }));
    expect(location.history.at(-1)).toBe("/app/mandates?page=2&size=25&lender=lender-1");
    expect(screen.getByRole("button", { name: "Next from 2" })).toBeTruthy();
  });
});
