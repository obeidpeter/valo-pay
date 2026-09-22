// Loopback-only synthetic server for real-browser regression tests. Never imported by the application.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { installFakeApi } from "../tests/fake-api";
if (process.env.VALOPAY_BROWSER_TEST !== "1")
  throw new Error("Use the isolated browser-test command.");
let api: ReturnType<typeof installFakeApi>;
function reset() {
  api?.uninstall();
  api = installFakeApi({ now: "2026-09-19T12:00:00.000Z" });
  api.mutate((state) => {
    const mandate = state.records.find(
      (r) => r.kind === "mandates" && r.status === "pending_activation",
    )!;
    const due = state.records.find(
      (r) => r.kind === "due-items" && r.data.mandateId === mandate.id,
    )!;
    const allocation = state.records.find(
      (r) => r.kind === "allocations" && r.status === "proposed",
    )!;
    for (let i = 0; i < 55; i++) {
      state.records.push({
        ...structuredClone(mandate),
        id: randomUUID(),
        reference: `BROWSER-MND-${String(i).padStart(2, "0")}`,
        data: { ...mandate.data, activationDeadline: "2026-01-01T00:00:00Z" },
      });
      state.records.push({
        ...structuredClone(due),
        id: randomUUID(),
        reference: `BROWSER-DUE-${String(i).padStart(2, "0")}`,
        data: { ...due.data, dueDate: "2026-01-01" },
      });
      state.records.push({
        ...structuredClone(allocation),
        id: randomUUID(),
        reference: `BROWSER-MATCH-${String(i).padStart(2, "0")}`,
      });
      state.records.push({
        ...structuredClone(due),
        id: randomUUID(),
        kind: "closes",
        reference: `BROWSER-CLOSE-${i}`,
        status: "completed",
        createdAt: new Date(Date.UTC(2026, 7, 1 + i, 6)).toISOString(),
        data: {
          synthetic: true,
          summary: `Recorded sample close ${i}`,
          report: {
            unallocated: { kobo: i * 100, count: i },
            exceptions: { openAtClose: i },
          },
        },
      });
    }
  });
}
reset();
const root = path.resolve(import.meta.dirname, "../dist/public");
const types: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1:4173");
    if (url.pathname === "/__test/reset" && req.method === "POST") {
      reset();
      res.end("ok");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      // Forward every header the console sent (Idempotency-Key among them); only hop-by-hop ones are dropped.
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (["host", "connection", "content-length", "transfer-encoding", "keep-alive"].includes(name)) continue;
        if (typeof value === "string") headers[name] = value;
        else if (Array.isArray(value)) headers[name] = value.join(", ");
      }
      if (!headers["content-type"]) headers["content-type"] = "application/json";
      const result = await fetch(url, {
        method: req.method,
        headers,
        ...(body ? { body } : {}),
      });
      res.writeHead(
        result.status,
        Object.fromEntries(result.headers.entries()),
      );
      res.end(await result.text());
      return;
    }
    const requested = path.resolve(
      root,
      "." + decodeURIComponent(url.pathname),
    );
    if (requested !== root && !requested.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const filename = path.extname(requested)
      ? requested
      : path.join(root, "index.html");
    const body = await readFile(filename);
    res.writeHead(200, {
      "content-type":
        types[path.extname(filename)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
}).listen(4173, "127.0.0.1");
