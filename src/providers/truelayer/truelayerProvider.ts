import type {
  BankAccount,
  BankTransaction,
  BankingProvider,
  CreateAuthUrlInput,
  ExchangeAuthCodeInput,
  ListAccountsInput,
  ListTransactionsInput,
  RefreshTokenInput,
  TokenSet,
} from "../bankingProvider.js";

export interface TrueLayerConfig {
  clientId: string;
  clientSecret: string;
  authBaseUrl?: string;
  apiBaseUrl?: string;
  useSandbox?: boolean;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/**
 * TrueLayer's default Open Banking consent lasts 90 days. TrueLayer does not
 * return an explicit expiry in the token response, so we record this estimate
 * at connection time to drive the dashboard consent-expiry warning (spec §15.4).
 */
const CONSENT_WINDOW_DAYS = 90;

/**
 * Live TrueLayer provider (spec §15). Uses the global fetch API (Node 20+),
 * so it adds no HTTP dependency. Network calls are only made when live
 * credentials are configured; the demo provider is used otherwise.
 */
export class TrueLayerProvider implements BankingProvider {
  readonly name = "truelayer";
  private readonly authBase: string;
  private readonly apiBase: string;

  constructor(private readonly config: TrueLayerConfig) {
    const sandbox = config.useSandbox ?? false;
    this.authBase =
      config.authBaseUrl ??
      (sandbox
        ? "https://auth.truelayer-sandbox.com"
        : "https://auth.truelayer.com");
    this.apiBase =
      config.apiBaseUrl ??
      (sandbox
        ? "https://api.truelayer-sandbox.com"
        : "https://api.truelayer.com");
  }

  async createAuthUrl(input: CreateAuthUrlInput): Promise<string> {
    const providers = this.config.useSandbox
      ? "uk-cs-mock"
      : "uk-ob-all uk-oauth-all";
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      scope: "info accounts balance cards transactions offline_access",
      redirect_uri: input.redirectUri,
      state: input.state,
      providers,
    });
    return `${this.authBase}/?${params.toString()}`;
  }

  async exchangeAuthCode(input: ExchangeAuthCodeInput): Promise<TokenSet> {
    return this.requestToken({
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
    });
  }

  async refreshToken(input: RefreshTokenInput): Promise<TokenSet> {
    return this.requestToken({
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: input.refreshToken,
    });
  }

  async listAccounts(input: ListAccountsInput): Promise<BankAccount[]> {
    const token = input.tokens.accessToken;
    const [accounts, cards] = await Promise.all([
      this.getData("/data/v1/accounts", token),
      this.getData("/data/v1/cards", token),
    ]);

    const mapped: BankAccount[] = [];
    for (const a of accounts) {
      const acc = a as Record<string, unknown>;
      const id = String(acc.account_id);
      mapped.push({
        providerAccountId: id,
        displayName: String(acc.display_name ?? "Account"),
        accountType:
          String(acc.account_type ?? "").toUpperCase() === "SAVINGS"
            ? "savings"
            : "transaction",
        currency: String(acc.currency ?? "GBP"),
        balanceMinor: await this.getBalanceMinor(
          `/data/v1/accounts/${id}/balance`,
          token,
        ),
      });
    }
    for (const c of cards) {
      const card = c as Record<string, unknown>;
      const id = String(card.account_id);
      mapped.push({
        providerAccountId: id,
        displayName: String(card.display_name ?? "Credit Card"),
        accountType: "credit_card",
        currency: String(card.currency ?? "GBP"),
        balanceMinor: await this.getBalanceMinor(
          `/data/v1/cards/${id}/balance`,
          token,
        ),
      });
    }
    return mapped;
  }

  async listTransactions(
    input: ListTransactionsInput,
  ): Promise<BankTransaction[]> {
    const params = new URLSearchParams({ from: input.from, to: input.to });
    const query = params.toString();
    // Accounts and cards use different transaction paths; try the account path
    // first and fall back to the card path when the id is not a bank account.
    let results = await this.getData(
      `/data/v1/accounts/${input.providerAccountId}/transactions?${query}`,
      input.tokens.accessToken,
    );
    // TrueLayer uses OPPOSITE sign conventions on the two endpoints. For
    // accounts, a DEBIT is already negative. For cards, the docs state: "A
    // positive transaction amount reflects the flow of funds out of a card,
    // such as a purchase. A negative amount indicates the flow of funds into
    // the card, for example a refund." Actual expects the account convention
    // (spending negative), so card amounts must be negated.
    let fromCardEndpoint = false;
    if (results.length === 0) {
      results = await this.getData(
        `/data/v1/cards/${input.providerAccountId}/transactions?${query}`,
        input.tokens.accessToken,
      );
      fromCardEndpoint = results.length > 0;
    }

    return results.map((t) => {
      const tx = t as Record<string, unknown>;
      const amount = Number(tx.amount ?? 0);
      const signed = fromCardEndpoint ? -amount : amount;
      return {
        providerTransactionId: String(tx.transaction_id),
        providerAccountId: input.providerAccountId,
        bookedDate: String(tx.timestamp ?? "").slice(0, 10),
        description: String(tx.description ?? ""),
        amountMinor: Math.round(signed * 100),
        currency: String(tx.currency ?? "GBP"),
        merchantName:
          typeof tx.merchant_name === "string" ? tx.merchant_name : undefined,
        raw: tx,
      };
    });
  }

  async getConsentExpiry(): Promise<string | undefined> {
    return new Date(
      Date.now() + CONSENT_WINDOW_DAYS * 86_400_000,
    ).toISOString();
  }

  private async requestToken(
    body: Record<string, string>,
  ): Promise<TokenSet> {
    const response = await fetch(`${this.authBase}/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    if (!response.ok) {
      throw new Error(
        `TrueLayer token request failed with status ${response.status}`,
      );
    }
    const data = (await response.json()) as TokenResponse;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
      scope: data.scope,
      tokenType: data.token_type,
    };
  }

  private async getData(
    path: string,
    accessToken: string,
  ): Promise<unknown[]> {
    const response = await fetch(`${this.apiBase}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 404) return [];
    if (response.status === 401 || response.status === 403) {
      throw new AuthorizationError(
        `TrueLayer request to ${path} was unauthorized (status ${response.status}).`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `TrueLayer data request to ${path} failed with status ${response.status}`,
      );
    }
    const payload = (await response.json()) as { results?: unknown[] };
    return payload.results ?? [];
  }

  /** Best-effort account balance in minor units; undefined when unavailable. */
  private async getBalanceMinor(
    path: string,
    accessToken: string,
  ): Promise<number | undefined> {
    try {
      const results = await this.getData(path, accessToken);
      const first = results[0] as Record<string, unknown> | undefined;
      if (!first) return undefined;
      const value = first.current ?? first.available;
      if (typeof value !== "number") return undefined;
      return Math.round(value * 100);
    } catch {
      return undefined;
    }
  }
}

/**
 * Raised when the provider returns 401/403, indicating the token/consent is no
 * longer valid and the connection needs re-authentication (spec §15.3).
 */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}
