// Offline checks of the API's edge (the 23 September 2026 audit, security items 1, 2, 6, 8 and 9 and
// operations item 4; see docs/security-review.md): the request and sandbox limits by principal and
// network (an IPv6 client by its /64), bounded limiter maps, health that answers without Clerk and a
// readiness check a burst cannot multiply, request ids only from a configured edge, Clerk sessions
// accepted only for the configured origins, a Clerk proxy that tells Clerk nothing a client wrote,
// a staff host that does not start without Clerk, and the __Host- sandbox cookie.
// No Clerk service and no database: a local socket that closes every connection stands in for
// PostgreSQL, so readiness fails fast and counts its connections; Clerk checks tokens this test signs.
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { spawnSync } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import https from "node:https";
import { once } from "node:events";
import { join } from "node:path";
import express from "express";

let checks = 0;
const failures: string[] = [];
/** Runs one group of checks; a failure is recorded and the next group still runs, so every gap shows at once. */
async function section(title: string, run: () => void | Promise<void>) {
  try { await run(); } catch (error) { failures.push(`${title}: ${error instanceof Error ? error.message : String(error)}`); }
}

// A database that accepts a connection and closes it: every query fails at once, and each connection is counted.
let connections = 0;
const sockets = new Set<Socket>();
const database = createServer((socket) => { connections++; sockets.add(socket); socket.destroy(); });
database.listen(0, "127.0.0.1");
await once(database, "listening");
const databasePort = (database.address() as { port: number }).port;
process.env["DATABASE_URL"] = `postgres://postgres@127.0.0.1:${databasePort}/valopay-unused`;
process.env["LOG_LEVEL"] = "silent";
// Clerk would otherwise report its development-instance use over the network.
process.env["CLERK_TELEMETRY_DISABLED"] = "1";
const edgeNames = ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "CLERK_JWT_KEY", "VALOPAY_STAFF_ACCESS", "VALOPAY_STAFF_ORIGINS", "VALOPAY_STAFF_ISSUER", "VALOPAY_APP_ORIGINS", "REPLIT_DOMAINS", "VALOPAY_EDGE_REQUEST_ID"] as const;
for (const name of edgeNames) delete process.env[name];
const { default: app, requestIdFor } = await import("../src/app.js");
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
/** A request as the host's edge forwards it: one trusted hop, so the client address is X-Forwarded-For's last entry. */
const get = (path: string, from: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { "X-Forwarded-For": from, ...headers } });
const drain = async (response: Response) => { await response.arrayBuffer(); return response; };
const tally = (statuses: number[]) => statuses.reduce<Record<number, number>>((all, status) => ({ ...all, [status]: (all[status] ?? 0) + 1 }), {});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const token = (fill: string) => fill.repeat(64);

