import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createActualClient,
  resolveActualCredentials,
} from "./actual/factory.js";
import type { ActualClient } from "./actual/actualClient.js";
import type { AppConfig } from "./config/env.js";
import { loadEncryptor } from "./config/secrets.js";
import { createEncryptor, type Encryptor } from "./crypto/encrypt.js";
import { openDatabase, type Db } from "./db/index.js";
import { ActualRepo } from "./db/repositories/actual.repo.js";
import { ConnectionsRepo } from "./db/repositories/connections.repo.js";
import { MappingsRepo } from "./db/repositories/mappings.repo.js";
import { SettingsRepo } from "./db/repositories/settings.repo.js";
import { SyncRunsRepo } from "./db/repositories/syncRuns.repo.js";
import { LogBuffer } from "./logging/logBuffer.js";
import { createProvider, resolveTrueLayerConfig } from "./providers/registry.js";
import type { BankingProvider } from "./providers/bankingProvider.js";
import { SyncRunner } from "./sync/syncRunner.js";

export interface Services {
  config: AppConfig;
  db: Db;
  encryptor: Encryptor | null;
  /** True when the encryption key comes from APP_ENCRYPTION_KEY(_FILE). */
  hasDurableKey: boolean;
  settings: SettingsRepo;
  actualRepo: ActualRepo;
  connections: ConnectionsRepo;
  mappings: MappingsRepo;
  syncRuns: SyncRunsRepo;
  logs: LogBuffer;
  getProvider(): BankingProvider;
  invalidateProvider(): void;
  getActualClient(): ActualClient;
  invalidateActualClient(): void;
  /** True when the active banking provider is the built-in demo. */
  isDemoProvider(): boolean;
  createSyncRunner(): SyncRunner;
  close(): void;
}

interface ResolvedEncryptor {
  encryptor: Encryptor | null;
  durable: boolean;
}

/**
 * In demo mode without a configured key, generate/persist an ephemeral key so
 * the (fake) tokens can still be stored encrypted rather than in plaintext.
 */
function resolveEncryptor(config: AppConfig): ResolvedEncryptor {
  const configured = loadEncryptor();
  if (configured) return { encryptor: configured, durable: true };
  if (!config.demoMode) return { encryptor: null, durable: false };

  mkdirSync(config.dataDir, { recursive: true });
  const keyPath = join(config.dataDir, "demo-encryption.key");
  let key: string;
  if (existsSync(keyPath)) {
    key = readFileSync(keyPath, "utf8").trim();
  } else {
    key = randomBytes(32).toString("base64");
    writeFileSync(keyPath, key, { mode: 0o600 });
  }
  return { encryptor: createEncryptor(key), durable: false };
}

export function buildServices(config: AppConfig): Services {
  const db = openDatabase(config.dbPath);
  const { encryptor, durable } = resolveEncryptor(config);
  const logs = new LogBuffer();

  const settings = new SettingsRepo(db);
  const actualRepo = new ActualRepo(db);
  const connections = new ConnectionsRepo(db, encryptor);
  const mappings = new MappingsRepo(db);
  const syncRuns = new SyncRunsRepo(db);

  const decrypt = (value: string): string =>
    encryptor ? encryptor.decrypt(value) : value;

  let cachedProvider: BankingProvider | null = null;
  const getProvider = (): BankingProvider => {
    if (cachedProvider) return cachedProvider;
    let resolved = null;
    if (encryptor) {
      try {
        resolved = resolveTrueLayerConfig(config, settings, decrypt);
      } catch (error) {
        logs.warn(
          `Could not read stored TrueLayer credentials: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
    cachedProvider = createProvider(config, resolved);
    return cachedProvider;
  };
  const invalidateProvider = (): void => {
    cachedProvider = null;
  };

  let cachedActual: ActualClient | null = null;
  const getActualClient = (): ActualClient => {
    if (cachedActual) return cachedActual;
    const credentials = resolveActualCredentials(
      config,
      actualRepo.get(),
      decrypt,
    );
    cachedActual = createActualClient(config, credentials);
    return cachedActual;
  };
  const invalidateActualClient = (): void => {
    void cachedActual?.shutdown().catch(() => undefined);
    cachedActual = null;
  };

  const createSyncRunner = (): SyncRunner =>
    new SyncRunner({
      config,
      provider: getProvider(),
      actual: getActualClient(),
      connections,
      mappings,
      syncRuns,
      rawEncryptor: durable ? encryptor : null,
      logger: {
        info: (m) => logs.info(m),
        warn: (m) => logs.warn(m),
      },
    });

  return {
    config,
    db,
    encryptor,
    hasDurableKey: durable,
    settings,
    actualRepo,
    connections,
    mappings,
    syncRuns,
    logs,
    getProvider,
    invalidateProvider,
    getActualClient,
    invalidateActualClient,
    isDemoProvider: () => getProvider().name === "demo",
    createSyncRunner,
    close: () => db.close(),
  };
}
