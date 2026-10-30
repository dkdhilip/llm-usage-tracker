import { Fragment, useRef, type ReactNode } from "react";
import type { KeyRow } from "../../lib/api";
import { ConnectPanel } from "../../components/ConnectPanel";
import { CostCell } from "../../components/CostCell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Menu, MenuButton, MenuItem, MenuList, MenuSeparator } from "../../components/ui/Menu";
import { ScrollRegion } from "../../components/ui/ScrollRegion";
import { providerColor } from "../../lib/chartColors";
import { keyStatus } from "../../lib/keyOptions";
import { num, providerName, usd } from "../../lib/format";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { KeyLoggingEditor, KeyLoggingPill } from "./KeyLogging";

export interface KeyActions {
  connectId: number | null;
  loggingId: number | null;
  onConnect: (id: number) => void;
  onLogging: (id: number) => void;
  onPause: (k: KeyRow) => void;
  onRevoke: (k: KeyRow) => void;
  onDelete: (k: KeyRow) => void;
  /** a paused key can only be resumed if one of its providers has a workspace key */
  canResume: (k: KeyRow) => boolean;
  masterText?: boolean;
  masterImages?: boolean;
  retentionDays: number;
  configured: string[];
  onChange: () => void;
}

function KeyName({ k }: { k: KeyRow }) {
  return (
    <div className="min-w-0">
      <div className="max-w-[13rem] break-words font-medium text-fg md:truncate" title={k.label}>
        {k.label}
      </div>
      <div className="font-mono text-xs text-fg-muted">{k.key_prefix}…</div>
    </div>
  );
}

function Owner({ name }: { name: string | null }) {
  if (!name) return <span className="text-fg-muted">Unassigned</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-info-soft text-meta font-semibold uppercase text-info-fg">
        {name[0]}
      </span>
      {name}
    </span>
  );
}

function Providers({ list }: { list: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {list.map((p) => (
        <Badge key={p}>
          <span className="h-2 w-2 rounded-full" style={{ background: providerColor(p) }} aria-hidden="true" />
          {providerName(p)}
        </Badge>
      ))}
    </span>
  );
}

/** How much of the budget is spent: a bar that turns amber from 80% and red once it is over. The text carries the
 *  same facts, so the colour is never the only signal. */
function Budget({ k }: { k: KeyRow }) {
  if (k.monthly_budget_usd == null) return <span className="text-fg-muted">No limit</span>;
  const limit = k.monthly_budget_usd;
  const pct = limit > 0 ? (k.spend_period / limit) * 100 : 100;
  const over = pct >= 100;
  const warn = !over && pct >= 80;
  const per = k.budget_period === "custom" ? "" : `/${k.budget_period[0]}`;
  return (
    <div className="w-36">
      <div className="flex justify-between gap-2 text-xs text-fg-muted">
        <span>
          {usd(k.spend_period)} of {usd(limit)}
          {per}
        </span>
        <span className={over ? "font-semibold text-danger-fg" : warn ? "font-semibold text-warning-fg" : undefined}>
          {over ? "Over budget" : `${Math.max(1, Math.round(pct))}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`Budget used by ${k.label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.round(pct))}
        className="mt-1 h-1.5 overflow-hidden rounded bg-fill"
      >
        <div
          className={`h-full rounded ${over ? "bg-red-600" : warn ? "bg-amber-500" : "bg-brand-500"}`}
          style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
        />
      </div>
    </div>
  );
}

function Status({ k, ready }: { k: KeyRow; ready: boolean }) {
  const s = keyStatus(k);
  if (s === "deleted") return <Badge dot>Deleted</Badge>;
  if (s === "revoked") return <Badge dot>Revoked</Badge>;
  if (!k.allow_live)
    return (
      <Badge variant="warning" dot title={ready ? "Paused: requests return 403 until the key is resumed." : "Paused: none of this key's providers has a workspace key yet."}>
        Paused
      </Badge>
    );
  return (
    <Badge variant="success" dot>
      Active
    </Badge>
  );
}

