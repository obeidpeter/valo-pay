import {
  paystackTestSecretKey,
  paystackConnections,
} from "../../artifacts/api-server/src/providers/paystack-ingress-config";

const usage =
  "Use: verify-paystack-event --connection-id OPAQUE_TEST_CONNECTION --event-id SAVED_TEST_EVENT";
let close: (() => Promise<void>) | undefined;
try {
  const given = process.argv.slice(2),
    args = given[0] === "--" ? given.slice(1) : given;
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    process.exit(0);
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    if (
      !["--connection-id", "--event-id"].includes(name) ||
      flags.has(name) ||
      !args[index + 1] ||
      args[index + 1]!.startsWith("--")
    )
      throw new Error(usage);
    flags.set(name, args[index + 1]!);
  }
  const connectionId = flags.get("--connection-id") ?? "",
    eventId = flags.get("--event-id") ?? "";
  if (
    !/^[a-f0-9]{64}$/.test(connectionId) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(eventId)
  )
    throw new Error(usage);
  // Refuse missing/live credentials and unknown mappings before importing any DB
  // runtime. Keys are never read from CLI arguments and identifiers are not echoed.
  paystackTestSecretKey();
  if (!Object.hasOwn(paystackConnections(), connectionId))
    throw new Error("The test connection is not configured.");
  const store =
    await import("../../artifacts/api-server/src/lib/valopay-store");
  close = store.closeDatabase;
  const { verifyStoredPaystackTestEvent } =
    await import("../../artifacts/api-server/src/lib/paystack-verification");
  console.log(
    JSON.stringify(
      await verifyStoredPaystackTestEvent(connectionId, eventId),
      null,
      2,
    ),
  );
} catch {
  console.error(
    JSON.stringify({
      result: "not_verified",
      message:
        "Check the explicit test connection, saved event, synthetic expectation and test-only configuration. No instruction was sent.",
      usage,
    }),
  );
  process.exitCode = 1;
} finally {
  await close?.();
}