try {
  // ---- Operations item 4: health, readiness and the sandbox need no Clerk ----
  await section("health and the sandbox without Clerk", async () => {
    const health = await get("/api/healthz", "192.0.2.10");
    assert.equal(health.status, 200, "liveness answers without CLERK_SECRET_KEY");
    assert.equal(((await health.json()) as { status: string }).status, "ok");
    const ready = await get("/api/readyz", "192.0.2.10");
    assert.deepEqual([ready.status, ((await ready.json()) as { status: string }).status], [503, "degraded"], "readiness says the database is not ready, not that Clerk is missing");
    const workspace = await get("/api/v1/workspace", "192.0.2.10");
    const body = (await workspace.json()) as { error: string };
    assert.equal(workspace.status, 503, "without Clerk every request is an anonymous sandbox; here the database is unreachable");
    assert.doesNotMatch(body.error, /Clerk/);
    assert.match(workspace.headers.get("set-cookie") ?? "", /^valopay_sandbox=[a-f0-9]{64};/, "an anonymous visitor is given a sandbox cookie");
    checks += 6;
  });

  // ---- Security item 6: a burst of readiness probes shares one database round trip, and health has its own limit ----
  await section("readiness coalesced and health limited", async () => {
    await sleep(1_100); // past the reuse of the check above
    connections = 0;
    const burst = await Promise.all(Array.from({ length: 40 }, () => get("/api/readyz", "203.0.113.9").then(drain)));
    assert.deepEqual(tally(burst.map((r) => r.status)), { 503: 40 }, "every probe gets the one check's answer");
    assert.equal(connections, 1, `a burst of 40 probes makes one database connection, not one each (${connections})`);
    const statuses: number[] = [];
    // 121 checks from 121 addresses in one IPv6 /64: one network, one limit.
    for (let i = 1; i <= 121; i++) statuses.push((await drain(await get("/api/healthz", `2001:db8:77:1::${i.toString(16)}`))).status);
    assert.deepEqual(tally(statuses), { 200: 120, 429: 1 }, "120 health checks a minute per network");
    const refused = await get("/api/healthz", "2001:db8:77:1:ffff::1");
    assert.equal(refused.headers.get("retry-after"), "60");
    assert.equal(((await refused.json()) as { requestId?: string }).requestId, refused.headers.get("x-request-id"));
    assert.equal((await drain(await get("/api/healthz", "2001:db8:77:2::1"))).status, 200, "another /64 has its own limit");
    checks += 6;
  });

  // ---- Security item 8: X-Request-Id is kept only when the deployment says its edge sets it ----
  await section("request ids", async () => {
    const quoted = await drain(await get("/api/healthz", "192.0.2.11", { "X-Request-Id": "support-ticket-4711" }));
    assert.notEqual(quoted.headers.get("x-request-id"), "support-ticket-4711", "a client cannot reuse a reference someone else quoted");
    assert.match(quoted.headers.get("x-request-id") ?? "", /^[0-9a-f]{16}$/);
    assert.match(requestIdFor({ headers: { "x-request-id": "edge-7f3a9c2b" } }, false), /^[0-9a-f]{16}$/);
    assert.equal(requestIdFor({ headers: { "x-request-id": "edge-7f3a9c2b" } }, true), "edge-7f3a9c2b", "an edge that sets the id is believed");
    process.env["VALOPAY_EDGE_REQUEST_ID"] = "on";
    try {
      const kept = await drain(await get("/api/healthz", "192.0.2.11", { "X-Request-Id": "edge-0123456789" }));
      assert.equal(kept.headers.get("x-request-id"), "edge-0123456789", "with VALOPAY_EDGE_REQUEST_ID=on the edge's id is kept");
    } finally { delete process.env["VALOPAY_EDGE_REQUEST_ID"]; }
    checks += 5;
  });

  // ---- Security item 1: an IPv6 client is counted by its /64, whichever address it picks ----
  await section("request limit per network", async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 301; i++) statuses.push((await drain(await get("/api/v1/no-such-resource", `2001:db8:1:2::${i.toString(16)}`))).status);
    assert.deepEqual(tally(statuses), { 404: 300, 429: 1 }, "300 requests a minute for a client with no principal, counted by its /64");
    assert.equal((await drain(await get("/api/v1/no-such-resource", "2001:db8:1:3::1"))).status, 404, "another /64 has its own quota");
    checks += 2;
  });

  // ---- The staff decision: Clerk's sessions are accepted only from configured origins, and each person has their own quota ----
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signed = (claims: Record<string, unknown>) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000), body = `${encode({ alg: "RS256", typ: "JWT", kid: "edge-test" })}.${encode({ iat: now - 5, nbf: now - 5, exp: now + 600, ...claims })}`;
    return `${body}.${createSign("RSA-SHA256").update(body).sign(privateKey).toString("base64url")}`;
  };
  Object.assign(process.env, {
    CLERK_SECRET_KEY: "sk_test_placeholder", CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`,
    CLERK_JWT_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(), VALOPAY_APP_ORIGINS: "https://pilot.example",
  });
  await section("Clerk sessions: configured origins and a quota per person", async () => {
    const session = (sub: string, azp: string) => ({ Authorization: `Bearer ${signed({ sub, sid: `sess_${sub}`, azp })}` });
    const foreign = await drain(await get("/api/v1/workspace", "192.0.2.20", session("user_foreign", "https://evil.example")));
    assert.match(foreign.headers.get("set-cookie") ?? "", /valopay_sandbox=/, "a session minted for another origin is not accepted outside staff mode: the request is anonymous");
    const own = await drain(await get("/api/v1/workspace", "192.0.2.20", session("user_pilot", "https://pilot.example")));
    assert.equal(own.status, 503);
    assert.equal(own.headers.get("set-cookie"), null, "a session for the configured origin is signed in: no sandbox cookie");
    // Two colleagues behind one address: each has 300 a minute.
    const first: number[] = [];
    for (let i = 0; i < 301; i++) first.push((await drain(await get("/api/v1/no-such-resource", "198.51.100.40", session("user_a", "https://pilot.example")))).status);
    assert.deepEqual(tally(first), { 404: 300, 429: 1 }, "a signed-in person's own quota");
    assert.equal((await drain(await get("/api/v1/no-such-resource", "198.51.100.40", session("user_b", "https://pilot.example")))).status, 404, "a colleague behind the same address is not refused");
    checks += 5;
  });

  await section("a staff host without Clerk refuses, and still answers health", async () => {
    const savedKey = process.env["CLERK_SECRET_KEY"];
    Object.assign(process.env, { VALOPAY_STAFF_ACCESS: "staging", VALOPAY_STAFF_ORIGINS: "https://pilot.example" });
    delete process.env["CLERK_SECRET_KEY"];
    try {
      const refused = await get("/api/v1/workspace", "192.0.2.30");
      assert.deepEqual([refused.status, ((await refused.json()) as { error: string }).error], [503, "Staff sign-in is not configured on this host."]);
      assert.equal((await drain(await get("/api/healthz", "192.0.2.30"))).status, 200);
    } finally {
      process.env["CLERK_SECRET_KEY"] = savedKey;
      delete process.env["VALOPAY_STAFF_ACCESS"]; delete process.env["VALOPAY_STAFF_ORIGINS"];
    }
    checks += 2;
  });

  // ---- Security item 9: the sandbox cookie ----
  await section("the sandbox cookie", async () => {
    delete process.env["CLERK_SECRET_KEY"];
    const cookies = async (headers: Record<string, string>) => { const response = await drain(await get("/api/v1/workspace", "192.0.2.40", headers)); return { status: response.status, set: response.headers.getSetCookie() }; };
    const fresh = await cookies({ "X-Forwarded-Proto": "https" });
    assert.equal(fresh.set.length, 1);
    assert.match(fresh.set[0]!, /^__Host-valopay_sandbox=[a-f0-9]{64}; Max-Age=2592000; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$/, "on HTTPS the cookie is __Host-: Secure, Path=/, no Domain");
    const moved = await cookies({ "X-Forwarded-Proto": "https", Cookie: `valopay_sandbox=${token("a")}` });
    assert.match(moved.set[0]!, new RegExp(`^__Host-valopay_sandbox=${token("a")};`), "the plain cookie's sandbox moves to the __Host- name, with the same token");
    assert.match(moved.set[1] ?? "", /^valopay_sandbox=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT;/, "and the plain cookie is cleared");
    const legacy = await cookies({ Cookie: `valo_sandbox=${token("b")}` });
    assert.match(legacy.set[0]!, new RegExp(`^valopay_sandbox=${token("b")};`), "on plain HTTP the legacy name moves to valopay_sandbox");
    assert.match(legacy.set[1] ?? "", /^valo_sandbox=; Path=\/; Expires=Thu, 01 Jan 1970/, "and the legacy cookie is cleared");
    const planted = await get("/api/v1/workspace", "192.0.2.40", { Cookie: `valopay_sandbox=${token("c")}; valopay_sandbox=${token("d")}` });
    assert.equal(planted.status, 400, "two different tokens under one name are refused, not guessed between");
    assert.match(((await planted.json()) as { error: string }).error, /two different sandbox cookies/);
    assert.equal(planted.headers.get("set-cookie"), null, "and nothing is issued");
    const hostWins = await cookies({ "X-Forwarded-Proto": "https", Cookie: `valopay_sandbox=${token("e")}; __Host-valopay_sandbox=${token("f")}` });
    assert.match(hostWins.set[0]!, new RegExp(`^__Host-valopay_sandbox=${token("f")};`), "the __Host- cookie, which only this host can set, wins over a plain one beside it");
    assert.match(hostWins.set[1] ?? "", /^valopay_sandbox=;/, "which is cleared");
    checks += 11;
  });
  process.env["CLERK_SECRET_KEY"] = "sk_test_placeholder";

  // ---- Security item 2: the Clerk proxy tells Clerk only what configuration and the trusted hop say ----
  await section("the Clerk proxy", async () => {
    // The request meant for Clerk is sent to a closed local port instead; its headers are read once the proxy has set them.
    const outgoing: Array<{ getHeaders(): Record<string, unknown> }> = [];
    const original = https.request;
    (https as { request: unknown }).request = ((options: { host?: string; hostname?: string; headers?: Record<string, unknown> }, ...rest: unknown[]) => {
      if (!String(options?.host ?? options?.hostname ?? "").includes("clerk")) return (original as (...args: unknown[]) => unknown)(options, ...rest);
      const request = (original as (...args: unknown[]) => { on(event: string, listener: () => void): void; getHeaders(): Record<string, unknown> })({ host: "127.0.0.1", port: 9, path: "/", method: "POST", headers: options.headers });
      request.on("error", () => {});
      outgoing.push(request);
      return request;
    }) as typeof https.request;
    const captured = { get length() { return outgoing.length; }, slice: (from: number) => outgoing.slice(from).map((request) => request.getHeaders()) };
    const savedEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    const { clerkProxyMiddleware, CLERK_PROXY_PATH } = await import("../src/middlewares/clerkProxyMiddleware.js");
    const proxy = express();
    proxy.set("trust proxy", 1);
    proxy.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
    process.env["NODE_ENV"] = savedEnv;
    const proxyServer = proxy.listen(0, "127.0.0.1");
    await once(proxyServer, "listening");
    const proxied = `http://127.0.0.1:${(proxyServer.address() as { port: number }).port}${CLERK_PROXY_PATH}/v1/client/sign_ins`;
    const send = async (headers: Record<string, string>) => { const before = captured.length; const response = await fetch(proxied, { method: "POST", headers }).catch(() => undefined); await sleep(300); return { response, sent: captured.slice(before) }; };
    try {
      process.env["VALOPAY_APP_ORIGINS"] = "https://pilot.example,https://valopay.example";
      const { sent } = await send({ "X-Forwarded-For": "6.6.6.6, 198.51.100.20", "X-Forwarded-Host": "attacker.example, valopay.example", "X-Forwarded-Proto": "http", "X-Real-IP": "6.6.6.6" });
      assert.equal(sent.length, 1, "the request reached Clerk's address (captured, never sent)");
      assert.equal(sent[0]!["x-forwarded-for"], "198.51.100.20", "Clerk sees the address the edge saw, not the client's leftmost entry");
      assert.equal(sent[0]!["clerk-proxy-url"], "https://valopay.example/api/__clerk", "the proxy URL is the configured origin the request's host names");
      assert.equal(sent[0]!["x-forwarded-host"], "valopay.example");
      assert.equal(sent[0]!["x-forwarded-proto"], "https", "and its scheme, never the client's");
      assert.equal(sent[0]!["x-real-ip"], undefined);
      assert.ok(sent[0]!["clerk-secret-key"], "with the secret key, as before");
      const unknown = await send({ "X-Forwarded-For": "198.51.100.21", "X-Forwarded-Host": "attacker.example" });
      assert.equal(unknown.sent[0]!["clerk-proxy-url"], "https://pilot.example/api/__clerk", "a host that is not configured gets the first configured origin");
      delete process.env["VALOPAY_APP_ORIGINS"];
      const off = await send({ "X-Forwarded-For": "198.51.100.22" });
      assert.deepEqual([off.response?.status, off.sent.length], [503, 0], "with no origin configured nothing is proxied");
    } finally {
      (https as { request: unknown }).request = original;
      proxyServer.close();
    }
    checks += 9;
  });

  await section("Clerk options and the sign-in configuration", async () => {
    const { clerkOptions, signInConfiguration, signInEnabled, appOrigins } = await import("../src/lib/staff-access.js");
    const live = `pk_live_${Buffer.from("clerk.pilot.example$").toString("base64").replace(/=+$/, "")}`;
    Object.assign(process.env, { VALOPAY_APP_ORIGINS: "https://pilot.example,https://valopay.example", CLERK_PUBLISHABLE_KEY: live });
    const frontend = (key: string) => Buffer.from(key.split("_")[2]!, "base64").toString();
    const options = clerkOptions({ headers: { "x-forwarded-host": "attacker.example", host: "attacker.example" } });
    assert.deepEqual(options.authorizedParties, ["https://pilot.example", "https://valopay.example"], "authorizedParties are set outside staff mode");
    assert.equal(frontend(options.publishableKey), "clerk.pilot.example$", "the key is derived for a configured host, never the one a client names");
    assert.equal(frontend(clerkOptions({ headers: { "x-forwarded-host": "attacker.example, valopay.example" } }).publishableKey), "clerk.valopay.example$");
    Object.assign(process.env, { VALOPAY_STAFF_ACCESS: "staging", VALOPAY_STAFF_ORIGINS: "https://staff.example" });
    assert.deepEqual(clerkOptions({ headers: {} }).authorizedParties, ["https://staff.example"], "in staff mode the staff policy's origins");
    delete process.env["CLERK_SECRET_KEY"];
    assert.match(signInConfiguration().fatal ?? "", /needs CLERK_SECRET_KEY/, "a staff host without Clerk must not start");
    delete process.env["VALOPAY_STAFF_ACCESS"]; delete process.env["VALOPAY_STAFF_ORIGINS"];
    assert.deepEqual([signInConfiguration(), signInEnabled()], [{}, false], "without Clerk the sandbox runs anonymously, which is fine");
    process.env["CLERK_SECRET_KEY"] = "sk_test_placeholder";
    process.env["VALOPAY_APP_ORIGINS"] = "pilot.example";
    assert.match(signInConfiguration().fatal ?? "", /VALOPAY_APP_ORIGINS must list HTTPS origins/);
    assert.throws(appOrigins, (error: { status?: number }) => error.status === 503, "and a request is refused, not served without the check");
    delete process.env["VALOPAY_APP_ORIGINS"];
    assert.match(signInConfiguration().warning ?? "", /sign-in is off/, "Clerk with no origin to accept sessions from runs with sign-in off");
    assert.equal(signInEnabled(), false);
    process.env["REPLIT_DOMAINS"] = "valopay.replit.app,Valopay.example";
    assert.deepEqual([appOrigins(), signInEnabled(), signInConfiguration()], [["https://valopay.replit.app", "https://valopay.example"], true, {}], "on Replit the deployment's domains serve when nothing else is configured");
    delete process.env["REPLIT_DOMAINS"];
    checks += 12;
  });

  // ---- Operations item 4: in staff mode a missing CLERK_SECRET_KEY stops startup with one fatal line ----
  await section("a staff host without Clerk does not start", () => {
    const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: "test", LOG_LEVEL: "info", PORT: "39217", VALOPAY_STAFF_ACCESS: "staging", VALOPAY_STAFF_ORIGINS: "https://pilot.example", VALOPAY_CLOSE_SCHEDULER: "off", LOG_FILE: undefined, LOG_FORMAT: undefined };
    delete env["CLERK_SECRET_KEY"];
    const tsx = join(import.meta.dirname, "..", "..", "..", "scripts", "node_modules", "tsx", "dist", "cli.mjs");
    const run = spawnSync(process.execPath, [tsx, join(import.meta.dirname, "..", "src", "index.ts")], { env, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(run.status, 1, `the process exits (status ${run.status}, signal ${run.signal})`);
    const lines = run.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.map((line) => [line["level"], line["event"]]), [[60, "server.misconfigured"]], "with one fatal line and nothing else logged");
    assert.match(String(lines[0]!["msg"]), /needs CLERK_SECRET_KEY/);
    checks += 3;
  });
} finally {
  server.close();
  database.close();
  for (const socket of sockets) socket.destroy();
}

