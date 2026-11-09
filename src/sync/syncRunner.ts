import { randomUUID } from "node:crypto";
import type { ActualClient } from "../actual/actualClient.js";
import type { AppConfig } from "../config/env.js";
import type { ConnectionsRepo } from "../db/repositories/connections.repo.js";
import type { MappingsRepo } from "../db/repositories/mappings.repo.js";
import type { SyncRunsRepo } from "../db/repositories/syncRuns.repo.js";
import type { Encryptor } from "../crypto/encrypt.js";
import type { AccountMappingRow } from "../db/types.js";
import type {
  BankTransaction,
  BankingProvider,
  TokenSet,
} from "../providers/bankingProvider.js";
import { AuthorizationError } from "../providers/truelayer/truelayerProvider.js";
import { normaliseTransaction } from "./normalise.js";

export interface SyncOptions {
  dryRun: boolean;
  mode: "manual" | "scheduled" | "live" | "dry_run";
}

export interface SyncSummary {
  runId: string;
  fetched: number;
  imported: number;
  duplicate: number;
  skipped: number;
  failed: number;
  status: "success" | "partial" | "failed";
}

export interface SyncRunnerDeps {
  config: AppConfig;
  provider: BankingProvider;
  actual: ActualClient;
  connections: ConnectionsRepo;
  mappings: MappingsRepo;
  syncRuns: SyncRunsRepo;
  /**
   * Encrypts the provider's raw transaction payload for storage. Pass it only
   * when the app has a durable key: without one the payload is not stored at
   * all, rather than stored in plaintext or under a key that may be lost.
   */
  rawEncryptor?: Encryptor | null;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/** Refresh a token this many milliseconds before it actually expires. */
const TOKEN_REFRESH_SKEW_MS = 120_000;

/**
 * Executes a sync across all enabled account mappings (spec §13). Supports both
 * dry-run (fetch/normalise/dedupe, import nothing) and live import, records a
 * `sync_runs` row plus per-transaction `sync_run_items`, de-duplicates via the
 * `imported_transactions` table, refreshes provider tokens as needed, and marks
 * connections `reauth_required` when their consent/token is no longer valid.
 */
export class SyncRunner {
  constructor(private readonly deps: SyncRunnerDeps) {}

  async run(options: SyncOptions): Promise<SyncSummary> {
    const runId = randomUUID();
    const counts = { fetched: 0, imported: 0, duplicate: 0, skipped: 0, failed: 0 };

    this.deps.syncRuns.start(runId, options.mode);

    const to = new Date();
    const mappingsByConnection = this.groupByConnection(
      this.deps.mappings.listEnabled(),
    );

    try {
      for (const [connectionId, mappings] of mappingsByConnection) {
        await this.syncConnection(runId, connectionId, mappings, to, options, counts);
      }

      const status: SyncSummary["status"] =
        counts.failed > 0
          ? counts.imported > 0 || counts.duplicate > 0
            ? "partial"
            : "failed"
          : "success";

      this.deps.syncRuns.finish(runId, status, counts);
      return { runId, ...counts, status };
    } catch (error) {
      this.deps.syncRuns.finish(
        runId,
        "failed",
        counts,
        error instanceof Error ? error.message : "sync failed",
      );
      return { runId, ...counts, status: "failed" };
    }
  }

  private async syncConnection(
    runId: string,
    connectionId: string,
    mappings: AccountMappingRow[],
    to: Date,
    options: SyncOptions,
    counts: SyncRunCounts,
  ): Promise<void> {
    const connection = this.deps.connections.get(connectionId);
    if (!connection || connection.status === "disabled") {
      counts.skipped += mappings.length;
      return;
    }

    let tokens = this.deps.connections.getTokens(connectionId);
    if (!tokens) {
      counts.skipped += mappings.length;
      for (const mapping of mappings) {
        this.record(runId, mapping, undefined, "skipped", "no tokens");
      }
      return;
    }

    try {
      tokens = await this.ensureFreshToken(connectionId, tokens);
    } catch (error) {
      this.markReauthRequired(connectionId, error);
      counts.failed += mappings.length;
      for (const mapping of mappings) {
        this.record(runId, mapping, undefined, "failed", "token refresh failed");
      }
      return;
    }

    const balances = await this.loadProviderBalances(tokens);

    for (const mapping of mappings) {
      const authFailed = await this.syncMapping(
        runId,
        mapping,
        tokens,
        to,
        options,
        counts,
        balances,
      );
      if (authFailed) {
        this.markReauthRequired(connectionId);
        // Remaining mappings on this connection would fail the same way.
        break;
      }
    }
  }

