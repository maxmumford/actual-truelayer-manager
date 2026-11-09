import type {
  BankConnectionRow,
  ProviderAccountRow,
} from "../../db/types.js";
import { escapeHtml, layout } from "./layout.js";

export interface ConnectionsViewModel {
  connections: (BankConnectionRow & { accounts: ProviderAccountRow[] })[];
  flash?: { kind: "ok" | "error"; message: string };
}

export function connectionsPage(vm: ConnectionsViewModel): string {
  const cards =
    vm.connections.length === 0
      ? `<div class="card"><p class="muted">No connections yet. <a href="/setup">Add one from setup &rarr;</a></p></div>`
      : vm.connections
          .map((c) => {
            const accounts = c.accounts
              .map(
                (a) =>
                  `<tr><td>${escapeHtml(a.display_name)}</td><td><span class="pill muted">${escapeHtml(a.account_type)}</span></td><td>${escapeHtml(a.currency)}</td></tr>`,
              )
              .join("");
            return `<div class="card">
              <h2>${escapeHtml(c.display_name)} <span class="pill ${c.status}">${c.status}</span></h2>
              <p class="muted">Provider: ${escapeHtml(c.provider)} · Type: ${escapeHtml(c.connection_type)}</p>
              <table><thead><tr><th>Account</th><th>Type</th><th>Currency</th></tr></thead><tbody>${accounts || `<tr><td colspan="3" class="muted">No accounts discovered.</td></tr>`}</tbody></table>
              <div class="row">
                <form method="post" action="/connections/${encodeURIComponent(c.id)}/reauthorise"><button${c.status === "reauth_required" ? "" : ` class="secondary"`} type="submit">Re-authorise with bank</button></form>
                <form method="post" action="/connections/${encodeURIComponent(c.id)}/reconnect"><button class="secondary" type="submit">Retry token refresh</button></form>
              </div>
            </div>`;
          })
          .join("");

  return layout("Connections", cards, "/connections", vm.flash);
}
