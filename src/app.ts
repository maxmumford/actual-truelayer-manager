import { timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import formbody from "@fastify/formbody";
import { loadConfig, type AppConfig } from "./config/env.js";
import { buildServices, type Services } from "./services.js";
import { healthRoutes } from "./server/routes/health.routes.js";
import { statusRoutes } from "./server/routes/status.routes.js";
import { setupRoutes } from "./server/routes/setup.routes.js";
import { dashboardRoutes } from "./server/routes/dashboard.routes.js";
import { connectionsRoutes } from "./server/routes/connections.routes.js";
import { mappingsRoutes } from "./server/routes/mappings.routes.js";
import { syncRoutes } from "./server/routes/sync.routes.js";
import { logsRoutes } from "./server/routes/logs.routes.js";

export interface BuildAppOptions {
  logLevel?: string;
  config?: AppConfig;
  services?: Services;
}

/** Ephemeral demo config used by tests when none is supplied. */
function defaultTestConfig(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "atm-test-"));
  return loadConfig({
    DEMO_MODE: "1",
    APP_DATA_DIR: dir,
    APP_DB_PATH: ":memory:",
  });
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logLevel
      ? {
          level: options.logLevel,
          redact: {
            censor: "***",
            paths: [
              "req.headers.authorization",
              "*.access_token",
              "*.refresh_token",
              "*.client_secret",
              "*.password",
              "*.encryption_password",
            ],
          },
          serializers: {
            // Fastify's default request serializer logs the full URL including
            // its query string. GET /oauth/truelayer/callback?code=…&state=…
            // would therefore write a live OAuth authorization code to stdout
            // in cleartext on every request-logged callback. Keep the path for
            // diagnostics and drop the query entirely.
            req(request: FastifyRequest) {
              const [path] = request.url.split("?");
              return {
                method: request.method,
                url: path,
                host: request.host,
                remoteAddress: request.ip,
                remotePort: request.socket.remotePort,
              };
            },
          },
        }
      : false,
  });

  const ownsServices = !options.services;
  const services =
    options.services ?? buildServices(options.config ?? defaultTestConfig());

  await app.register(formbody);

  registerBasicAuth(app, services.config);

  await app.register(async (instance) => healthRoutes(instance));
  await app.register(async (instance) => statusRoutes(instance, services));
  await app.register(async (instance) => setupRoutes(instance, services));
  await app.register(async (instance) => dashboardRoutes(instance, services));
  await app.register(async (instance) => connectionsRoutes(instance, services));
  await app.register(async (instance) => mappingsRoutes(instance, services));
  await app.register(async (instance) => syncRoutes(instance, services));
  await app.register(async (instance) => logsRoutes(instance, services));

  if (ownsServices) {
    app.addHook("onClose", async () => {
      services.close();
    });
  }

  return app;
}

/** Constant-time string comparison that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Optional built-in HTTP Basic Auth (spec §16.4). Enabled only when both
 * APP_BASIC_AUTH_USER and APP_BASIC_AUTH_PASSWORD are set. `/health` is always
 * left open so container/orchestrator health checks keep working.
 */
function registerBasicAuth(app: FastifyInstance, config: AppConfig): void {
  const { user, password } = config.basicAuth;
  if (!user || !password) return;

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;

    const header = request.headers.authorization ?? "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const index = decoded.indexOf(":");
      if (index !== -1) {
        const suppliedUser = decoded.slice(0, index);
        const suppliedPassword = decoded.slice(index + 1);
        if (safeEqual(suppliedUser, user) && safeEqual(suppliedPassword, password)) {
          return;
        }
      }
    }

    await reply
      .header("WWW-Authenticate", 'Basic realm="actual-truelayer-manager"')
      .code(401)
      .send("Authentication required.");
  });
}
