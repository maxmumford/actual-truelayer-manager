import type { Db } from "../index.js";
import type {
  SyncItemStatus,
  SyncMode,
  SyncRunRow,
  SyncStatus,
} from "../types.js";

export interface SyncRunCounts {
  fetched: number;
  imported: number;
  duplicate: number;
  skipped: number;
  failed: number;
}

export interface SyncRunItemInput {
  id: string;
  syncRunId: string;
  connectionId: string;
  providerAccountId: string;
  actualAccountId: string;
  providerTransactionId?: string;
  bookedDate?: string;
  amountMinor?: number;
  currency?: string;
  status: SyncItemStatus;
  message?: string;
}

export interface ImportedTransactionInput {
  id: string;
  provider: string;
  providerAccountId: string;
  providerTransactionId: string;
  actualAccountId: string;
  bookedDate: string;
  amountMinor: number;
  currency: string;
  syncRunId: string;
  /** Provider payload, already encrypted with the app key; never plaintext. */
  rawJsonEncrypted?: string | null;
}

export interface ImportedTransactionRow {
  id: string;
  provider: string;
  provider_account_id: string;
  provider_transaction_id: string;
  actual_account_id: string;
  booked_date: string;
  amount_minor: number;
  currency: string;
  imported_at: string;
  sync_run_id: string;
  raw_json_encrypted: string | null;
}

export interface ImportedTransactionQuery {
  providerTransactionId?: string;
  providerAccountId?: string;
  bookedDate?: string;
  amountMinor?: number;
}

export class SyncRunsRepo {
  constructor(private readonly db: Db) {}

  start(id: string, mode: SyncMode): void {
    this.db
      .prepare(
        `INSERT INTO sync_runs (id, mode, status, started_at) VALUES (?, ?, 'running', ?)`,
      )
      .run(id, mode, new Date().toISOString());
  }

  finish(id: string, status: SyncStatus, counts: SyncRunCounts, error?: string): void {
    this.db
      .prepare(
        `UPDATE sync_runs SET
           status = @status, finished_at = @finished_at,
           fetched_count = @fetched, imported_count = @imported,
           duplicate_count = @duplicate, skipped_count = @skipped,
           failed_count = @failed, error_message = @error
         WHERE id = @id`,
      )
      .run({
        id,
        status,
        finished_at: new Date().toISOString(),
        fetched: counts.fetched,
        imported: counts.imported,
        duplicate: counts.duplicate,
        skipped: counts.skipped,
        failed: counts.failed,
        error: error ?? null,
      });
  }

  addItem(input: SyncRunItemInput): void {
    this.db
      .prepare(
        `INSERT INTO sync_run_items
           (id, sync_run_id, connection_id, provider_account_id, actual_account_id,
            provider_transaction_id, booked_date, amount_minor, currency, status, message, created_at)
         VALUES (@id, @sync_run_id, @connection_id, @provider_account_id, @actual_account_id,
            @provider_transaction_id, @booked_date, @amount_minor, @currency, @status, @message, @created_at)`,
      )
      .run({
        id: input.id,
        sync_run_id: input.syncRunId,
        connection_id: input.connectionId,
        provider_account_id: input.providerAccountId,
        actual_account_id: input.actualAccountId,
        provider_transaction_id: input.providerTransactionId ?? null,
        booked_date: input.bookedDate ?? null,
        amount_minor: input.amountMinor ?? null,
        currency: input.currency ?? null,
        status: input.status,
        message: input.message ?? null,
        created_at: new Date().toISOString(),
      });
  }

  get(id: string): SyncRunRow | undefined {
    return this.db
      .prepare("SELECT * FROM sync_runs WHERE id = ?")
      .get(id) as SyncRunRow | undefined;
  }

  latest(): SyncRunRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM sync_runs WHERE mode != 'dry_run' ORDER BY started_at DESC LIMIT 1",
      )
      .get() as SyncRunRow | undefined;
  }

  recent(limit = 20): SyncRunRow[] {
    return this.db
      .prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as SyncRunRow[];
  }

  isImported(
    provider: string,
    providerAccountId: string,
    providerTransactionId: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM imported_transactions
         WHERE provider = ? AND provider_account_id = ? AND provider_transaction_id = ?`,
      )
      .get(provider, providerAccountId, providerTransactionId);
    return row !== undefined;
  }

  recordImported(input: ImportedTransactionInput): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO imported_transactions
           (id, provider, provider_account_id, provider_transaction_id, actual_account_id,
            booked_date, amount_minor, currency, imported_at, sync_run_id, raw_json_encrypted)
         VALUES (@id, @provider, @provider_account_id, @provider_transaction_id, @actual_account_id,
            @booked_date, @amount_minor, @currency, @imported_at, @sync_run_id, @raw_json_encrypted)`,
      )
      .run({
        id: input.id,
        provider: input.provider,
        provider_account_id: input.providerAccountId,
        provider_transaction_id: input.providerTransactionId,
        actual_account_id: input.actualAccountId,
        booked_date: input.bookedDate,
        amount_minor: input.amountMinor,
        currency: input.currency,
        imported_at: new Date().toISOString(),
        sync_run_id: input.syncRunId,
        raw_json_encrypted: input.rawJsonEncrypted ?? null,
      });
  }

  /** True when the imported row exists but has no raw payload stored yet. */
  isMissingRaw(
    provider: string,
    providerAccountId: string,
    providerTransactionId: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM imported_transactions
         WHERE provider = ? AND provider_account_id = ? AND provider_transaction_id = ?
           AND raw_json_encrypted IS NULL`,
      )
      .get(provider, providerAccountId, providerTransactionId);
    return row !== undefined;
  }

  /**
   * Fills in the raw payload on an already-imported row that has none (rows
   * imported before raw storage existed). Never overwrites a stored payload,
   * so the first copy the bank sent is the one kept.
   */
  attachRawIfMissing(
    provider: string,
    providerAccountId: string,
    providerTransactionId: string,
    rawJsonEncrypted: string,
  ): void {
    this.db
      .prepare(
        `UPDATE imported_transactions SET raw_json_encrypted = ?
         WHERE provider = ? AND provider_account_id = ? AND provider_transaction_id = ?
           AND raw_json_encrypted IS NULL`,
      )
      .run(rawJsonEncrypted, provider, providerAccountId, providerTransactionId);
  }

  /** Looks up imported rows by any combination of the given fields. */
  findImported(
    query: ImportedTransactionQuery,
    limit = 50,
  ): ImportedTransactionRow[] {
    const clauses: string[] = [];
    const params: Record<string, string | number> = { limit };
    if (query.providerTransactionId !== undefined) {
      clauses.push("provider_transaction_id = @provider_transaction_id");
      params.provider_transaction_id = query.providerTransactionId;
    }
    if (query.providerAccountId !== undefined) {
      clauses.push("provider_account_id = @provider_account_id");
      params.provider_account_id = query.providerAccountId;
    }
    if (query.bookedDate !== undefined) {
      clauses.push("booked_date = @booked_date");
      params.booked_date = query.bookedDate;
    }
    if (query.amountMinor !== undefined) {
      clauses.push("amount_minor = @amount_minor");
      params.amount_minor = query.amountMinor;
    }
    if (clauses.length === 0) return [];
    return this.db
      .prepare(
        `SELECT * FROM imported_transactions WHERE ${clauses.join(" AND ")}
         ORDER BY booked_date DESC, imported_at DESC LIMIT @limit`,
      )
      .all(params) as ImportedTransactionRow[];
  }
}
