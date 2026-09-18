import { describe, expect, it } from "vitest";
import { formatCompactDate, formatCount, formatDate, formatKobo, formatNumber } from "@/lib/formatters";

describe("formatters", () => {
  it("shows kobo as naira and instants in West Africa Time, with the zone named", () => {
    expect(formatKobo(2_500_000)).toBe("₦25,000.00");
    expect(formatKobo(0)).toBe("₦0.00");
    expect(formatDate("2027-06-28T06:00:00.000Z")).toBe("28 Jun 2027, 07:00 WAT");
    expect(formatCompactDate("2027-06-28T06:00:00.000Z")).toBe("28 Jun 2027");
    expect(formatDate("Not closed yet")).toBe("Not closed yet");
    expect(formatDate("")).toBe("Not recorded");
    expect(formatCompactDate("nonsense")).toBe("Not recorded");
  });

  it("keeps Lagos time whatever zone the device is in: an evening in UTC is already the next day", () => {
    expect(formatDate("2026-09-18T23:30:00.000Z")).toBe("19 Sept 2026, 00:30 WAT");
    expect(formatCompactDate("2026-09-18T23:30:00.000Z")).toBe("19 Sept 2026");
  });

  it("shows a day as a day, with no invented time", () => {
    expect(formatDate("2026-09-20")).toBe("20 Sept 2026");
    expect(formatCompactDate("2026-09-20")).toBe("20 Sept 2026");
  });

  it("groups numbers the market's way and gives a count its noun in the right number", () => {
    expect(formatNumber(20000)).toBe("20,000");
    expect(formatCount(1, "item")).toBe("1 item");
    expect(formatCount(0, "item")).toBe("0 items");
    expect(formatCount(2, "entry", "entries")).toBe("2 entries");
    expect(formatCount(1234, "record")).toBe("1,234 records");
  });
});
