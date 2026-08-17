import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { GitHubApi } from "../live/support/github-fixture.js";

describe("live GitHub client resilience", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
  });

  it("recovers from transient GitHub 503 responses", async () => {
    let attempts = 0;
    const apiUrl = await start(servers, (_request, response) => {
      attempts += 1;
      response.setHeader("content-type", "application/json");
      if (attempts < 3) {
        response.statusCode = 503;
        response.end(JSON.stringify({ message: "Service Unavailable" }));
        return;
      }
      response.end(JSON.stringify({ state: "recovered" }));
    });
    const api = new GitHubApi("test-token", 5_000, apiUrl, 1);

    await expect(
      api.rest("/outage", { method: "GET" }, z.object({ state: z.literal("recovered") })),
    ).resolves.toEqual({ state: "recovered" });
    expect(attempts).toBe(3);
  });

  it("does not retry terminal authentication failures", async () => {
    let attempts = 0;
    const apiUrl = await start(servers, (_request, response) => {
      attempts += 1;
      response.statusCode = 401;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ message: "Bad credentials" }));
    });
    const api = new GitHubApi("test-token", 5_000, apiUrl, 1);

    await expect(
      api.rest("/auth", { method: "GET" }, z.object({ state: z.string() })),
    ).rejects.toMatchObject({ code: "authentication", retryable: false });
    expect(attempts).toBe(1);
  });

  it("sends unsafe mutation bodies once so callers can reconcile before retrying", async () => {
    let attempts = 0;
    let received: unknown;
    const apiUrl = await start(servers, (request, response) => {
      attempts += 1;
      const chunks: Uint8Array[] = [];
      request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      request.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: 7 }));
      });
    });
    const api = new GitHubApi("test-token", 5_000, apiUrl, 1);

    await expect(
      api.rest(
        "/mutation",
        { method: "POST", body: JSON.stringify({ title: "stable fixture" }) },
        z.object({ id: z.number() }),
        false,
      ),
    ).resolves.toEqual({ id: 7 });
    expect(attempts).toBe(1);
    expect(received).toEqual({ title: "stable fixture" });
  });
});

async function start(
  servers: Server[],
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return `http://127.0.0.1:${address.port.toString()}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
