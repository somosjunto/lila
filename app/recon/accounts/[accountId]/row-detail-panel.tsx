// Server component. Renders the expanded detail block under a loan-credits
// row. Picks the body shape based on the row's state + code, and always
// shows the operator audit trail when present. Action buttons (confirm /
// revert) are interactive client components mounted inside this panel.

import { formatDate, formatMinorUSD } from "@/lib/recon/format";
import { reasonForDvtoCode } from "@/lib/recon/bac";

import { ConfirmPendingButton } from "./confirm-pending-button";
import { RejectPendingButton, type CandidateDA } from "./reject-pending-button";
import { RevertConfirmedButton } from "./revert-confirmed-button";
import { RevertRejectedButton } from "./revert-rejected-button";

export type LinkedDA = {
  id: string;
  posted_at: string;
  return_code: string | null;
  description: string | null;
  payer_name_raw: string | null;
  rail_native_ref: string | null;
  debit_minor: string;
  matched_at: string | null;
  match_strategy: string | null;
  matched_by: string | null;
};

export type PrBatchSummary = {
  total: number;
  rejected: number;
  confirmed: number;
  pending: number;
};

export type ManualActionRow = {
  id: string;
  action: string;
  prior_state: string | null;
  new_state: string | null;
  justification: string;
  acted_by: string | null;
  acted_at: string;
};

export type ActorMap = Map<string, { full_name: string | null; email: string }>;

type RowForPanel = {
  id: string;
  posted_at: string;
  code: string;
  state: string;
  credit_minor: string | number;
  description: string | null;
  rail_native_ref: string | null;
  payer_name_raw: string | null;
  /** True if this PR is confirmed because its batch was consumed by a DA
   *  batch (Tier 5 batch-link rule). Used to render the right confirmation
   *  reason — distinct from manual confirmations. */
  confirmedByBatch?: boolean;
  currency?: string;
};

