export interface Migration {
  name: string;
  sql: string;
}

/**
 * Ordered list of schema migrations (spec §9). Applied in array order; each is
 * recorded in `schema_migrations` and only ever runs once.
 */
export const MIGRATIONS: Migration[] = [
  {
    name: "001_init",
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE actual_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        server_url TEXT NOT NULL,
        sync_id TEXT NOT NULL,
        password_encrypted TEXT,
        encryption_password_encrypted TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE bank_connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        display_name TEXT NOT NULL,
        connection_type TEXT NOT NULL,
        status TEXT NOT NULL,
        consent_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE provider_tokens (
        connection_id TEXT PRIMARY KEY,
        access_token_encrypted TEXT NOT NULL,
        refresh_token_encrypted TEXT NOT NULL,
        expires_at TEXT,
        scope TEXT,
        token_type TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES bank_connections(id)
      );

      CREATE TABLE provider_accounts (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        account_type TEXT NOT NULL,
        currency TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, provider_account_id),
        FOREIGN KEY (connection_id) REFERENCES bank_connections(id)
      );

      CREATE TABLE account_mappings (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        actual_account_id TEXT NOT NULL,
        actual_account_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_successful_sync_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(connection_id, provider_account_id),
        FOREIGN KEY (connection_id) REFERENCES bank_connections(id)
      );

      CREATE TABLE sync_runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        fetched_count INTEGER NOT NULL DEFAULT 0,
        imported_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      );

      CREATE TABLE sync_run_items (
        id TEXT PRIMARY KEY,
        sync_run_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        actual_account_id TEXT NOT NULL,
        provider_transaction_id TEXT,
        booked_date TEXT,
        amount_minor INTEGER,
        currency TEXT,
        status TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (sync_run_id) REFERENCES sync_runs(id)
      );

      CREATE TABLE imported_transactions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        provider_transaction_id TEXT NOT NULL,
        actual_account_id TEXT NOT NULL,
        booked_date TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        sync_run_id TEXT NOT NULL,
        UNIQUE(provider, provider_account_id, provider_transaction_id)
      );
    `,
  },
  {
    // The provider's raw transaction payload, encrypted with the app key, so an
    // odd-looking transaction can be investigated later against exactly what
    // the bank sent. Nullable: rows imported before this existed, and every
    // row on an install without a durable key, carry none.
    name: "002_imported_transactions_raw",
    sql: `
      ALTER TABLE imported_transactions ADD COLUMN raw_json_encrypted TEXT;
    `,
  },
];
