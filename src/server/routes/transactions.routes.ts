import type { FastifyInstance } from "fastify";
import type { ImportedTransactionRow } from "../../db/repositories/syncRuns.repo.js";
import type { Services } from "../../services.js";

type RawStatus = "stored" | "not_stored" | "undecryptable";

function queryStr(query: unknown, key: string): string | undefined {
  if (!query || typeof query !== "object") return undefined;
  const value = (query as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Read-only access to the provider's raw transaction payloads kept in
 * `imported_transactions`, for investigating an odd transaction after the
 * fact. It sits behind the same HTTP Basic Auth as every other route (only
 * `/health` is exempt). The decrypted payload goes only into the response
 * body: Fastify's request logger drops the query string and never logs
 * bodies, and nothing here writes to the app log.
 */
export async function transactionsRoutes(
  app: FastifyInstance,
  services: Services,
): Promise<void> {
  app.get("/transactions/raw", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    // `imported_id` is accepted as an alias: it is the id Actual shows as the
    // transaction's imported id, which is the provider transaction id.
    const providerTransactionId =
      queryStr(request.query, "provider_transaction_id") ??
      queryStr(request.query, "imported_id");
    const providerAccountId = queryStr(request.query, "provider_account_id");
    const bookedDate = queryStr(request.query, "booked_date");
    const amountRaw = queryStr(request.query, "amount_minor");

    if (bookedDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(bookedDate)) {
      return reply.code(400).send({ error: "booked_date must be YYYY-MM-DD." });
    }
    let amountMinor: number | undefined;
    if (amountRaw !== undefined) {
      if (!/^-?\d+$/.test(amountRaw)) {
        return reply
          .code(400)
          .send({ error: "amount_minor must be an integer in pence, e.g. -1250." });
      }
      amountMinor = Number(amountRaw);
    }

    if (
      providerTransactionId === undefined &&
      bookedDate === undefined &&
      amountMinor === undefined
    ) {
      return reply.code(400).send({
        error:
          "Give provider_transaction_id (or imported_id), or booked_date and/or amount_minor.",
      });
    }

    const rows = services.syncRuns.findImported({
      providerTransactionId,
      providerAccountId,
      bookedDate,
      amountMinor,
    });

    return {
      matches: rows.map((row) => toResponse(row, services)),
    };
  });
}

function toResponse(row: ImportedTransactionRow, services: Services) {
  let raw: unknown = null;
  let rawStatus: RawStatus = "not_stored";
  if (row.raw_json_encrypted) {
    try {
      if (!services.encryptor) throw new Error("no key");
      raw = JSON.parse(services.encryptor.decrypt(row.raw_json_encrypted));
      rawStatus = "stored";
    } catch {
      raw = null;
      rawStatus = "undecryptable";
    }
  }
  return {
    provider: row.provider,
    provider_account_id: row.provider_account_id,
    provider_transaction_id: row.provider_transaction_id,
    actual_account_id: row.actual_account_id,
    booked_date: row.booked_date,
    amount_minor: row.amount_minor,
    currency: row.currency,
    imported_at: row.imported_at,
    sync_run_id: row.sync_run_id,
    raw_status: rawStatus,
    raw,
  };
}
