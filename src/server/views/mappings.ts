import type {
  AccountMappingRow,
  ProviderAccountRow,
} from "../../db/types.js";
import type { ActualAccount } from "../../actual/actualClient.js";
import { escapeHtml, layout } from "./layout.js";

export interface MappingsViewModel {
  providerAccounts: ProviderAccountRow[];
  actualAccounts: ActualAccount[];
  mappings: AccountMappingRow[];
  flash?: { kind: "ok" | "error"; message: string };
}

export function mappingsPage(vm: MappingsViewModel): string {
  if (vm.providerAccounts.length === 0) {
    const body = `<div class="card"><p class="muted">No provider accounts yet. Connect a bank from <a href="/setup">setup</a> first.</p></div>`;
    return layout("Mappings", body, "/mappings", vm.flash);
  }

  const mappingByProvider = new Map(
    vm.mappings.map((m) => [m.provider_account_id, m]),
  );

  const rows = vm.providerAccounts
    .map((pa) => {
      const current = mappingByProvider.get(pa.provider_account_id);
      const options = vm.actualAccounts
        .map(
          (aa) =>
            `<option value="${escapeHtml(aa.id)}"${current?.actual_account_id === aa.id ? " selected" : ""}>${escapeHtml(aa.name)}</option>`,
        )
        .join("");
      // An unmapped row must start on a placeholder, never on a real account:
      // defaulting to the first account alphabetically meant one click on
      // "Map" filed a bank account into whatever happened to sort first.
      const placeholder = current
        ? ""
        : `<option value="" selected disabled>Choose an Actual account…</option>`;
      return `<tr>
        <td>${escapeHtml(pa.display_name)}<br><span class="muted">${escapeHtml(pa.account_type)}</span></td>
        <td>
          <form method="post" action="/mappings" class="row" style="align-items:flex-end">
            <input type="hidden" name="connection_id" value="${escapeHtml(pa.connection_id)}" />
            <input type="hidden" name="provider_account_id" value="${escapeHtml(pa.provider_account_id)}" />
            <select name="actual_account_id" style="min-width:180px" required>${placeholder}${options}</select>
            <button type="submit">${current ? "Update" : "Map"}</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const body = `<div class="card">
    <h2>Account mappings</h2>
    <p class="muted">Map each provider account/card to an Actual Budget account.</p>
    <table><thead><tr><th>Provider account</th><th>Actual account</th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;

  return layout("Mappings", body, "/mappings", vm.flash);
}