// ---- Security item 1: the limits by network, principal and process, and maps that stay bounded ----
await section("client networks", async () => {
  const { clientNetwork } = await import("../src/lib/request-limits.js");
  assert.equal(clientNetwork("198.51.100.7"), "198.51.100.7", "an IPv4 address is its own network");
  assert.equal(clientNetwork("::ffff:198.51.100.7"), "198.51.100.7", "an IPv4-mapped address is its IPv4 address");
  for (const address of ["2001:db8:5:6::1", "2001:DB8:5:6:ffff:ffff:ffff:ffff", "2001:db8:5:6:0:0:0:2", "2001:db8:5:6::1%eth0"]) assert.equal(clientNetwork(address), "2001:db8:5:6::/64", `${address} is in its /64`);
  assert.equal(clientNetwork("2001:db8:5:7::1"), "2001:db8:5:7::/64");
  assert.equal(clientNetwork("2001:db8:5:7::1", 48), "2001:db8:5::/48", "and its /48");
  assert.equal(clientNetwork("::1"), "0:0:0:0::/64");
  assert.equal(clientNetwork("64:ff9b::198.51.100.7"), "64:ff9b:0:0::/64", "an embedded IPv4 tail is part of the address");
  assert.equal(clientNetwork(undefined), "unknown");
  assert.equal(clientNetwork("not an address"), "invalid", "and every value that is not an address shares one key");
  assert.equal(clientNetwork("2001:db8:1:2:0:10000:0:1"), "invalid");
  checks += 13;
});

