import { randomUUID } from "node:crypto";
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

const MERCHANTS = [
  "Tesco",
  "Sainsbury's",
  "Amazon UK",
  "TfL Travel",
  "Pret A Manger",
  "British Gas",
  "Netflix",
  "Spotify",
  "Shell",
  "Deliveroo",
];

/**
 * A fully in-memory banking provider used when no live TrueLayer credentials
 * are configured. It generates a stable set of accounts and deterministic-ish
 * transactions so the entire setup + sync flow can be demonstrated end to end.
 */
export class DemoProvider implements BankingProvider {
  readonly name = "demo";

  async createAuthUrl(input: CreateAuthUrlInput): Promise<string> {
    // In demo mode the "auth" is completed instantly by the connect route; this
    // URL is only shown for illustration.
    const params = new URLSearchParams({
      state: input.state,
      redirect_uri: input.redirectUri,
      scope: input.connectionType,
    });
    return `https://demo-bank.example/auth?${params.toString()}`;
  }

  async exchangeAuthCode(_input: ExchangeAuthCodeInput): Promise<TokenSet> {
    return this.mintTokens();
  }

  async refreshToken(_input: RefreshTokenInput): Promise<TokenSet> {
    return this.mintTokens();
  }

  async getConsentExpiry(): Promise<string | undefined> {
    return new Date(Date.now() + 90 * 86_400_000).toISOString();
  }

  async listAccounts(_input: ListAccountsInput): Promise<BankAccount[]> {
    return [
      {
        providerAccountId: "demo-current",
        displayName: "Demo Current Account",
        accountType: "transaction",
        currency: "GBP",
        sortCode: "04-00-04",
        accountNumberLast4: "1234",
        balanceMinor: 154210,
      },
      {
        providerAccountId: "demo-savings",
        displayName: "Demo Savings",
        accountType: "savings",
        currency: "GBP",
        accountNumberLast4: "9876",
        balanceMinor: 500000,
      },
      {
        providerAccountId: "demo-credit",
        displayName: "Demo Credit Card",
        accountType: "credit_card",
        currency: "GBP",
        accountNumberLast4: "4321",
        balanceMinor: -23050,
      },
    ];
  }

  async listTransactions(
    input: ListTransactionsInput,
  ): Promise<BankTransaction[]> {
    const from = new Date(input.from);
    const to = new Date(input.to);
    const days = Math.max(
      1,
      Math.round((to.getTime() - from.getTime()) / 86_400_000),
    );
    const count = Math.min(days, 8);

    const txns: BankTransaction[] = [];
    for (let i = 0; i < count; i++) {
      const date = new Date(to.getTime() - i * 86_400_000);
      const bookedDate = date.toISOString().slice(0, 10);
      const merchant = MERCHANTS[i % MERCHANTS.length] ?? "Unknown";
      const isCredit = input.providerAccountId === "demo-credit";
      const amountMinor = isCredit
        ? -(500 + i * 137)
        : i % 3 === 0
          ? 250000 // occasional salary/credit
          : -(320 + i * 211);

      txns.push({
        // Stable ID per account/date so repeated syncs dedupe correctly.
        providerTransactionId: `${input.providerAccountId}-${bookedDate}-${i}`,
        providerAccountId: input.providerAccountId,
        bookedDate,
        description: `${merchant} purchase`,
        amountMinor,
        currency: "GBP",
        merchantName: merchant,
        raw: {
          transaction_id: `${input.providerAccountId}-${bookedDate}-${i}`,
          timestamp: `${bookedDate}T00:00:00Z`,
          description: `${merchant} purchase`,
          amount: amountMinor / 100,
          currency: "GBP",
          merchant_name: merchant,
        },
      });
    }
    return txns;
  }

  private mintTokens(): TokenSet {
    return {
      accessToken: `demo-access-${randomUUID()}`,
      refreshToken: `demo-refresh-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: "accounts transactions",
      tokenType: "Bearer",
    };
  }
}
