import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createEncryptor } from "../../src/crypto/encrypt.js";
import { openDatabase } from "../../src/db/index.js";
import { ConnectionsRepo } from "../../src/db/repositories/connections.repo.js";
import { MappingsRepo } from "../../src/db/repositories/mappings.repo.js";
import { SyncRunsRepo } from "../../src/db/repositories/syncRuns.repo.js";
import { DemoActualClient } from "../../src/actual/demoActualClient.js";
import { DemoProvider } from "../../src/providers/demo/demoProvider.js";
import { SyncRunner } from "../../src/sync/syncRunner.js";
import {
  normaliseTransaction,
  transactionKey,
} from "../../src/sync/normalise.js";
import { AuthorizationError } from "../../src/providers/truelayer/truelayerProvider.js";
import type {
  BankAccount,
  BankTransaction,
  BankingProvider,
  TokenSet,
} from "../../src/providers/bankingProvider.js";

function setup() {
  const db = openDatabase(":memory:");
  const enc = createEncryptor(randomBytes(32).toString("base64"));
  const connections = new ConnectionsRepo(db, enc);
  const mappings = new MappingsRepo(db);
  const syncRuns = new SyncRunsRepo(db);
  const config = loadConfig({ DEMO_MODE: "1", APP_DB_PATH: ":memory:" });

  connections.create({
    id: "c1",
    provider: "demo",
    displayName: "Demo",
    connectionType: "bank_account",
    status: "active",
  });
  connections.saveTokens("c1", { accessToken: "a", refreshToken: "r" });
  mappings.upsert({
    id: "m1",
    connectionId: "c1",
    providerAccountId: "demo-current",
    actualAccountId: "actual-current",
    actualAccountName: "Current",
  });

  const runner = new SyncRunner({
    config,
    provider: new DemoProvider(),
    actual: new DemoActualClient(),
    connections,
    mappings,
    syncRuns,
  });
  return { db, runner };
}

describe("transactionKey", () => {
  it("uses provider id when present", () => {
    const tx = { providerTransactionId: "abc" } as BankTransaction;
    expect(transactionKey("demo", tx)).toEqual({ id: "abc", fallback: false });
  });

  it("derives a deterministic fallback id when missing", () => {
    const tx = {
      providerTransactionId: "",
      providerAccountId: "acc",
      bookedDate: "2026-01-01",
      description: "Coffee",
      amountMinor: -350,
      currency: "GBP",
    } as BankTransaction;
    const a = transactionKey("demo", tx);
    const b = transactionKey("demo", tx);
    expect(a.fallback).toBe(true);
    expect(a.id).toBe(b.id);
  });
});

/**
 * A faster payment as TrueLayer really returns it (Monzo, 11 Aug 2026): no
 * `merchant_name`, a `description` holding only the reference the payer typed,
 * and the beneficiary's name tucked away in `meta`.
 */
function fasterPayment(meta: Record<string, unknown>): BankTransaction {
  return {
    providerTransactionId: "11dd07ca622bc24035bee9c146a39d27",
    providerAccountId: "acc",
    bookedDate: "2026-08-11",
    description: "237 OSR, BN411XR",
    amountMinor: -3500,
    currency: "GBP",
    raw: {
      description: "237 OSR, BN411XR",
      transaction_type: "DEBIT",
      transaction_category: "TRANSFER",
      amount: -35,
      transaction_id: "11dd07ca622bc24035bee9c146a39d27",
      meta,
    },
  };
}

describe("normaliseTransaction payee", () => {
  it("uses the counterparty name when there is no merchant name", () => {
    const tx = fasterPayment({
      provider_category: "payport_faster_payments",
      counter_party_preferred_name: "Albion Commercial Cleaning Ltd",
    });
    expect(normaliseTransaction("truelayer", tx, "actual-1").payeeName).toBe(
      "Albion Commercial Cleaning Ltd",
    );
  });

  it("prefers counter_party_preferred_name over counter_party_name", () => {
    const tx = fasterPayment({
      counter_party_preferred_name: "Preferred Name Ltd",
      counter_party_name: "LEGAL NAME LTD",
    });
    expect(normaliseTransaction("truelayer", tx, "actual-1").payeeName).toBe(
      "Preferred Name Ltd",
    );
  });

  it("falls back to counter_party_name when there is no preferred name", () => {
    const tx = fasterPayment({ counter_party_name: "LEGAL NAME LTD" });
    expect(normaliseTransaction("truelayer", tx, "actual-1").payeeName).toBe(
      "LEGAL NAME LTD",
    );
  });

  it("still lets the merchant name win when present", () => {
    const tx = {
      ...fasterPayment({
        counter_party_preferred_name: "Albion Commercial Cleaning Ltd",
      }),
      merchantName: "Tesco",
    };
    expect(normaliseTransaction("truelayer", tx, "actual-1").payeeName).toBe(
      "Tesco",
    );
  });

  it("falls back to the description when neither name is available", () => {
    const tx = fasterPayment({ provider_category: "payport_faster_payments" });
    expect(normaliseTransaction("truelayer", tx, "actual-1").payeeName).toBe(
      "237 OSR, BN411XR",
    );
  });

  it("ignores a blank or whitespace-only counterparty name", () => {
    const tx = fasterPayment({
      counter_party_preferred_name: "   ",
      counter_party_name: "",
    });
    expect(normaliseTransaction("truelayer", tx, "actual-1").payeeName).toBe(
      "237 OSR, BN411XR",
    );
  });

  it("trims a padded counterparty name", () => {
    const tx = fasterPayment({
      counter_party_preferred_name: "  Albion Commercial Cleaning Ltd  ",
    });
    expect(normaliseTransaction("truelayer", tx, "actual-1").payeeName).toBe(
      "Albion Commercial Cleaning Ltd",
    );
  });

  it("falls back to the description when there is no raw payload at all", () => {
    const tx = { ...fasterPayment({}), raw: undefined };
    expect(normaliseTransaction("truelayer", tx, "actual-1").payeeName).toBe(
      "237 OSR, BN411XR",
    );
  });
});