await section("bounded counters", async () => {
  const { createWindowCounter, createRecentSet } = await import("../src/lib/request-limits.js");
  const counter = createWindowCounter({ limit: 2, windowMs: 1_000, maxKeys: 3 });
  assert.deepEqual([counter.take("a", 0), counter.take("a", 10), counter.take("a", 20), counter.refusals("a"), counter.take("a", 30), counter.refusals("a")], [true, true, false, 1, false, 2], "the limit, and each refusal counted so it is logged once");
  counter.take("b", 100); counter.take("c", 200);
  counter.take("d", 300);
  assert.deepEqual([counter.size, counter.remaining("a", 300), counter.remaining("d", 300)], [3, 2, 1], "a full map forgets the window that started first; it never grows past its bound");
  counter.take("e", 5_000);
  assert.equal(counter.size, 3, "a request does not sweep: ended windows wait for the timer");
  counter.sweep(5_000);
  assert.equal(counter.size, 1, "the sweep drops the ended windows");
  assert.equal(counter.remaining("e", 5_000), 1);
  const recent = createRecentSet({ idleMs: 1_000, maxKeys: 2 });
  recent.add("x", 0); recent.add("y", 10); recent.add("x", 20); recent.add("z", 30);
  assert.deepEqual([recent.has("x", 40), recent.has("y", 40), recent.has("z", 40), recent.has("x", 1_100)], [true, false, true, false], "seen again keeps a key; a full set forgets the least recent; idle keys expire");
  recent.sweep(1_025);
  assert.equal(recent.size, 1);
  checks += 7;
});

