import { createHash } from "node:crypto";
import type { BankTransaction } from "../providers/bankingProvider.js";
import type { ActualImportTransaction } from "../actual/actualClient.js";

/**
 * Returns a stable identifier for a transaction. Uses the provider transaction
 * ID when present; otherwise derives a deterministic fallback hash from the
 * transaction's identifying fields (spec §13.4).
 */
export function transactionKey(
  provider: string,
  tx: BankTransaction,
): { id: string; fallback: boolean } {
  if (tx.providerTransactionId) {
    return { id: tx.providerTransactionId, fallback: false };
  }
  const hash = createHash("sha256")
    .update(
      [
        provider,
        tx.providerAccountId,
        tx.bookedDate,
        String(tx.amountMinor),
        tx.description,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 32);
  return { id: `fallback-${hash}`, fallback: true };
}

/**
 * Pulls the counterparty (beneficiary) name out of a provider's raw payload.
 *
 * TrueLayer only sends `merchant_name` for card-style spending. For a faster
 * payment (bank transfer) it is absent, and `description` is whatever reference
 * the *user* typed when sending the money — e.g. Monzo reports "237 OSR,
 * BN411XR" for a payment to "Albion Commercial Cleaning Ltd". The beneficiary's
 * real name sits unused in `meta.counter_party_preferred_name` (falling back to
 * `meta.counter_party_name`), so we prefer that over the reference.
 *
 * `raw` is typed as `unknown` because the provider interface is deliberately
 * provider-agnostic, so every step is guarded rather than cast: only a
 * non-empty string counts, and it is trimmed before use.
 */
function counterPartyName(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const meta = (raw as Record<string, unknown>).meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const fields = meta as Record<string, unknown>;
  for (const key of ["counter_party_preferred_name", "counter_party_name"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

/** Normalises a provider transaction into Actual's import shape. */
export function normaliseTransaction(
  provider: string,
  tx: BankTransaction,
  actualAccountId: string,
): ActualImportTransaction & { fallback: boolean } {
  const key = transactionKey(provider, tx);
  return {
    accountId: actualAccountId,
    date: tx.bookedDate,
    amountMinor: tx.amountMinor,
    // Merchant name still wins whenever the provider gives one; the
    // counterparty only fills the gap left by a transfer, where `description`
    // is the payment reference rather than who was paid.
    payeeName: tx.merchantName ?? counterPartyName(tx.raw) ?? tx.description,
    importedId: key.id,
    notes: key.fallback ? "imported (fallback id)" : undefined,
    fallback: key.fallback,
  };
}