describe("SyncRunner", () => {
  it("dry-run imports nothing but reports fetched", async () => {
    const { db, runner } = setup();
    const summary = await runner.run({ dryRun: true, mode: "dry_run" });
    expect(summary.fetched).toBeGreaterThan(0);
    expect(summary.imported).toBe(0);
    db.close();
  });

  it("live sync imports, then a second run finds only duplicates", async () => {
    const { db, runner } = setup();
    const first = await runner.run({ dryRun: false, mode: "manual" });
    expect(first.imported).toBeGreaterThan(0);
    expect(first.status).toBe("success");

    // The second run only refetches the overlap window; everything it sees was
    // already imported, so nothing new is imported and all are duplicates.
    const second = await runner.run({ dryRun: false, mode: "manual" });
    expect(second.imported).toBe(0);
    expect(second.duplicate).toBeGreaterThan(0);
    expect(second.duplicate).toBe(second.fetched);
    db.close();
  });
});

class MockProvider implements BankingProvider {
  readonly name = "mock";
  refreshCalls = 0;
  lastAccessToken: string | undefined;

  constructor(
    private readonly behaviour: {
      transactions?: BankTransaction[];
      throwAuthOnList?: boolean;
    } = {},
  ) {}

  async createAuthUrl(): Promise<string> {
    return "https://mock/auth";
  }

  async exchangeAuthCode(): Promise<TokenSet> {
    return this.mint();
  }

  async refreshToken(): Promise<TokenSet> {
    this.refreshCalls += 1;
    return this.mint("refreshed-access");
  }

  async listAccounts(): Promise<BankAccount[]> {
    return [];
  }

  async listTransactions(input: {
    tokens: TokenSet;
  }): Promise<BankTransaction[]> {
    this.lastAccessToken = input.tokens.accessToken;
    if (this.behaviour.throwAuthOnList) {
      throw new AuthorizationError("token no longer valid");
    }
    return this.behaviour.transactions ?? [];
  }

  private mint(access = "mock-access"): TokenSet {
    return {
      accessToken: access,
      refreshToken: "mock-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: "accounts",
      tokenType: "Bearer",
    };
  }
}

function setupWith(provider: BankingProvider, expiresAt: string | undefined) {
  const db = openDatabase(":memory:");
  const enc = createEncryptor(randomBytes(32).toString("base64"));
  const connections = new ConnectionsRepo(db, enc);
  const mappings = new MappingsRepo(db);
  const syncRuns = new SyncRunsRepo(db);
  const config = loadConfig({ DEMO_MODE: "1", APP_DB_PATH: ":memory:" });

  connections.create({
    id: "c1",
    provider: provider.name,
    displayName: "Mock",
    connectionType: "bank_account",
    status: "active",
  });
  connections.saveTokens("c1", {
    accessToken: "stale-access",
    refreshToken: "stale-refresh",
    expiresAt,
  });
  mappings.upsert({
    id: "m1",
    connectionId: "c1",
    providerAccountId: "acc-1",
    actualAccountId: "actual-current",
    actualAccountName: "Current",
  });

  const runner = new SyncRunner({
    config,
    provider,
    actual: new DemoActualClient(),
    connections,
    mappings,
    syncRuns,
  });
  return { db, runner, connections };
}

describe("SyncRunner token handling", () => {
  it("refreshes an expiring token and persists the new one", async () => {
    const provider = new MockProvider({ transactions: [] });
    const past = new Date(Date.now() - 60_000).toISOString();
    const { db, runner, connections } = setupWith(provider, past);

    await runner.run({ dryRun: false, mode: "manual" });

    expect(provider.refreshCalls).toBe(1);
    expect(provider.lastAccessToken).toBe("refreshed-access");
    expect(connections.getTokens("c1")?.accessToken).toBe("refreshed-access");
    db.close();
  });

  it("does not refresh a token that is still valid", async () => {
    const provider = new MockProvider({ transactions: [] });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const { db, runner } = setupWith(provider, future);

    await runner.run({ dryRun: false, mode: "manual" });

    expect(provider.refreshCalls).toBe(0);
    expect(provider.lastAccessToken).toBe("stale-access");
    db.close();
  });

  it("marks the connection reauth_required on an authorization error", async () => {
    const provider = new MockProvider({ throwAuthOnList: true });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const { db, runner, connections } = setupWith(provider, future);

    const summary = await runner.run({ dryRun: false, mode: "manual" });

    expect(summary.failed).toBeGreaterThan(0);
    expect(connections.get("c1")?.status).toBe("reauth_required");
    db.close();
  });
});
