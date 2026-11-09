import type { FastifyInstance } from "fastify";
import type { Services } from "../../services.js";
import { beginAuthorisation, finaliseConnection } from "../connectionFlow.js";
import { readFlash, withFlash } from "../flash.js";
import { connectionsPage } from "../views/connections.js";

export async function connectionsRoutes(
  app: FastifyInstance,
  services: Services,
): Promise<void> {
  app.get("/connections", async (request, reply) => {
    const connections = services.connections.list().map((c) => ({
      ...c,
      accounts: services.connections.listProviderAccounts(c.id),
    }));
    return reply
      .type("text/html")
      .send(connectionsPage({ connections, flash: readFlash(request.query) }));
  });

  // A full bank login against THIS connection — the fix when TrueLayer refuses
  // the stored refresh token (400 invalid_grant), which a refresh never can be.
  app.post("/connections/:id/reauthorise", async (request, reply) => {
    const { id } = request.params as { id: string };
    const connection = services.connections.get(id);
    if (!connection) {
      return reply.redirect(
        withFlash("/connections", "error", "Connection not found."),
      );
    }
    try {
      const started = await beginAuthorisation(
        services,
        services.getProvider(),
        id,
        connection.connection_type === "credit_card"
          ? "credit_card"
          : "bank_account",
      );
      if ("accounts" in started) {
        return reply.redirect(
          withFlash(
            "/connections",
            "ok",
            `Re-authorised with ${started.accounts} accounts.`,
          ),
        );
      }
      return reply.type("text/html").send(started.page);
    } catch (error) {
      return reply.redirect(
        withFlash(
          "/connections",
          "error",
          error instanceof Error ? error.message : "Re-authorisation failed.",
        ),
      );
    }
  });

  app.post("/connections/:id/reconnect", async (request, reply) => {
    const { id } = request.params as { id: string };
    const connection = services.connections.get(id);
    if (!connection) {
      return reply.redirect(
        withFlash("/connections", "error", "Connection not found."),
      );
    }
    try {
      const provider = services.getProvider();
      const existing = services.connections.getTokens(id);
      const tokens = await provider.refreshToken({
        refreshToken: existing?.refreshToken ?? "demo-refresh",
      });
      const count = await finaliseConnection(
        services,
        provider,
        id,
        tokens,
      );
      return reply.redirect(
        withFlash("/connections", "ok", `Refreshed ${count} accounts.`),
      );
    } catch (error) {
      services.connections.setStatus(id, "reauth_required");
      return reply.redirect(
        withFlash(
          "/connections",
          "error",
          error instanceof Error ? error.message : "Reconnect failed.",
        ),
      );
    }
  });
}
