import { describe, expect, it } from "vitest";
import { formatCompactDate, formatDate, formatKobo } from "@/lib/formatters";

describe("formatters", () => {
  it("shows kobo as naira and instants in West Africa Time", () => {
    expect(formatKobo(2_500_000)).toBe("₦25,000.00");
    expect(formatKobo(0)).toBe("₦0.00");
    expect(formatDate("2027-06-28T06:00:00.000Z")).toBe("28 Jun 2027, 07:00");
    expect(formatCompactDate("2027-06-28T06:00:00.000Z")).toBe("28 Jun 2027");
    expect(formatDate("Not closed yet")).toBe("Not closed yet");
    expect(formatDate("")).toBe("Not recorded");
    expect(formatCompactDate("nonsense")).toBe("Not recorded");
  });
});
