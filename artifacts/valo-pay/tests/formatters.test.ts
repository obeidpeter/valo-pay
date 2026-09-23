import { describe, expect, it } from "vitest";
import { formatCompactDate, formatCount, formatDate, formatKobo, formatNumber, formatPercent, formatPercentagePoints } from "@/lib/formatters";

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

  it("shows every whole number of kobo exactly, to the largest safe integer, signs and zero included", () => {
    expect(formatKobo(9_007_199_254_740_991)).toBe("₦90,071,992,547,409.91");
    expect(formatKobo(-9_007_199_254_740_991)).toBe("-₦90,071,992,547,409.91");
    // Above 2^46 naira a float step is wider than a kobo: dividing by 100 showed .02 here.
    expect(formatKobo(7_036_874_417_766_401)).toBe("₦70,368,744,177,664.01");
    expect(formatKobo(7_000_000_000_000_001)).toBe("₦70,000,000,000,000.01");
    expect(formatKobo(1)).toBe("₦0.01");
    expect(formatKobo(-1)).toBe("-₦0.01");
    expect(formatKobo(-250_050)).toBe("-₦2,500.50");
    expect(formatKobo(0)).toBe("₦0.00");
    expect(formatKobo(-0)).toBe("₦0.00");
  });

  it("keeps the output it had for ordinary amounts (negative zero, pinned above, aside)", () => {
    const before = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 2 });
    let seed = 20260923;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const amounts = [...Array.from({ length: 4001 }, (_, i) => i - 2000), ...Array.from({ length: 4000 }, (_, i) => Math.floor(next() * 10 ** (2 + (i % 14))) * (i % 3 ? 1 : -1) + 0)];
    for (const kobo of amounts) expect(formatKobo(kobo)).toBe(before.format(kobo / 100));
  });

  it("shows ratios as percentages and differences in percentage points, grouped the market's way", () => {
    expect(formatPercent(0.123, 1)).toBe("12.3%");
    expect(formatPercent(0.5, 1)).toBe("50.0%");
    expect(formatPercent(12.345, 1)).toBe("1,234.5%");
    expect(formatPercent(0.87)).toBe("87%");
    expect(formatPercent(30 / 10000)).toBe("0.3%");
    expect(formatPercent(750 / 10000)).toBe("7.5%");
    expect(formatPercent(25 / 10000)).toBe("0.25%");
    expect(formatPercentagePoints(0.085)).toBe("8.5 percentage points");
    expect(formatPercentagePoints(-0.0123)).toBe("-1.2 percentage points");
  });

  it("groups numbers the market's way and gives a count its noun in the right number", () => {
    expect(formatNumber(20000)).toBe("20,000");
    expect(formatCount(1, "item")).toBe("1 item");
    expect(formatCount(0, "item")).toBe("0 items");
    expect(formatCount(2, "entry", "entries")).toBe("2 entries");
    expect(formatCount(1234, "record")).toBe("1,234 records");
  });
});