await section("new sandboxes per network, per /48 and per process", async () => {
  const { createSandboxCreationLimits, creationRefusalMessage } = await import("../src/lib/creation-limit.js");
  const limits = createSandboxCreationLimits();
  const oneSixtyFour = Array.from({ length: 30 }, (_, i) => limits.take(`2001:db8:5:6::${i + 1}`, 0));
  assert.deepEqual([oneSixtyFour.filter((r) => r === undefined).length, oneSixtyFour.at(-1)], [20, "network"], "30 first visits from one /64 start 20 sandboxes");
  const site = createSandboxCreationLimits();
  const fourSixtyFours = Array.from({ length: 4 }, (_, n) => Array.from({ length: 20 }, (_, i) => site.take(`2001:db8:9:${n}::${i + 1}`, 0))).flat();
  assert.deepEqual([fourSixtyFours.filter((r) => r === undefined).length, fourSixtyFours.at(-1)], [60, "network"], "a /48 starts at most 60 an hour, whichever /64s they come from");
  const everyone = createSandboxCreationLimits();
  const many = Array.from({ length: 301 }, (_, i) => everyone.take(`2001:db8:${(i + 16).toString(16)}::1`, 0));
  assert.deepEqual([many.filter((r) => r === undefined).length, many.at(-1)], [300, "instance"], "one process starts at most 300 an hour");
  assert.equal(everyone.take("2001:db8:ffff::1", 3_600_000), undefined, "the next hour starts afresh");
  assert.match(creationRefusalMessage("network"), /your network/);
  assert.match(creationRefusalMessage("instance"), /this server/);
  const ipv4 = createSandboxCreationLimits();
  assert.equal(Array.from({ length: 21 }, () => ipv4.take("198.51.100.7", 0)).filter((r) => r === undefined).length, 20, "an IPv4 address keeps its 20");
  checks += 7;
});