  /** Returns true when the mapping failed due to an authorization error. */
  private async syncMapping(
    runId: string,
    mapping: AccountMappingRow,
    tokens: TokenSet,
    to: Date,
    options: SyncOptions,
    counts: SyncRunCounts,
    balances: Map<string, number>,
  ): Promise<boolean> {
    const provider = this.deps.provider;
    const from = this.computeFrom(mapping.last_successful_sync_at, to);

    let transactions;
    try {
      transactions = await provider.listTransactions({
        tokens,
        providerAccountId: mapping.provider_account_id,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
      });
    } catch (error) {
      counts.failed += 1;
      this.record(
        runId,
        mapping,
        undefined,
        "failed",
        error instanceof Error ? error.message : "fetch failed",
      );
      return error instanceof AuthorizationError;
    }

    const toImport = [];
    for (const tx of transactions) {
      counts.fetched += 1;
      const normalised = normaliseTransaction(
        provider.name,
        tx,
        mapping.actual_account_id,
      );

      if (
        this.deps.syncRuns.isImported(
          provider.name,
          mapping.provider_account_id,
          normalised.importedId,
        )
      ) {
        counts.duplicate += 1;
        if (!options.dryRun) {
          this.backfillRaw(provider.name, mapping.provider_account_id, normalised.importedId, tx);
        }
        this.record(runId, mapping, tx.amountMinor, "duplicate", undefined, tx.bookedDate, normalised.importedId);
        continue;
      }

      if (options.dryRun) {
        this.record(runId, mapping, tx.amountMinor, "would_import", undefined, tx.bookedDate, normalised.importedId);
        toImport.push({ normalised, tx });
        continue;
      }

      toImport.push({ normalised, tx });
    }

    if (!options.dryRun && toImport.length > 0) {
      await this.deps.actual.importTransactions(
        mapping.actual_account_id,
        toImport.map((t) => t.normalised),
      );
      for (const { normalised, tx } of toImport) {
        this.deps.syncRuns.recordImported({
          id: randomUUID(),
          provider: provider.name,
          providerAccountId: mapping.provider_account_id,
          providerTransactionId: normalised.importedId,
          actualAccountId: mapping.actual_account_id,
          bookedDate: tx.bookedDate,
          amountMinor: tx.amountMinor,
          currency: tx.currency,
          syncRunId: runId,
          rawJsonEncrypted: this.encryptRaw(tx),
        });
        counts.imported += 1;
        this.record(runId, mapping, tx.amountMinor, "imported", undefined, tx.bookedDate, normalised.importedId);
      }
    }

    if (!options.dryRun) {
      this.deps.mappings.markSynced(mapping.id, to.toISOString());
      await this.checkBalanceDrift(mapping, balances);
    }

    return false;
  }

  /**
   * Encrypts the provider payload for storage, or returns null when there is
   * no payload, no durable key, or it cannot be serialised. Storing the raw
   * copy is diagnostic only, so it must never fail an import, and its content
   * is never logged.
   */
  private encryptRaw(tx: BankTransaction): string | null {
    const encryptor = this.deps.rawEncryptor;
    if (!encryptor || tx.raw === undefined) return null;
    try {
      const json = JSON.stringify(tx.raw);
      return json === undefined ? null : encryptor.encrypt(json);
    } catch {
      return null;
    }
  }

  /** Attaches a raw payload to an already-imported row that has none. */
  private backfillRaw(
    provider: string,
    providerAccountId: string,
    importedId: string,
    tx: BankTransaction,
  ): void {
    if (!this.deps.rawEncryptor || tx.raw === undefined) return;
    if (!this.deps.syncRuns.isMissingRaw(provider, providerAccountId, importedId)) {
      return;
    }
    const encrypted = this.encryptRaw(tx);
    if (encrypted) {
      this.deps.syncRuns.attachRawIfMissing(provider, providerAccountId, importedId, encrypted);
    }
  }

