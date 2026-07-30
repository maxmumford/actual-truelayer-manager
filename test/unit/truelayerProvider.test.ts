import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuthorizationError,
  TrueLayerProvider,
} from "../../src/providers/truelayer/truelayerProvider.js";

interface Recorded {
  path: string;
  body: string;
  auth?: string;
}

/**
 * A tiny mock of the TrueLayer auth + data APIs so the live provider's real
 * network code path (fetch, headers, parsing) is exercised end to end.
 */
function startMockTrueLayer(): Promise<{
  server: Server;
  baseUrl: string;
  requests: Recorded[];
}> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push({
        path: url.pathname,
        body,
        auth: req.headers.authorization,
      });

      const send = (code: number, payload: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname === "/connect/token") {
        send(200, {
          access_token: "access-123",
          refresh_token: "refresh-456",
          expires_in: 3600,
          scope: "accounts",
          token_type: "Bearer",
        });
        return;
      }
      if (url.pathname === "/data/v1/accounts") {
        send(200, {
          results: [
            {
              account_id: "acc-1",
              display_name: "Everyday",
              account_type: "TRANSACTION",
              currency: "GBP",
            },
          ],
        });
        return;
      }
      if (url.pathname === "/data/v1/cards") {
        send(200, {
          results: [
            {
              account_id: "card-1",
              display_name: "Rewards Card",
              currency: "GBP",
            },
          ],
        });
        return;
      }
      if (url.pathname === "/data/v1/accounts/acc-1/balance") {
        send(200, { results: [{ current: 1542.1, available: 1500 }] });
        return;
      }
      if (url.pathname === "/data/v1/cards/card-1/balance") {
        send(200, { results: [{ current: -230.5 }] });
        return;
      }
      if (url.pathname === "/data/v1/accounts/acc-1/transactions") {
        send(200, {
          results: [
            {
              transaction_id: "tx-1",
              timestamp: "2026-07-10T09:30:00Z",
              description: "Tesco",
              amount: -12.5,
              currency: "GBP",
              merchant_name: "Tesco",
            },
          ],
        });
        return;
      }
      // A card id is not a bank account, so the account path 404s and the
      // provider retries via the cards path.
      if (url.pathname === "/data/v1/accounts/card-1/transactions") {
        send(404, { error: "not_found" });
        return;
      }
      if (url.pathname === "/data/v1/cards/card-1/transactions") {
        send(200, {
          results: [
            // Card amounts use the OPPOSITE sign convention to accounts:
            // positive = funds out of the card (a purchase), negative = funds
            // in (a refund). Mirrors the example in TrueLayer's card data docs.
            {
              transaction_id: "ctx-1",
              timestamp: "2026-07-11T12:00:00Z",
              description: "Sainsburys",
              amount: 24.25,
              transaction_type: "DEBIT",
              currency: "GBP",
            },
            {
              transaction_id: "ctx-2",
              timestamp: "2026-07-12T12:00:00Z",
              description: "Refund",
              amount: -15.0,
              transaction_type: "CREDIT",
              currency: "GBP",
            },
          ],
        });
        return;
      }
      if (url.pathname === "/data/v1/accounts/unauthorized/transactions") {
        send(401, { error: "unauthorized" });
        return;
      }
      send(404, { error: "not_found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, requests });
    });
  });
}

describe("TrueLayerProvider (live network path against a mock)", () => {
  let mock: Awaited<ReturnType<typeof startMockTrueLayer>>;
  let provider: TrueLayerProvider;

  beforeAll(async () => {
    mock = await startMockTrueLayer();
    provider = new TrueLayerProvider({
      clientId: "client",
      clientSecret: "secret",
      authBaseUrl: mock.baseUrl,
      apiBaseUrl: mock.baseUrl,
    });
  });

  afterAll(() => {
    mock.server.close();
  });

  it("builds an auth URL with the expected params", async () => {
    const url = await provider.createAuthUrl({
      state: "st",
      redirectUri: "https://app/cb",
      connectionType: "bank_account",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("client");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app/cb");
    expect(parsed.searchParams.get("state")).toBe("st");
  });

  it("exchanges an auth code for tokens", async () => {
    const tokens = await provider.exchangeAuthCode({
      code: "code",
      redirectUri: "https://app/cb",
    });
    expect(tokens.accessToken).toBe("access-123");
    expect(tokens.refreshToken).toBe("refresh-456");
    expect(tokens.expiresAt).toBeDefined();
  });

  it("lists accounts + cards with balances", async () => {
    const accounts = await provider.listAccounts({
      tokens: { accessToken: "access-123", refreshToken: "r" },
    });
    expect(accounts).toHaveLength(2);
    const acc = accounts.find((a) => a.providerAccountId === "acc-1");
    expect(acc?.accountType).toBe("transaction");
    expect(acc?.balanceMinor).toBe(154210);
    const card = accounts.find((a) => a.providerAccountId === "card-1");
    expect(card?.accountType).toBe("credit_card");
    expect(card?.balanceMinor).toBe(-23050);
  });

  it("lists account transactions", async () => {
    const txns = await provider.listTransactions({
      tokens: { accessToken: "access-123", refreshToken: "r" },
      providerAccountId: "acc-1",
      from: "2026-07-01",
      to: "2026-07-17",
    });
    expect(txns).toHaveLength(1);
    expect(txns[0]?.amountMinor).toBe(-1250);
    expect(txns[0]?.merchantName).toBe("Tesco");
  });

  it("falls back to the card path when the account path 404s", async () => {
    const txns = await provider.listTransactions({
      tokens: { accessToken: "access-123", refreshToken: "r" },
      providerAccountId: "card-1",
      from: "2026-07-01",
      to: "2026-07-17",
    });
    expect(txns).toHaveLength(2);
    expect(txns[0]?.providerTransactionId).toBe("ctx-1");
  });

  it("negates card amounts so spending is negative in Actual", async () => {
    const txns = await provider.listTransactions({
      tokens: { accessToken: "access-123", refreshToken: "r" },
      providerAccountId: "card-1",
      from: "2026-07-01",
      to: "2026-07-17",
    });
    // A £24.25 purchase arrives from TrueLayer as +24.25 and must become
    // -2425, or every card spend inflates the budget instead of reducing it.
    expect(txns[0]?.amountMinor).toBe(-2425);
    // A refund arrives as -15.00 and must become +1500.
    expect(txns[1]?.amountMinor).toBe(1500);
  });

  it("leaves account amounts untouched (they are already signed)", async () => {
    const txns = await provider.listTransactions({
      tokens: { accessToken: "access-123", refreshToken: "r" },
      providerAccountId: "acc-1",
      from: "2026-07-01",
      to: "2026-07-17",
    });
    expect(txns[0]?.amountMinor).toBe(-1250);
  });

  it("throws AuthorizationError on a 401 response", async () => {
    await expect(
      provider.listTransactions({
        tokens: { accessToken: "bad", refreshToken: "r" },
        providerAccountId: "unauthorized",
        from: "2026-07-01",
        to: "2026-07-17",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("sends the bearer token on data requests", async () => {
    mock.requests.length = 0;
    await provider.listAccounts({
      tokens: { accessToken: "access-xyz", refreshToken: "r" },
    });
    const dataReq = mock.requests.find((r) => r.path === "/data/v1/accounts");
    expect(dataReq?.auth).toBe("Bearer access-xyz");
  });
});