await section("request limits per principal and per network", async () => {
  const { createRequestLimits, createRecentSet } = await import("../src/lib/request-limits.js");
  const { sandboxPrincipal } = await import("../src/lib/sandbox-cookie.js");
  const sandboxes = createRecentSet({ idleMs: 60_000 });
  const limits = createRequestLimits({ principalLimit: 3, networkLimit: 12, sandboxes });
  const warned: unknown[] = [];
  const through = (handler: typeof limits.network, cookie?: string, ip = "2001:db8:44:1::1") => {
    let status = 0, passed = false;
    const req = { ip, secure: false, headers: cookie ? { cookie } : {}, id: "edge-test", log: { warn: (fields: unknown) => warned.push(fields) } };
    const res = { setHeader() { return res; }, status(code: number) { status = code; return res; }, json() { return res; } };
    handler(req as never, res as never, () => { passed = true; });
    return passed ? 200 : status;
  };
  const known = token("1"), unknown = token("2");
  sandboxes.add(sandboxPrincipal(known));
  assert.deepEqual(Array.from({ length: 4 }, () => through(limits.principal, `valopay_sandbox=${known}`)), [200, 200, 200, 429], "a sandbox this process has served has its own quota");
  assert.deepEqual(Array.from({ length: 4 }, () => through(limits.principal)), [200, 200, 200, 429], "a request with no principal counts as its network");
  assert.equal(through(limits.principal, `valopay_sandbox=${unknown}`), 429, "an invented cookie is only a claim: it counts as the network too");
  assert.deepEqual(warned, [{ event: "request.refused", reason: "rate_limit", limit: "principal" }, { event: "request.refused", reason: "rate_limit", limit: "principal" }], "one warning per key and window");
  const ceiling = Array.from({ length: 13 }, (_, i) => through(limits.network, undefined, `2001:db8:44:1::${i + 10}`));
  assert.deepEqual([ceiling.filter((s) => s === 200).length, ceiling.at(-1)], [12, 429], "the network's ceiling holds whatever principals it rotates");
  checks += 5;
});

