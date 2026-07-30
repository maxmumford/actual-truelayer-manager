import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Services } from "../../services.js";
import { finaliseConnection } from "../connectionFlow.js";
import { parseRedirectUrl } from "../../providers/truelayer/auth.js";
import { bodyStr, readFlash, withFlash } from "../flash.js";
import { setupPage, type SetupViewModel } from "../views/setup.js";
import { connectPage } from "../views/connect.js";

function buildSetupModel(services: Services): Omit<SetupViewModel, "flash"> {
  const actualConfig = services.actualRepo.get();
  const clientId =
    services.config.truelayer.clientId ??
    services.settings.get("truelayer.client_id");
  const demoMode = services.isDemoProvider();

  const warnings: string[] = [];
  if (!demoMode && !services.hasDurableKey) {
    warnings.push(
      "No durable APP_ENCRYPTION_KEY is configured. Set one before connecting a real bank — banking tokens must not be stored under an ephemeral key.",
    );
  }

  return {
    demoMode,
    warnings,
    actual: {
      configured: Boolean(actualConfig),
      serverUrl: actualConfig?.server_url,
      syncId: actualConfig?.sync_id,
    },
    truelayer: {
      configured: Boolean(clientId),
      clientId,
      redirectMode:
        services.settings.get("truelayer.redirect_mode") ??
        services.config.truelayer.redirectMode,
    },
    connectionCount: services.connections.list().length,
    mappingCount: services.mappings.list().length,
    scheduleHours: Number(
      services.settings.get("schedule.interval_hours") ??
        services.config.syncIntervalHours,
    ),
  };
}