function KeyMenu({ k, a }: { k: KeyRow; a: KeyActions }) {
  const s = keyStatus(k);
  const button = useRef<HTMLButtonElement>(null);
  const later = useRef<(() => void) | null>(null);
  if (s === "deleted") return null;
  // An action that opens a dialog waits until the menu has closed, then puts focus back on the "⋯" button first, so
  // the dialog remembers it and hands focus back to it when it closes.
  const afterClose = (run: () => void) => () => {
    later.current = run;
  };
  return (
    <Menu>
      <MenuButton ref={button} label={`More actions for ${k.label}`} />
      <MenuList
        onCloseAutoFocus={(e) => {
          const run = later.current;
          if (!run) return;
          later.current = null;
          e.preventDefault();
          button.current?.focus();
          run();
        }}
      >
        {s === "active" && (
          <>
            <MenuItem onSelect={() => a.onLogging(k.id)}>Logging settings</MenuItem>
            <MenuItem disabled={!k.allow_live && !a.canResume(k)} onSelect={() => a.onPause(k)}>
              {k.allow_live ? "Pause key" : "Resume key"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem tone="danger" onSelect={afterClose(() => a.onRevoke(k))}>
              Revoke key
            </MenuItem>
          </>
        )}
        {s === "revoked" && (
          <MenuItem tone="danger" onSelect={afterClose(() => a.onDelete(k))}>
            Delete key
          </MenuItem>
        )}
      </MenuList>
    </Menu>
  );
}

function ConnectButton({ k, a }: { k: KeyRow; a: KeyActions }) {
  if (keyStatus(k) !== "active") return null;
  return (
    <Button size="sm" aria-expanded={a.connectId === k.id} title="How to use this key from OpenAI, Anthropic or Gemini code" onClick={() => a.onConnect(k.id)}>
      Connect
    </Button>
  );
}

/** What opens under a key: its logging editor and its Connect guide. */
function loggingPanel(k: KeyRow, a: KeyActions): ReactNode {
  if (a.loggingId !== k.id || keyStatus(k) !== "active") return null;
  return <KeyLoggingEditor k={k} masterText={a.masterText} masterImages={a.masterImages} retentionDays={a.retentionDays} onChange={a.onChange} />;
}

function connectPanel(k: KeyRow, a: KeyActions): ReactNode {
  if (a.connectId !== k.id || keyStatus(k) !== "active") return null;
  return (
    <ConnectPanel
      keyInfo={{ allowed_providers: k.allowed_providers, allow_live: k.allow_live, expires_at: k.expires_at }}
      configuredProviders={a.configured}
    />
  );
}

const TH = "py-2 pr-3 text-left text-meta font-medium uppercase tracking-wide text-fg-muted";

/** The keys: a table on a desktop, one card per key on a phone (the same rows, never both at once). */
export function KeysTable({ keys, a, empty }: { keys: KeyRow[]; a: KeyActions; empty: string }) {
  const phone = useMediaQuery(PHONE_QUERY);
  const ready = (k: KeyRow) => a.canResume(k);
  if (keys.length === 0) return <p className="py-8 text-center text-sm text-fg-muted">{empty}</p>;

  if (phone) {
    return (
      <ul className="divide-y divide-line" aria-label="Virtual keys">
        {keys.map((k) => (
          <li key={k.id} className={`py-4 ${keyStatus(k) !== "active" ? "text-fg-muted" : ""}`}>
            <div className="flex items-start justify-between gap-2">
              <KeyName k={k} />
              <Status k={k} ready={ready(k)} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Providers list={k.allowed_providers} />
              <span data-testid={`key-logging-${k.id}`}>
                <KeyLoggingPill k={k} masterText={a.masterText} masterImages={a.masterImages} />
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-fg-muted">
              <Owner name={k.assigned_username} />
              <span>
                <CostCell cost={k.cost} requests={k.requests} unpriced={k.unpriced_requests} /> · {num(k.requests)} requests
              </span>
            </div>
            <div className="mt-2">
              <Budget k={k} />
            </div>
            <div className="mt-3 flex gap-2">
              <ConnectButton k={k} a={a} />
              <KeyMenu k={k} a={a} />
            </div>
            {loggingPanel(k, a) && <div className="mt-3 rounded-md bg-surface-2 p-3">{loggingPanel(k, a)}</div>}
            {connectPanel(k, a) && <div className="mt-3 rounded-md bg-surface-2 p-3">{connectPanel(k, a)}</div>}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ScrollRegion label="Virtual keys table">
      <table className="w-full min-w-[62rem] text-sm">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={TH}>Key</th>
            <th scope="col" className={TH}>Owner</th>
            <th scope="col" className={TH}>Providers</th>
            <th scope="col" className={`${TH} text-right`}>Requests</th>
            <th scope="col" className={`${TH} text-right`}>Cost</th>
            <th scope="col" className={TH}>Budget</th>
            <th scope="col" className={TH}>Logging</th>
            <th scope="col" className={TH}>Status</th>
            <th scope="col" className={`${TH} pr-0 text-right`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const logging = loggingPanel(k, a);
            const connect = connectPanel(k, a);
            const muted = keyStatus(k) !== "active";
            return (
              <Fragment key={k.id}>
                <tr className={`border-b border-line last:border-0 ${muted ? "text-fg-muted" : ""}`}>
                  <td className="py-2.5 pr-3">
                    <KeyName k={k} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <Owner name={k.assigned_username} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <Providers list={k.allowed_providers} />
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{num(k.requests)}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    <CostCell cost={k.cost} requests={k.requests} unpriced={k.unpriced_requests} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <Budget k={k} />
                  </td>
                  <td className="py-2.5 pr-3" data-testid={`key-logging-${k.id}`}>
                    <KeyLoggingPill k={k} masterText={a.masterText} masterImages={a.masterImages} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <Status k={k} ready={ready(k)} />
                  </td>
                  <td className="whitespace-nowrap py-2.5 text-right">
                    <span className="inline-flex items-center justify-end gap-2">
                      <ConnectButton k={k} a={a} />
                      <KeyMenu k={k} a={a} />
                    </span>
                  </td>
                </tr>
                {logging && (
                  <tr className="border-b border-line bg-surface-2">
                    <td colSpan={9} className="px-4 py-3">
                      {logging}
                    </td>
                  </tr>
                )}
                {connect && (
                  <tr className="border-b border-line bg-surface-2">
                    <td colSpan={9} className="px-4 py-4">
                      {connect}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