await section("readiness reused for a second, its warning once per check", async () => {
  const { createReadinessCheck } = await import("../src/routes/health.js");
  const failed = { status: "failed" as const, latencyMs: 1, error: "connect ECONNREFUSED 127.0.0.1:5432", schema: { status: "unchecked" as const, missing: [] as string[] } };
  let pings = 0, now = 0, release = () => {};
  const check = createReadinessCheck(() => { pings++; return new Promise((resolve) => { release = () => resolve(failed); }); }, 1_000, () => now);
  const warned: unknown[] = [], log = { warn: (fields: unknown) => warned.push(fields) };
  const first = check(log), second = check(log);
  assert.equal(pings, 1, "a check in flight is shared");
  release();
  await Promise.all([first, second]);
  now = 999;
  await check(log);
  assert.equal(pings, 1, "and its answer reused for a second after it finishes");
  now = 1_000;
  const third = check(log);
  release();
  assert.equal((await third).status, "failed");
  assert.deepEqual([pings, warned.length], [2, 2], "then checked again; a failing check is written once per check, not once per probe");
  checks += 4;
});

await section("the sandbox cookie after the legacy period", async () => {
  const { readSandboxCookie, LEGACY_SANDBOX_COOKIES_UNTIL } = await import("../src/lib/sandbox-cookie.js");
  const header = `valo_sandbox=${token("7")}; valopay_sandbox=${token("8")}`;
  assert.deepEqual(readSandboxCookie(header, true, LEGACY_SANDBOX_COOKIES_UNTIL - 1), { name: "__Host-valopay_sandbox", token: token("8"), stale: ["valopay_sandbox", "valo_sandbox"] }, "until then the newer of the old names is taken over, and both are cleared");
  assert.deepEqual(readSandboxCookie(header, true, LEGACY_SANDBOX_COOKIES_UNTIL), { name: "__Host-valopay_sandbox", stale: ["valopay_sandbox", "valo_sandbox"] }, "from 1 January 2027 old names are not read, only cleared");
  assert.deepEqual(readSandboxCookie(`valopay_sandbox=not-a-token; valopay_sandbox=${token("9")}`, false), { name: "valopay_sandbox", token: token("9"), stale: [] }, "a value that is not a token names no sandbox, so it is no conflict");
  checks += 3;
});

if (failures.length) {
  console.error(failures.join("\n\n"));
  console.error(`Edge security checks failed: ${failures.length} group(s).`);
  process.exit(1);
}
console.log(`Edge security checks passed (${checks} checks): limits by principal and network with IPv6 counted by /64, new sandboxes per network, /48 and process, bounded limiter maps, health without Clerk and coalesced readiness with its own limit, request ids only from a configured edge, Clerk sessions only for configured origins, a Clerk proxy that forwards the trusted address and configured origin, a staff host that does not start without Clerk, and the __Host- sandbox cookie.`);
process.exit(0);
