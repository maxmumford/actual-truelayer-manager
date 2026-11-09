import type { FastifyInstance } from "fastify";
import type { Services } from "../../services.js";
import { readFlash } from "../flash.js";
import { dashboardPage } from "../views/dashboard.js";

export async function dashboardRoutes(
  app: FastifyInstance,
  services: Services,
): Promise<void> {
  app.get("/dashboard", async (request, reply) => {
    const actualConfig = services.actualRepo.get();
    const mappings = services.mappings.list();
    const mappedByConnection = new Map<string, number>();
    for (const m of mappings) {
      mappedByConnection.set(
        m.connection_id,
        (mappedByConnection.get(m.connection_id) ?? 0) + 1,
      );
    }

    const connections = services.connections.list().map((c) => ({
      ...c,
      mappedAccounts: mappedByConnection.get(c.id) ?? 0,
    }));

    const warnings: string[] = [];
    const warnMs =
      services.config.consentExpiryWarningDays * 86_400_000;
    for (const c of connections) {
      if (c.status === "reauth_required") {
        warnings.push(
          `"${c.display_name}" needs re-authentication. Use "Re-authorise with bank" on the Connections page.`,
        );
        continue;
      }
      if (c.consent_expires_at) {
        const remaining = new Date(c.consent_expires_at).getTime() - Date.now();
        if (!Number.isNaN(remaining) && remaining <= warnMs) {
          const days = Math.max(0, Math.ceil(remaining / 86_400_000));
          warnings.push(
            `Consent for "${c.display_name}" expires in ${days} day(s) (${c.consent_expires_at.slice(0, 10)}). Reconnect soon to avoid interruption.`,
          );
        }
      }
    }

    return reply.type("text/html").send(
      dashboardPage({
        demoMode: services.isDemoProvider(),
        warnings,
        actual: {
          status: actualConfig ? "ok" : "not_configured",
          serverUrl: actualConfig?.server_url,
          syncId: actualConfig?.sync_id,
        },
        connections,
        lastSync: services.syncRuns.latest(),
        scheduleHours: Number(
          services.settings.get("schedule.interval_hours") ??
            services.config.syncIntervalHours,
        ),
        flash: readFlash(request.query),
      }),
    );
  });
}
