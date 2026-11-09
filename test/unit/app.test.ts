import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { buildServices, type Services } from "../../src/services.js";

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

describe("Re-authorising a connection", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "atm-reauth-"));
    app = await buildApp({
      config: loadConfig({ DEMO_MODE: "1", APP_DATA_DIR: dir, APP_DB_PATH: ":memory:" }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // A refused refresh token can only be fixed by a new bank login, and that
  // login must land on the SAME connection: a fresh "Add connection" would
  // orphan the account mappings and leave the old connection red.
  it("re-runs the bank login against the existing connection", async () => {
    await app.inject({
      method: "POST",
      url: "/connections/add",
      payload: { display_name: "Demo Bank", connection_type: "bank_account" },
    });
    const [before] = (await app.inject({ method: "GET", url: "/status" })).json()
      .connections;

    const response = await app.inject({
      method: "POST",
      url: `/connections/${before.id}/reauthorise`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("/connections");
    expect(response.headers.location).toContain("Re-authorised");

    const after = (await app.inject({ method: "GET", url: "/status" })).json()
      .connections;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before.id, status: "active" });
  });

  it("offers the bank login on the Connections page", async () => {
    const page = await app.inject({ method: "GET", url: "/connections" });
    expect(page.body).toContain("/reauthorise");
    expect(page.body).toContain("Re-authorise with bank");
  });
});

describe("Mapping an account", () => {
  let app: FastifyInstance;
  let services: Services;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "atm-mappings-"));
    services = buildServices(
      loadConfig({ DEMO_MODE: "1", APP_DATA_DIR: dir, APP_DB_PATH: ":memory:" }),
    );
    app = await buildApp({ services });
    await app.ready();
    await app.inject({
      method: "POST",
      url: "/connections/add",
      payload: { display_name: "Demo Bank", connection_type: "bank_account" },
    });
  });

  afterAll(async () => {
    await app.close();
    services.close();
  });

  // Defaulting an unmapped row to the first account alphabetically meant one
  // click on "Map" filed a savings account into an unrelated Actual account.
  it("starts an unmapped row on a placeholder, not a real account", async () => {
    const page = await app.inject({ method: "GET", url: "/mappings" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(
      '<option value="" selected disabled>Choose an Actual account…</option>',
    );
    expect(page.body).not.toMatch(/<option value="[^"]+" selected>/);
  });

  it("refuses to save a mapping with no Actual account chosen", async () => {
    const [account] = services.connections.listProviderAccounts();
    const response = await app.inject({
      method: "POST",
      url: "/mappings",
      payload: {
        connection_id: account!.connection_id,
        provider_account_id: account!.provider_account_id,
        actual_account_id: "",
      },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("kind=error");
    expect(response.headers.location).toContain("Choose+an+Actual+account");
    expect(services.mappings.list()).toHaveLength(0);
  });

  it("refuses an Actual account id that does not exist", async () => {
    const [account] = services.connections.listProviderAccounts();
    const response = await app.inject({
      method: "POST",
      url: "/mappings",
      payload: {
        connection_id: account!.connection_id,
        provider_account_id: account!.provider_account_id,
        actual_account_id: "not-a-real-account",
      },
    });
    expect(response.headers.location).toContain("kind=error");
    expect(services.mappings.list()).toHaveLength(0);
  });

  it("keeps an existing mapping pre-selected", async () => {
    const [account] = services.connections.listProviderAccounts();
    await app.inject({
      method: "POST",
      url: "/mappings",
      payload: {
        connection_id: account!.connection_id,
        provider_account_id: account!.provider_account_id,
        actual_account_id: "actual-savings",
      },
    });
    expect(services.mappings.list()).toHaveLength(1);
    const page = await app.inject({ method: "GET", url: "/mappings" });
    expect(page.body).toContain('<option value="actual-savings" selected>');
  });
});

/** Creates a demo connection, maps its current account and runs a live sync. */
async function syncDemoCurrentAccount(
  app: FastifyInstance,
  services: Services,
  headers: Record<string, string> = {},
): Promise<void> {
  await app.inject({
    method: "POST",
    url: "/connections/add",
    headers,
    payload: { display_name: "Demo Bank", connection_type: "bank_account" },
  });
  const account = services.connections
    .listProviderAccounts()
    .find((a) => a.provider_account_id === "demo-current");
  await app.inject({
    method: "POST",
    url: "/mappings",
    headers,
    payload: {
      connection_id: account!.connection_id,
      provider_account_id: account!.provider_account_id,
      actual_account_id: "actual-current",
    },
  });
  const summary = await services
    .createSyncRunner()
    .run({ dryRun: false, mode: "manual" });
  expect(summary.imported).toBeGreaterThan(0);
}

describe("Raw transaction payloads", () => {
  const basic = `Basic ${Buffer.from("admin:s3cret").toString("base64")}`;
  let app: FastifyInstance;
  let services: Services;

  beforeAll(async () => {
    vi.stubEnv("APP_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    const dir = mkdtempSync(join(tmpdir(), "atm-raw-"));
    services = buildServices(
      loadConfig({
        DEMO_MODE: "1",
        APP_DATA_DIR: dir,
        APP_DB_PATH: ":memory:",
        APP_BASIC_AUTH_USER: "admin",
        APP_BASIC_AUTH_PASSWORD: "s3cret",
      }),
    );
    expect(services.hasDurableKey).toBe(true);
    app = await buildApp({ services });
    await app.ready();
    await syncDemoCurrentAccount(app, services, { authorization: basic });
  });

  afterAll(async () => {
    await app.close();
    services.close();
    vi.unstubAllEnvs();
  });

  function storedRows() {
    return services.db
      .prepare(
        "SELECT provider_transaction_id, raw_json_encrypted FROM imported_transactions",
      )
      .all() as { provider_transaction_id: string; raw_json_encrypted: string | null }[];
  }

  it("stores the payload encrypted, never as plaintext JSON", () => {
    const rows = storedRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.raw_json_encrypted).toMatch(/^v1:gcm:/);
      expect(row.raw_json_encrypted).not.toContain(row.provider_transaction_id);
      const decrypted = JSON.parse(services.encryptor!.decrypt(row.raw_json_encrypted!));
      expect(decrypted.transaction_id).toBe(row.provider_transaction_id);
    }
  });

  it("requires authentication to read it back", async () => {
    const [row] = storedRows();
    const response = await app.inject({
      method: "GET",
      url: `/transactions/raw?provider_transaction_id=${encodeURIComponent(row!.provider_transaction_id)}`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("transaction_id");
  });

  it("returns the decrypted payload to an authenticated request", async () => {
    const [row] = storedRows();
    const response = await app.inject({
      method: "GET",
      url: `/transactions/raw?imported_id=${encodeURIComponent(row!.provider_transaction_id)}`,
      headers: { authorization: basic },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const { matches } = response.json();
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      provider: "demo",
      provider_account_id: "demo-current",
      provider_transaction_id: row!.provider_transaction_id,
      raw_status: "stored",
      raw: { transaction_id: row!.provider_transaction_id, currency: "GBP" },
    });
  });

  it("finds a transaction by booked date and amount", async () => {
    const [row] = services.syncRuns.findImported({
      providerTransactionId: storedRows()[0]!.provider_transaction_id,
    });
    const response = await app.inject({
      method: "GET",
      url: `/transactions/raw?booked_date=${row!.booked_date}&amount_minor=${row!.amount_minor}`,
      headers: { authorization: basic },
    });
    const { matches } = response.json();
    expect(matches.map((m: { provider_transaction_id: string }) => m.provider_transaction_id))
      .toContain(row!.provider_transaction_id);
  });

  it("rejects a lookup with no identifying field", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/transactions/raw",
      headers: { authorization: basic },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("Raw transaction payloads without a durable key", () => {
  let app: FastifyInstance;
  let services: Services;

  beforeAll(async () => {
    vi.stubEnv("APP_ENCRYPTION_KEY", "");
    const dir = mkdtempSync(join(tmpdir(), "atm-raw-nokey-"));
    services = buildServices(
      loadConfig({ DEMO_MODE: "1", APP_DATA_DIR: dir, APP_DB_PATH: ":memory:" }),
    );
    // Demo mode has a throwaway key, but nothing durable to protect raw data.
    expect(services.hasDurableKey).toBe(false);
    app = await buildApp({ services });
    await app.ready();
    await syncDemoCurrentAccount(app, services);
  });

  afterAll(async () => {
    await app.close();
    services.close();
    vi.unstubAllEnvs();
  });

  it("stores no payload at all", async () => {
    const rows = services.db
      .prepare("SELECT raw_json_encrypted FROM imported_transactions")
      .all() as { raw_json_encrypted: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.raw_json_encrypted === null)).toBe(true);
  });
});