export async function setupRoutes(
  app: FastifyInstance,
  services: Services,
): Promise<void> {
  app.get("/", async (_request, reply) => reply.redirect("/setup"));

  app.get("/setup", async (request, reply) => {
    const model = buildSetupModel(services);
    return reply
      .type("text/html")
      .send(setupPage({ ...model, flash: readFlash(request.query) }));
  });

  app.post("/setup/actual", async (request, reply) => {
    const serverUrl = bodyStr(request.body, "server_url");
    const syncId = bodyStr(request.body, "sync_id");
    const password = bodyStr(request.body, "password");
    const encryptionPassword = bodyStr(request.body, "encryption_password");

    if (!serverUrl || !syncId) {
      return reply.redirect(
        withFlash("/setup", "error", "Server URL and sync ID are required."),
      );
    }

    const existing = services.actualRepo.get();
    const enc = services.encryptor;
    services.actualRepo.upsert({
      serverUrl,
      syncId,
      passwordEncrypted: password
        ? enc?.encrypt(password) ?? null
        : (existing?.password_encrypted ?? null),
      encryptionPasswordEncrypted: encryptionPassword
        ? enc?.encrypt(encryptionPassword) ?? null
        : (existing?.encryption_password_encrypted ?? null),
    });

    services.invalidateActualClient();
    const test = await services.getActualClient().testConnection();
    services.logs.info(`Actual connection test: ${test.message}`);
    return reply.redirect(
      withFlash(
        "/setup",
        test.ok ? "ok" : "error",
        `Actual saved. ${test.message}`,
      ),
    );
  });

  app.post("/setup/truelayer", async (request, reply) => {
    const clientId = bodyStr(request.body, "client_id");
    const clientSecret = bodyStr(request.body, "client_secret");
    const redirectMode = bodyStr(request.body, "redirect_mode") || "manual";

    if (!clientId) {
      return reply.redirect(
        withFlash("/setup", "error", "TrueLayer client ID is required."),
      );
    }
    services.settings.set("truelayer.client_id", clientId);
    services.settings.set("truelayer.redirect_mode", redirectMode);
    if (clientSecret) {
      if (!services.encryptor) {
        return reply.redirect(
          withFlash(
            "/setup",
            "error",
            "Cannot store the TrueLayer client secret without an encryption key. Set APP_ENCRYPTION_KEY first.",
          ),
        );
      }
      services.settings.set(
        "truelayer.client_secret_enc",
        services.encryptor.encrypt(clientSecret),
      );
    }
    services.invalidateProvider();
    services.logs.info("TrueLayer credentials saved");
    return reply.redirect(withFlash("/setup", "ok", "TrueLayer config saved."));
  });

  app.post("/setup/schedule", async (request, reply) => {
    const hours = Number.parseInt(bodyStr(request.body, "interval_hours"), 10);
    const safe = Number.isNaN(hours) || hours < 0 ? 0 : hours;
    services.settings.set("schedule.interval_hours", String(safe));
    return reply.redirect(
      withFlash(
        "/setup",
        "ok",
        safe > 0 ? `Scheduled sync every ${safe}h.` : "Scheduled sync disabled.",
      ),
    );
  });

  app.post("/connections/add", async (request, reply) => {
    const displayName = bodyStr(request.body, "display_name") || "Bank";
    const connectionType =
      bodyStr(request.body, "connection_type") === "credit_card"
        ? "credit_card"
        : "bank_account";

    const provider = services.getProvider();
    const isDemo = provider.name === "demo";

    if (!isDemo && !services.hasDurableKey) {
      return reply.redirect(
        withFlash(
          "/setup",
          "error",
          "Set a durable APP_ENCRYPTION_KEY before connecting a real bank.",
        ),
      );
    }

    const connectionId = randomUUID();
    services.connections.create({
      id: connectionId,
      provider: provider.name,
      displayName,
      connectionType,
      status: "setup_pending",
    });

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

    if (isDemo) {
      const tokens = await provider.exchangeAuthCode({
        code: "demo-code",
        redirectUri,
      });
      const count = await finaliseConnection(
        services,
        provider,
        connectionId,
        tokens,
      );
      return reply.redirect(
        withFlash(
          "/mappings",
          "ok",
          `Connected "${displayName}" with ${count} accounts. Now map them.`,
        ),
      );
    }

    return reply
      .type("text/html")
      .send(
        connectPage({
          connectionId,
          authUrl,
          redirectMode: redirectMode === "direct" ? "direct" : "manual",
        }),
      );
  });

  app.post("/oauth/exchange", async (request, reply) => {
    const redirectUrl = bodyStr(request.body, "redirect_url");
    try {
      const provider = services.getProvider();
      const parsed = parseRedirectUrl(redirectUrl);
      // Trust the `state` echoed back by the provider, not the connection_id in
      // the form body: the state is what we generated and stored in
      // /connections/add, so it is the only value tying this authorization code
      // to the connection the user actually started. This mirrors what
      // /oauth/truelayer/callback already does.
      if (!parsed.state) {
        throw new Error(
          "No 'state' parameter found in the pasted redirect URL.",
        );
      }
      const connectionId = services.settings.get(
        `oauth.state.${parsed.state}`,
      );
      if (!connectionId) {
        throw new Error("Unknown OAuth state.");
      }
      const tokens = await provider.exchangeAuthCode({
        code: parsed.code,
        redirectUri: "https://console.truelayer.com/redirect-page",
      });
      const count = await finaliseConnection(
        services,
        provider,
        connectionId,
        tokens,
      );
      return reply.redirect(
        withFlash("/mappings", "ok", `Connected with ${count} accounts.`),
      );
    } catch (error) {
      return reply.redirect(
        withFlash(
          "/setup",
          "error",
          error instanceof Error ? error.message : "Failed to exchange code.",
        ),
      );
    }
  });

  app.get("/oauth/truelayer/callback", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const code = query.code;
    const state = query.state;
    if (!code || !state) {
      return reply.redirect(
        withFlash("/setup", "error", "Missing code or state in callback."),
      );
    }
    const connectionId = state
      ? services.settings.get(`oauth.state.${state}`)
      : undefined;
    if (!connectionId) {
      return reply.redirect(
        withFlash("/setup", "error", "Unknown OAuth state."),
      );
    }
    try {
      const provider = services.getProvider();
      const tokens = await provider.exchangeAuthCode({
        code,
        redirectUri: `${services.config.baseUrl}/oauth/truelayer/callback`,
      });
      const count = await finaliseConnection(
        services,
        provider,
        connectionId,
        tokens,
      );
      return reply.redirect(
        withFlash("/mappings", "ok", `Connected with ${count} accounts.`),
      );
    } catch (error) {
      return reply.redirect(
        withFlash(
          "/setup",
          "error",
          error instanceof Error ? error.message : "Callback failed.",
        ),
      );
    }
  });
}