  /**
   * Refreshes the connection token when it is missing an expiry or is close to
   * expiring, persisting the new token set (spec §13.1 steps 2–4).
   */
  private async ensureFreshToken(
    connectionId: string,
    tokens: TokenSet,
  ): Promise<TokenSet> {
    if (!this.isExpiring(tokens.expiresAt)) {
      return tokens;
    }
    const refreshed = await this.deps.provider.refreshToken({
      refreshToken: tokens.refreshToken,
    });
    this.deps.connections.saveTokens(connectionId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || tokens.refreshToken,
      expiresAt: refreshed.expiresAt,
      scope: refreshed.scope,
      tokenType: refreshed.tokenType,
    });
    this.deps.logger?.info(`Refreshed token for connection ${connectionId}`);
    return {
      ...refreshed,
      refreshToken: refreshed.refreshToken || tokens.refreshToken,
    };
  }

  private isExpiring(expiresAt: string | undefined): boolean {
    if (!expiresAt) return false;
    const expiry = new Date(expiresAt).getTime();
    if (Number.isNaN(expiry)) return false;
    return expiry - Date.now() <= TOKEN_REFRESH_SKEW_MS;
  }

  private markReauthRequired(connectionId: string, error?: unknown): void {
    this.deps.connections.setStatus(connectionId, "reauth_required");
    const detail = error instanceof Error ? `: ${error.message}` : "";
    this.deps.logger?.warn(
      `Connection ${connectionId} needs re-authentication${detail}`,
    );
  }

  /** Best-effort snapshot of current provider balances keyed by account id. */
  private async loadProviderBalances(
    tokens: TokenSet,
  ): Promise<Map<string, number>> {
    const balances = new Map<string, number>();
    if (this.deps.config.balanceDriftWarningMinor < 0) return balances;
    try {
      const accounts = await this.deps.provider.listAccounts({ tokens });
      for (const account of accounts) {
        if (typeof account.balanceMinor === "number") {
          balances.set(account.providerAccountId, account.balanceMinor);
        }
      }
    } catch {
      // Balances are non-critical; ignore failures.
    }
    return balances;
  }

  private async checkBalanceDrift(
    mapping: AccountMappingRow,
    balances: Map<string, number>,
  ): Promise<void> {
    const providerBalance = balances.get(mapping.provider_account_id);
    if (providerBalance === undefined) return;
    if (!this.deps.actual.getAccountBalance) return;

    const actualBalance = await this.deps.actual.getAccountBalance(
      mapping.actual_account_id,
    );
    if (actualBalance === undefined) return;

    const drift = Math.abs(providerBalance - actualBalance);
    if (drift > this.deps.config.balanceDriftWarningMinor) {
      this.deps.logger?.warn(
        `Balance drift on ${mapping.actual_account_name}: provider ${providerBalance} vs Actual ${actualBalance} (minor units, drift ${drift})`,
      );
    }
  }

  private groupByConnection(
    mappings: AccountMappingRow[],
  ): Map<string, AccountMappingRow[]> {
    const grouped = new Map<string, AccountMappingRow[]>();
    for (const mapping of mappings) {
      const list = grouped.get(mapping.connection_id) ?? [];
      list.push(mapping);
      grouped.set(mapping.connection_id, list);
    }
    return grouped;
  }

  private computeFrom(lastSyncedAt: string | null, to: Date): Date {
    if (!lastSyncedAt) {
      return new Date(to.getTime() - this.deps.config.syncDaysLookback * 86_400_000);
    }
    return new Date(
      new Date(lastSyncedAt).getTime() -
        this.deps.config.syncOverlapDays * 86_400_000,
    );
  }

  private record(
    runId: string,
    mapping: {
      connection_id: string;
      provider_account_id: string;
      actual_account_id: string;
    },
    amountMinor: number | undefined,
    status: "fetched" | "would_import" | "imported" | "duplicate" | "skipped" | "failed",
    message?: string,
    bookedDate?: string,
    providerTransactionId?: string,
  ): void {
    this.deps.syncRuns.addItem({
      id: randomUUID(),
      syncRunId: runId,
      connectionId: mapping.connection_id,
      providerAccountId: mapping.provider_account_id,
      actualAccountId: mapping.actual_account_id,
      providerTransactionId,
      bookedDate,
      amountMinor,
      currency: "GBP",
      status,
      message,
    });
  }
}

interface SyncRunCounts {
  fetched: number;
  imported: number;
  duplicate: number;
  skipped: number;
  failed: number;
}
