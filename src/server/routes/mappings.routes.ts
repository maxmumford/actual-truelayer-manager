import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ActualAccount } from "../../actual/actualClient.js";
import type { Services } from "../../services.js";
import { bodyStr, readFlash, withFlash } from "../flash.js";
import { mappingsPage } from "../views/mappings.js";

export async function mappingsRoutes(
  app: FastifyInstance,
  services: Services,
): Promise<void> {
  app.get("/mappings", async (request, reply) => {
    let actualAccounts: ActualAccount[] = [];
    try {
      actualAccounts = await services.getActualClient().listAccounts();
    } catch {
      actualAccounts = [];
    }

    return reply.type("text/html").send(
      mappingsPage({
        providerAccounts: services.connections.listProviderAccounts(),
        actualAccounts,
        mappings: services.mappings.list(),
        flash: readFlash(request.query),
      }),
    );
  });

  app.post("/mappings", async (request, reply) => {
    const connectionId = bodyStr(request.body, "connection_id");
    const providerAccountId = bodyStr(request.body, "provider_account_id");
    const actualAccountId = bodyStr(request.body, "actual_account_id");

    if (!connectionId || !providerAccountId) {
      return reply.redirect(
        withFlash("/mappings", "error", "Missing mapping fields."),
      );
    }
    if (!actualAccountId) {
      return reply.redirect(
        withFlash(
          "/mappings",
          "error",
          "Choose an Actual account before mapping. Nothing was saved.",
        ),
      );
    }

    let actualName = actualAccountId;
    try {
      const accounts = await services.getActualClient().listAccounts();
      const match = accounts.find((a) => a.id === actualAccountId);
      if (!match) {
        return reply.redirect(
          withFlash(
            "/mappings",
            "error",
            "That Actual account no longer exists. Nothing was saved.",
          ),
        );
      }
      actualName = match.name;
    } catch {
      // Actual unreachable: keep the id as the name fallback
    }

    services.mappings.upsert({
      id: randomUUID(),
      connectionId,
      providerAccountId,
      actualAccountId,
      actualAccountName: actualName,
      enabled: true,
    });
    services.logs.info(
      `Mapped ${providerAccountId} -> ${actualName}`,
    );
    return reply.redirect(withFlash("/mappings", "ok", "Mapping saved."));
  });
}
