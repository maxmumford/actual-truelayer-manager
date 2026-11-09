import { randomUUID } from "node:crypto";
import type { BankingProvider, TokenSet } from "../providers/bankingProvider.js";
import type { ConnectionType } from "../db/types.js";
import { connectPage } from "./views/connect.js";
import type { Services } from "../services.js";

function inferConnectionType(
  accountTypes: string[],
): ConnectionType {
  const hasCard = accountTypes.includes("credit_card");
  const hasBank = accountTypes.some((t) => t !== "credit_card");
  if (hasCard && hasBank) return "mixed";
  if (hasCard) return "credit_card";
  if (hasBank) return "bank_account";
  return "unknown";
}

/**
 * Finalises a bank connection after tokens are obtained: persists the encrypted
 * tokens, discovers accounts, stores them, updates the connection type/status,
 * and returns the number of accounts discovered.
 */
export async function finaliseConnection(
  services: Services,
  provider: BankingProvider,
  connectionId: string,
  tokens: TokenSet,
): Promise<number> {
  services.connections.saveTokens(connectionId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
    tokenType: tokens.tokenType,
  });

  const accounts = await provider.listAccounts({ tokens });

  let consentExpiresAt: string | undefined;
  if (provider.getConsentExpiry) {
    try {
      consentExpiresAt = await provider.getConsentExpiry({ tokens });
    } catch {
      consentExpiresAt = undefined;
    }
  }
  if (consentExpiresAt) {
    services.connections.setConsentExpiry(connectionId, consentExpiresAt);
  }

  for (const account of accounts) {
    services.connections.upsertProviderAccount({
      id: randomUUID(),
      connectionId,
      provider: provider.name,
      providerAccountId: account.providerAccountId,
      displayName: account.displayName,
      accountType: account.accountType,
      currency: account.currency,
      metadata: {
        sortCode: account.sortCode,
        accountNumberLast4: account.accountNumberLast4,
        balanceMinor: account.balanceMinor,
      },
    });
  }

  const connectionType = inferConnectionType(
    accounts.map((a) => a.accountType),
  );
  services.connections.setStatus(connectionId, "active");
  services.db
    .prepare("UPDATE bank_connections SET connection_type = ? WHERE id = ?")
    .run(connectionType, connectionId);

  services.logs.info(
    `Connection ${connectionId} activated with ${accounts.length} accounts`,
  );
  return accounts.length;
}

/**
 * Starts a bank login for an existing connection row. Used both for a brand-new
 * connection and to re-authorise one whose refresh token has been refused:
 * binding the OAuth `state` to the SAME connection id is what keeps that
 * connection's account mappings, which a fresh "Add connection" would not.
 *
 * Returns the page to render, or — for the demo provider, which has no bank to
 * visit — finalises immediately and returns the number of accounts found.
 */
export async function beginAuthorisation(
  services: Services,
  provider: BankingProvider,
  connectionId: string,
  connectionType: "bank_account" | "credit_card",
): Promise<{ page: string } | { accounts: number }> {
  const state = randomUUID();
  services.settings.set(`oauth.state.${state}`, connectionId);

  const redirectMode =
    services.settings.get("truelayer.redirect_mode") ??
    services.config.truelayer.redirectMode;
  const redirectUri =
    redirectMode === "direct"
      ? `${services.config.baseUrl}/oauth/truelayer/callback`
      : "https://console.truelayer.com/redirect-page";

  const authUrl = await provider.createAuthUrl({
    state,
    redirectUri,
    connectionType,
  });

  if (provider.name === "demo") {
    const tokens = await provider.exchangeAuthCode({
      code: "demo-code",
      redirectUri,
    });
    return {
      accounts: await finaliseConnection(
        services,
        provider,
        connectionId,
        tokens,
      ),
    };
  }

  return {
    page: connectPage({
      connectionId,
      authUrl,
      redirectMode: redirectMode === "direct" ? "direct" : "manual",
    }),
  };
}