export function RowDetailPanel({
  accountId,
  row,
  linkedDA,
  manualActions,
  actors,
  rejectCandidates,
  prBatchSummary,
}: {
  accountId: string;
  row: RowForPanel;
  linkedDA: LinkedDA | undefined;
  manualActions: ManualActionRow[];
  actors: ActorMap;
  rejectCandidates?: CandidateDA[];
  prBatchSummary?: PrBatchSummary;
}) {
  const isPR = row.code === "PR";
  const isInboundACH = row.code === "4C" || row.code === "4E";

  return (
    <div className="space-y-4">
      {/* Top: row metadata that didn't fit in the table cells. */}
      <DetailGrid>
        <DetailItem label="Posted">{formatDate(row.posted_at)}</DetailItem>
        <DetailItem label="Code"><code className="font-mono text-xs">{row.code}</code></DetailItem>
        <DetailItem label="Amount" mono>
          {formatMinorUSD(String(row.credit_minor))}
        </DetailItem>
        <DetailItem label="Reference" mono>
          {row.rail_native_ref || "—"}
        </DetailItem>
        <DetailItem label="State"><StateChip state={row.state} /></DetailItem>
        <DetailItem label="Raw description" wide>
          <span className="text-fg-muted">{row.description || "—"}</span>
        </DetailItem>
      </DetailGrid>

      {/* PR rows: show this PR's batch (Referencia) state breakdown so
          operators can quickly cross-check the linker against a manual
          reconciliation. "This PR is in batch 6246583, which has K
          rejected + L confirmed + M pending PRs out of N total." */}
      {isPR && prBatchSummary && row.rail_native_ref && (
        <Section title="PR batch">
          <p className="text-xs text-fg-muted">
            Batch <code className="font-mono">{row.rail_native_ref}</code>{" "}
            has {prBatchSummary.total} PR{prBatchSummary.total === 1 ? "" : "s"}:
          </p>
          <div className="mt-2 flex flex-wrap gap-3 text-sm">
            <BatchCount
              label="Rejected"
              value={prBatchSummary.rejected}
              tone="warning"
            />
            <BatchCount
              label="Confirmed"
              value={prBatchSummary.confirmed}
              tone="success"
            />
            <BatchCount
              label="Pending"
              value={prBatchSummary.pending}
              tone={prBatchSummary.pending > 0 ? "info" : "muted"}
            />
          </div>
        </Section>
      )}

      {/* PR + rejected: show the linked DA. */}
      {isPR && row.state === "rejected" && linkedDA && (
        <Section title="Rejected by reversal">
          <DetailGrid>
            <DetailItem label="DA posted">{formatDate(linkedDA.posted_at)}</DetailItem>
            <DetailItem label="Amount" mono>
              {formatMinorUSD(linkedDA.debit_minor)}
            </DetailItem>
            <DetailItem label="DVTO/RCZO code" mono>
              {linkedDA.return_code ?? "—"}
            </DetailItem>
            <DetailItem label="Reason">
              {linkedDA.return_code
                ? reasonForDvtoCode(linkedDA.return_code).label
                : "—"}
            </DetailItem>
            <DetailItem label="DA reference" mono>
              {linkedDA.rail_native_ref || "—"}
            </DetailItem>
            <DetailItem label="DA payer">
              {linkedDA.payer_name_raw ?? "—"}
            </DetailItem>
            <DetailItem label="Pair source">
              {linkedDA.match_strategy === "manual" ? (
                <>
                  Manual{linkedDA.matched_by ? ` · by ${actorLabel(actors, linkedDA.matched_by)}` : ""}
                  {linkedDA.matched_at
                    ? ` · ${new Date(linkedDA.matched_at).toLocaleString()}`
                    : ""}
                </>
              ) : linkedDA.match_strategy === "auto_batch_link" ? (
                "Auto (batch link)"
              ) : linkedDA.match_strategy === "auto_fifo_name_amount" ? (
                "Auto (FIFO + name + amount, legacy)"
              ) : (
                "Auto"
              )}
            </DetailItem>
            <DetailItem label="DA raw description" wide>
              <span className="text-fg-muted">{linkedDA.description || "—"}</span>
            </DetailItem>
          </DetailGrid>
          <div className="mt-3">
            <RevertRejectedButton accountId={accountId} prTxnId={row.id} />
          </div>
        </Section>
      )}

      {/* PR + pending: explain what's blocking confirmation + offer
          a manual confirm path. */}
      {isPR && row.state === "pending" && (
        <Section title="Pending confirmation" tone="info">
          <p className="text-sm text-fg-muted">
            Will auto-confirm once a future upload includes a DA batch
            that links to this PR&apos;s <code>Referencia</code> batch — at
            that point any PR in the batch without a returning DA flips
            to confirmed. Operator can also confirm or reject manually.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <ConfirmPendingButton accountId={accountId} prTxnId={row.id} />
            <RejectPendingButton
              accountId={accountId}
              prTxnId={row.id}
              prAmountMinor={String(row.credit_minor)}
              candidates={rejectCandidates ?? []}
            />
          </div>
        </Section>
      )}

      {/* PR + confirmed: explain how it landed there (batch-link vs
          manual) + offer the revert path. */}
      {isPR && row.state === "confirmed" && (
        <Section title="Confirmed" tone="success">
          {confirmationStory(manualActions, actors, row.confirmedByBatch === true)}
          <div className="mt-3">
            <RevertConfirmedButton accountId={accountId} prTxnId={row.id} />
          </div>
        </Section>
      )}

      {/* 4C / 4E: a brief note. */}
      {isInboundACH && (
        <Section title="Inbound ACH (irrevocable)" tone="success">
          <p className="text-sm text-fg-muted">
            {row.code} rows are inbound ACH credits from another bank
            {row.code === "4E" ? " via ACH Xpress" : ""}; the originating bank
            cannot reverse them, so this payment is final the moment it posts.
          </p>
        </Section>
      )}

      {/* Banco General regular transaction details */}
      {!isPR && !isInboundACH && (
        <Section
          title={row.state === "confirmed" ? "Transacción conciliada (Banco General)" : "Transacción pendiente"}
          tone={row.state === "confirmed" ? "success" : "info"}
        >
          <p className="text-sm text-fg-muted">
            {row.state === "confirmed"
              ? "Crédito voluntario identificado y recibido en el estado de cuenta de Banco General."
              : "Crédito registrado en estado de cuenta pendiente de asignación manual de préstamo."}
          </p>
          {row.payer_name_raw && (
            <p className="mt-1 text-xs text-fg-muted">
              Pagador identificado: <strong className="text-fg">{row.payer_name_raw}</strong>
            </p>
          )}
        </Section>
      )}

      {/* Audit trail — always shown when there's anything in it. */}
      {manualActions.length > 0 && (
        <Section title="Operator audit trail">
          <ul className="space-y-2 text-sm">
            {manualActions.map((a) => (
              <li
                key={a.id}
                className="rounded border border-border-subtle bg-bg-surface p-3"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-fg-subtle">
                  <span className="font-medium text-fg">
                    {humanizeAction(a)}
                  </span>
                  <span>·</span>
                  <span>{actorLabel(actors, a.acted_by)}</span>
                  <span>·</span>
                  <span>{new Date(a.acted_at).toLocaleString()}</span>
                </div>
                <div className="mt-1 text-fg">{a.justification}</div>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

// =============================================================
// Helpers
// =============================================================

function confirmationStory(
  actions: ManualActionRow[],
  actors: ActorMap,
  confirmedByBatch: boolean,
) {
  const manualConfirm = actions.find(
    (a) =>
      (a.action === "force_confirm" ||
        (a.action === "reclassify" && a.new_state === "confirmed")) &&
      a.new_state === "confirmed",
  );
  if (manualConfirm) {
    return (
      <div className="text-sm text-fg-muted">
        Confirmed manually on{" "}
        <span className="text-fg">
          {new Date(manualConfirm.acted_at).toLocaleString()}
        </span>{" "}
        by{" "}
        <span className="text-fg">
          {actorLabel(actors, manualConfirm.acted_by)}
        </span>
        .
        <div className="mt-1 text-fg">{manualConfirm.justification}</div>
      </div>
    );
  }
  if (confirmedByBatch) {
    return (
      <p className="text-sm text-fg-muted">
        Auto-confirmed by the batch-link rule — the bank returned DAs for
        other PRs in this <code>Referencia</code> batch but not for this
        one, so the funds stayed.
      </p>
    );
  }
  // After Tier 5 PR 3, file-clock confirmation is gone. A confirmed PR
  // without a manual action and without a consumed batch sibling shouldn't
  // exist — but if a legacy row is in this state, render a generic note
  // rather than the now-misleading file-clock copy.
  return (
    <p className="text-sm text-fg-muted">Auto-confirmed.</p>
  );
}

function humanizeAction(a: ManualActionRow): string {
  if (a.action === "force_confirm") return "Manually confirmed";
  if (a.action === "force_reject") return "Manually rejected";
  if (a.action === "reclassify") {
    return `Reclassified ${a.prior_state ?? "?"} → ${a.new_state ?? "?"}`;
  }
  return a.action;
}

function actorLabel(actors: ActorMap, id: string | null | undefined): string {
  if (!id) return "system";
  const a = actors.get(id);
  if (!a) return id.slice(0, 8);
  return a.full_name ?? a.email.split("@")[0];
}

function DetailGrid({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
      {children}
    </dl>
  );
}

function DetailItem({
  label,
  children,
  mono,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "lg:col-span-4 sm:col-span-2" : ""}>
      <dt className="text-xs uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className={`mt-0.5 ${mono ? "font-mono text-xs" : ""} text-fg`}>
        {children}
      </dd>
    </div>
  );
}

function Section({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone?: "success" | "info" | "warning";
}) {
  const border =
    tone === "success"
      ? "border-success/40"
      : tone === "info"
        ? "border-info/40"
        : tone === "warning"
          ? "border-warning/40"
          : "border-border-subtle";
  return (
    <div className={`rounded border ${border} bg-bg-surface p-4`}>
      <div className="mb-2 text-xs uppercase tracking-wide text-fg-subtle">
        {title}
      </div>
      {children}
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  const tone =
    state === "confirmed"
      ? "bg-success-subtle text-success"
      : state === "rejected"
        ? "bg-warning-subtle text-warning"
        : "bg-info-subtle text-info";
  return (
    <span className={`rounded px-2 py-0.5 text-xs capitalize ${tone}`}>
      {state}
    </span>
  );
}

function BatchCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "info" | "muted";
}) {
  const colorClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "info"
          ? "text-info"
          : "text-fg-subtle";
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`font-mono tabular-nums ${colorClass}`}>{value}</span>
      <span className="text-xs text-fg-subtle">{label}</span>
    </span>
  );
}
