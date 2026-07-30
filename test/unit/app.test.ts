import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";

describe("HTTP app", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns ok", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("GET /status returns the not-configured shape", async () => {
    const response = await app.inject({ method: "GET", url: "/status" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.actual.status).toBe("not_configured");
    expect(body.connections).toEqual([]);
    expect(body.sync.last_imported_count).toBe(0);
  });

  it("GET /setup renders the wizard HTML", async () => {
    const response = await app.inject({ method: "GET", url: "/setup" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Connect to Actual Budget");
    expect(response.body).toContain("Configure TrueLayer credentials");
  });

  it("GET /dashboard and /logs render", async () => {
    const dash = await app.inject({ method: "GET", url: "/dashboard" });
    expect(dash.statusCode).toBe(200);
    expect(dash.body).toContain("Actual Budget");
    const logs = await app.inject({ method: "GET", url: "/logs" });
    expect(logs.statusCode).toBe(200);
    expect(logs.body).toContain("Recent logs");
  });

  it("GET / redirects to /setup", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/setup");
  });

  it("POST /oauth/exchange rejects a redirect URL with an unknown state", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/oauth/exchange",
      payload: {
        connection_id: "attacker-supplied-connection-id",
        redirect_url:
          "https://console.truelayer.com/redirect-page?code=some-code&state=never-issued",
      },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("/setup");
    expect(response.headers.location).toContain("Unknown+OAuth+state");
  });

  it("POST /oauth/exchange rejects a redirect URL with no state at all", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/oauth/exchange",
      payload: {
        connection_id: "attacker-supplied-connection-id",
        redirect_url: "https://console.truelayer.com/redirect-page?code=abc",
      },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("/setup");
    expect(response.headers.location).toContain("state");
  });
});

describe("HTTP Basic Auth", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "atm-auth-"));
    const config = loadConfig({
      DEMO_MODE: "1",
      APP_DATA_DIR: dir,
      APP_DB_PATH: ":memory:",
      APP_BASIC_AUTH_USER: "admin",
      APP_BASIC_AUTH_PASSWORD: "s3cret",
    });
    app = await buildApp({ config });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("leaves /health open for health checks", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });

  it("challenges unauthenticated requests to protected routes", async () => {
    const response = await app.inject({ method: "GET", url: "/setup" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Basic");
  });

  it("allows requests with valid credentials", async () => {
    const credentials = Buffer.from("admin:s3cret").toString("base64");
    const response = await app.inject({
      method: "GET",
      url: "/setup",
      headers: { authorization: `Basic ${credentials}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects wrong credentials", async () => {
    const credentials = Buffer.from("admin:wrong").toString("base64");
    const response = await app.inject({
      method: "GET",
      url: "/setup",
      headers: { authorization: `Basic ${credentials}` },
    });
    expect(response.statusCode).toBe(401);
  });
});
