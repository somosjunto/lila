import { ChevronDown, ChevronsUpDown, ChevronUp, Download, Filter } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { OperatorShell } from "@/components/patterns/OperatorShell";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { requireReconWriter } from "@/lib/auth/guard";
import {
  extractPRPayerName,
  namesMatch,
  normalizeName,
  reasonForDvtoCode,
} from "@/lib/recon/bac";
import { formatDate, formatMinorUSD, lastWorkingDays } from "@/lib/recon/format";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { BackfillButton } from "./backfill-button";
import { BGAchBatchRow } from "./bg-ach-batch-row";
import { BgBatchList, type BgBatchView } from "./bg-batch-list";
import { BgPendingTasksPanel } from "./bg-pending-tasks-panel";
import { BgYappyPanel, type BgYappyBatchView, type BgYappyLineView } from "./bg-yappy-panel";
import { BulkActionBar } from "./bulk-action-bar";
import { BulkConfirmBatchButton } from "./bulk-confirm-batch-button";
import { BulkSelectionProvider } from "./bulk-selection-context";
import { LoanCreditRow } from "./loan-credit-row";
import { MatchToPRButton } from "./match-to-pr-button";
import { RecomputeButton } from "./recompute-button";
import { RowDetailPanel } from "./row-detail-panel";

export const dynamic = "force-dynamic";

type SearchParams = {
  state?: string;
  from?: string;
  to?: string;
  page?: string;
  perPage?: string;
  sort?: string;
  dir?: string;
  range?: string; // "all" overrides the last-2-working-days default
};

const STATES = ["all", "pending", "confirmed", "rejected"] as const;
type StateFilter = (typeof STATES)[number];

const SORTABLE = {
  posted_at: "Date",
  code: "Code",
  description: "Payer",
  credit_minor: "Amount",
  state: "Status",
  rail_native_ref: "Reference",
} as const;
type SortKey = keyof typeof SORTABLE;
const SORT_KEYS = Object.keys(SORTABLE) as SortKey[];

const PER_PAGE_DEFAULT = 20;
const PER_PAGE_OPTIONS = [20, 50, 100, 250];

function asState(v: string | undefined): StateFilter {
  return (STATES as readonly string[]).includes(v ?? "")
    ? (v as StateFilter)
    : "all";
}

function asInt(v: string | undefined, fallback: number, min = 1, max = Infinity): number {
  const n = Number.parseInt(v ?? "", 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function isoOrUndefined(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

function asSortKey(v: string | undefined): SortKey {
  return SORT_KEYS.includes(v as SortKey) ? (v as SortKey) : "posted_at";
}

function asDir(v: string | undefined): "asc" | "desc" {
  return v === "asc" ? "asc" : "desc";
}

const SUPABASE_PAGE_LIMIT = 1000;
const SUPABASE_PAGE_SAFETY_CAP = 200_000;


// Walk a Supabase query in 1000-row pages until we've consumed it.
// Use this for "give me ALL matching rows" cases (totals, exports) where a
// single .select() would silently truncate at the per-request cap.
async function fetchAllPages<TRow>(
  buildQuery: (
    cursor: number,
    pageSize: number,
  ) => PromiseLike<{ data: TRow[] | null; error: unknown }>,
): Promise<TRow[]> {
  const all: TRow[] = [];
  let cursor = 0;
  while (cursor < SUPABASE_PAGE_SAFETY_CAP) {
    const { data, error } = await buildQuery(cursor, SUPABASE_PAGE_LIMIT);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < SUPABASE_PAGE_LIMIT) break;
    cursor += SUPABASE_PAGE_LIMIT;
  }
  return all;
}

export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireReconWriter();
  const { accountId } = await params;
  const sp = await searchParams;

  const stateFilter = asState(sp.state);
  const explicitFrom = isoOrUndefined(sp.from);
  const explicitTo = isoOrUndefined(sp.to);
  const sort = asSortKey(sp.sort);
  const dir = asDir(sp.dir);
  const perPage = asInt(sp.perPage, PER_PAGE_DEFAULT, 1, 500);
  const page = asInt(sp.page, 1, 1);
  const showAll = sp.range === "all";

  const supabase = await createSupabaseServerClient();

  const { data: account } = await supabase
    .from("bank_accounts")
    .select("id, rail, account_number, holder_name, currency, status")
    .eq("id", accountId)
    .single();

  if (!account) notFound();

  // Resolve the date range in effect:
  //   1. URL has explicit from/to → honor those.
  //   2. URL has range=all → no date filter.
  //   3. Otherwise default to the last 2 working days anchored to this
  //      account's most-recent posted_at (or today if no data yet).
  let defaultRange: { from: string; to: string } | null = null;
  if (!explicitFrom && !explicitTo && !showAll) {
    const { data: maxRow } = await supabase
      .from("recon_transactions")
      .select("posted_at")
      .eq("account_id", accountId)
      .order("posted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ref = maxRow?.posted_at
      ? new Date(`${maxRow.posted_at}T00:00:00Z`)
      : new Date();
    defaultRange = lastWorkingDays(ref, 2);
  }
  const from = explicitFrom ?? defaultRange?.from;
  const to = explicitTo ?? defaultRange?.to;
  const usingDefault = !explicitFrom && !explicitTo && !showAll;

  // Aggregate totals are scoped to (account, kind, date) only — the state
  // filter narrows the list table, never the cards. We walk the result in
  // 1000-row pages because Supabase JS caps a single request at 1000 rows
  // by default; without paging, accounts with > 1000 loan_inflow rows in
  // the date window would produce undercounts.
  const totalsRows = await fetchAllPages<{ state: string; credit_minor: string | number }>(
    (cursor, pageSize) => {
      let q = supabase
        .from("recon_transactions")
        .select("state, credit_minor")
        .eq("account_id", accountId)
        .eq("kind", "loan_inflow")
        .order("id", { ascending: true })
        .range(cursor, cursor + pageSize - 1);
      if (from) q = q.gte("posted_at", from);
      if (to) q = q.lte("posted_at", to);
      return q;
    },
  );

  // Page query. We use { count: "exact" } so the footer can render the
  // total page count without a second roundtrip.
  let pageQuery = supabase
    .from("recon_transactions")
    .select(
      "id, posted_at, code, credit_minor, description, state, rail_native_ref, payer_name_raw",
      { count: "exact" },
    )
    .eq("account_id", accountId)
    .eq("kind", "loan_inflow");
  if (stateFilter !== "all") pageQuery = pageQuery.eq("state", stateFilter);
  if (from) pageQuery = pageQuery.gte("posted_at", from);
  if (to) pageQuery = pageQuery.lte("posted_at", to);

  // Stable secondary sort on id avoids row-shuffling when many rows share
  // the same primary key (e.g., 200 PRs all posted on the same day).
  pageQuery = pageQuery
    .order(sort, { ascending: dir === "asc" })
    .order("id", { ascending: false });

  const start = (page - 1) * perPage;
  pageQuery = pageQuery.range(start, start + perPage - 1);

  const { data: rows, count } = await pageQuery;
  const credits = rows ?? [];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, totalPages);

  // Linked-DA details + manual-action history for rejected PRs on this
  // page. The expandable detail panel uses the full DA row to show
  // what rejected the payment, plus the recon_manual_actions audit
  // trail (how it landed in this state).
  const rejectedPrIds = credits
    .filter((r) => r.code === "PR" && r.state === "rejected")
    .map((r) => r.id);
  type LinkedDA = {
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
  const linkedDaByPrId = new Map<string, LinkedDA>();
  if (rejectedPrIds.length > 0) {
    const { data: links } = await supabase
      .from("recon_links")
      .select("pr_txn_id, da_txn_id, matched_at, match_strategy, matched_by")
      .in("pr_txn_id", rejectedPrIds);
    const daIds = (links ?? []).map((l) => l.da_txn_id);
    let daById = new Map<
      string,
      Omit<LinkedDA, "matched_at" | "match_strategy" | "matched_by">
    >();
    if (daIds.length > 0) {
      const { data: das } = await supabase
        .from("recon_transactions")
        .select(
          "id, posted_at, return_code, description, payer_name_raw, rail_native_ref, debit_minor",
        )
        .in("id", daIds);
      daById = new Map(
        (das ?? []).map((d) => [
          d.id as string,
          {
            id: d.id as string,
            posted_at: d.posted_at as string,
            return_code: d.return_code as string | null,
            description: d.description as string | null,
            payer_name_raw: d.payer_name_raw as string | null,
            rail_native_ref: d.rail_native_ref as string | null,
            debit_minor: String(d.debit_minor),
          },
        ]),
      );
    }
    for (const link of links ?? []) {
      const da = daById.get(link.da_txn_id as string);
      if (!da) continue;
      linkedDaByPrId.set(link.pr_txn_id as string, {
        ...da,
        matched_at: link.matched_at as string | null,
        match_strategy: link.match_strategy as string | null,
        matched_by: link.matched_by as string | null,
      });
    }
  }
  // Backwards-compat shim for the existing Reason cell rendering.
  const reasonByPrId = new Map<
    string,
    { code: string | null; description: string | null }
  >();
  for (const [prId, da] of linkedDaByPrId) {
    reasonByPrId.set(prId, {
      code: da.return_code,
      description: da.description,
    });
  }

  // Manual-action history per PR on this page. Used by the detail
  // panel's audit trail and to distinguish auto vs manually confirmed rows.
  const visiblePrIds = credits.filter((r) => r.code === "PR").map((r) => r.id);
  type ManualActionRow = {
    id: string;
    action: string;
    prior_state: string | null;
    new_state: string | null;
    justification: string;
    acted_by: string | null;
    acted_at: string;
  };
  const manualActionsByPrId = new Map<string, ManualActionRow[]>();
  if (visiblePrIds.length > 0) {
    const ID_CHUNK = 100;
    for (let i = 0; i < visiblePrIds.length; i += ID_CHUNK) {
      const chunk = visiblePrIds.slice(i, i + ID_CHUNK);
      const { data: actions } = await supabase
        .from("recon_manual_actions")
        .select(
          "id, txn_id, action, prior_state, new_state, justification, acted_by, acted_at",
        )
        .in("txn_id", chunk)
        .order("acted_at", { ascending: false });
      for (const a of actions ?? []) {
        const txnId = a.txn_id as string;
        const list = manualActionsByPrId.get(txnId) ?? [];
        list.push({
          id: a.id as string,
          action: a.action as string,
          prior_state: a.prior_state as string | null,
          new_state: a.new_state as string | null,
          justification: a.justification as string,
          acted_by: a.acted_by as string | null,
          acted_at: a.acted_at as string,
        });
        manualActionsByPrId.set(txnId, list);
      }
    }
  }

  // Actor names for manual_actions.acted_by + recon_links.matched_by.
  const actorIds = new Set<string>();
  for (const list of manualActionsByPrId.values()) {
    for (const a of list) if (a.acted_by) actorIds.add(a.acted_by);
  }
  for (const da of linkedDaByPrId.values()) {
    if (da.matched_by) actorIds.add(da.matched_by);
  }
  const actorById = new Map<
    string,
    { full_name: string | null; email: string }
  >();
  if (actorIds.size > 0) {
    const { data: profiles } = await supabase
      .from("user_profiles")
      .select("id, full_name, email")
      .in("id", Array.from(actorIds));
    for (const p of profiles ?? []) {
      actorById.set(p.id as string, {
        full_name: p.full_name as string | null,
        email: p.email as string,
      });
    }
  }

  // For each pending PR on this page, the manual-reject picker needs the
  // unpaired DAs in the account whose posted_at is within ±7 days of the
  // PR. Single batched query for all unpaired DAs in the account, then
  // per-PR JS filtering by date window — typical accounts have at most
  // a few dozen DAs in pending_pair at a time, so this is cheap.
  type CandidateDARow = {
    id: string;
    posted_at: string;
    debit_minor: string;
    return_code: string | null;
    payer_name_raw: string | null;
    description: string | null;
  };
  const candidateDAsByPrId = new Map<string, CandidateDARow[]>();
  const pendingPrs = credits.filter((r) => r.code === "PR" && r.state === "pending");
  if (pendingPrs.length > 0) {
    const { data: unpairedDArows } = await supabase
      .from("recon_transactions")
      .select("id, posted_at, debit_minor, return_code, payer_name_raw, description")
      .eq("account_id", accountId)
      .eq("code", "DA")
      .eq("state", "pending_pair")
      .order("posted_at", { ascending: true });
    const unpairedDAs: CandidateDARow[] = (unpairedDArows ?? []).map((d) => ({
      id: d.id as string,
      posted_at: d.posted_at as string,
      debit_minor: String(d.debit_minor),
      return_code: d.return_code as string | null,
      payer_name_raw: d.payer_name_raw as string | null,
      description: d.description as string | null,
    }));
    const SEVEN_DAYS_MS = 7 * 86_400_000;
    for (const pr of pendingPrs) {
      const prT = Date.parse((pr.posted_at as string) + "T00:00:00Z");
      const eligible = unpairedDAs.filter((da) => {
        const daT = Date.parse(da.posted_at + "T00:00:00Z");
        return Math.abs(daT - prT) <= SEVEN_DAYS_MS;
      });
      candidateDAsByPrId.set(pr.id as string, eligible);
    }
  }

  // Compute the set of "consumed PR-batch references" for this account.
  // A confirmed PR is auto-confirmed by the batch-link rule (Tier 5 PR 2)
  // when its rail_native_ref matches a ref that has at least one
  // auto_batch_link recon_links pairing — meaning the bank returned DAs
  // for some PRs in that batch but not for this one (the funds stayed).
  // Used by the row detail panel to render the right confirmation reason
  // for confirmed PRs (batch-link vs manual).
  const consumedBatchRefs = new Set<string>();
  // PR-batch summary per Referencia: { rejected, confirmed, pending, total }
  // plus pendingAmountMinor + earliestPostedAt for the pending-batches list.
  // Used by both the row detail panel (sibling state breakdown) and the
  // dedicated "Pending PR batches" card.
  type PrBatchSummary = {
    total: number;
    rejected: number;
    confirmed: number;
    pending: number;
    pendingAmountMinor: bigint;
    earliestPostedAt: string | null;
  };
  const prBatchSummary = new Map<string, PrBatchSummary>();
  {
    const { data: accountPrRows } = await supabase
      .from("recon_transactions")
      .select("id, rail_native_ref, state, credit_minor, posted_at")
      .eq("account_id", accountId)
      .eq("code", "PR");
    const refByPrId = new Map<string, string | null>();
    for (const r of accountPrRows ?? []) {
      const ref = (r.rail_native_ref as string | null) ?? null;
      refByPrId.set(r.id as string, ref);
      if (ref) {
        const s = prBatchSummary.get(ref) ?? {
          total: 0,
          rejected: 0,
          confirmed: 0,
          pending: 0,
          pendingAmountMinor: 0n,
          earliestPostedAt: null as string | null,
        };
        s.total++;
        const state = r.state as string;
        const postedAt = r.posted_at as string;
        if (!s.earliestPostedAt || postedAt < s.earliestPostedAt) {
          s.earliestPostedAt = postedAt;
        }
        if (state === "rejected") s.rejected++;
        else if (state === "confirmed") s.confirmed++;
        else if (state === "pending") {
          s.pending++;
          s.pendingAmountMinor += BigInt(String(r.credit_minor));
        }
        prBatchSummary.set(ref, s);
      }
    }
    const accountPrIds = Array.from(refByPrId.keys());
    const ID_CHUNK = 100;
    for (let i = 0; i < accountPrIds.length; i += ID_CHUNK) {
      const chunk = accountPrIds.slice(i, i + ID_CHUNK);
      const { data: autoLinks } = await supabase
        .from("recon_links")
        .select("pr_txn_id")
        .eq("match_strategy", "auto_batch_link")
        .in("pr_txn_id", chunk);
      for (const l of autoLinks ?? []) {
        const ref = refByPrId.get(l.pr_txn_id as string);
        if (ref) consumedBatchRefs.add(ref);
      }
    }
  }

  // BG-rail: aggregate ACH Debit batches from recon_ach_batch_lines.
  // Each (batch_filename, batch_effective_date) tuple is one batch
  // submission; lines within it are per-debtor outcomes. We render this
  // only when the account is on the BG rail, so the query is gated by
  // account.rail to keep it cheap on BAC accounts.
  type AchLine = {
    id: string;
    batch_filename: string;
    batch_effective_date: string;
    routing_code: string;
    target_account: string;
    amount_minor: bigint;
    beneficiary_id: string | null;
    beneficiary_name: string | null;
    addenda: string | null;
    error_code: string | null;
    error_description: string | null;
  };
  type AchBatchSummary = {
    filename: string;
    effectiveDate: string;
    totalLines: number;
    approvedLines: number;
    rejectedLines: number;
    totalAmountMinor: bigint;
    approvedAmountMinor: bigint;
    rejectedAmountMinor: bigint;
    /** Per R-code: count + total amount. */
    rejectionsByCode: Map<string, { count: number; amountMinor: bigint }>;
    lines: AchLine[];
  };
  const achBatches: AchBatchSummary[] = [];
  if (account.rail === "bg") {
    const { data: lineRows } = await supabase
      .from("recon_ach_batch_lines")
      .select(
        "id, batch_filename, batch_effective_date, routing_code, target_account, amount_minor, beneficiary_id, beneficiary_name, addenda, error_code, error_description",
      )
      .eq("account_id", accountId)
      .order("batch_effective_date", { ascending: false })
      .order("batch_filename", { ascending: true });
    const byBatch = new Map<string, AchBatchSummary>();
    for (const r of lineRows ?? []) {
      const filename = r.batch_filename as string;
      const effectiveDate = r.batch_effective_date as string;
      const key = `${effectiveDate}|${filename}`;
      let slot = byBatch.get(key);
      if (!slot) {
        slot = {
          filename,
          effectiveDate,
          totalLines: 0,
          approvedLines: 0,
          rejectedLines: 0,
          totalAmountMinor: 0n,
          approvedAmountMinor: 0n,
          rejectedAmountMinor: 0n,
          rejectionsByCode: new Map(),
          lines: [],
        };
        byBatch.set(key, slot);
      }
      const amount = BigInt(String(r.amount_minor));
      const errorCode = (r.error_code as string | null) ?? null;
      const line: AchLine = {
        id: r.id as string,
        batch_filename: filename,
        batch_effective_date: effectiveDate,
        routing_code: r.routing_code as string,
        target_account: r.target_account as string,
        amount_minor: amount,
        beneficiary_id: (r.beneficiary_id as string | null) ?? null,
        beneficiary_name: (r.beneficiary_name as string | null) ?? null,
        addenda: (r.addenda as string | null) ?? null,
        error_code: errorCode,
        error_description: (r.error_description as string | null) ?? null,
      };
      slot.lines.push(line);
      slot.totalLines++;
      slot.totalAmountMinor += amount;
      if (errorCode) {
        slot.rejectedLines++;
        slot.rejectedAmountMinor += amount;
        const codeKey = errorCode;
        const codeSlot = slot.rejectionsByCode.get(codeKey) ?? {
          count: 0,
          amountMinor: 0n,
        };
        codeSlot.count++;
        codeSlot.amountMinor += amount;
        slot.rejectionsByCode.set(codeKey, codeSlot);
      } else {
        slot.approvedLines++;
        slot.approvedAmountMinor += amount;
      }
    }
    // Preserve the SQL order (effective_date DESC, filename ASC).
    achBatches.push(...byBatch.values());
  }

  const bgBatches: BgBatchView[] = [];
  const bgYappyBatches: BgYappyBatchView[] = [];
  const bgYappyLines: BgYappyLineView[] = [];
  const bgPendingTasks: Array<{
    task_type: "missing_statement" | "missing_ach_detail" | "missing_yappy_report";
    missing_item: string;
    details: string | null;
    affects_uid: string;
    amount_minor: bigint | number | string | null;
  }> = [];
  const bgAlerts: Array<{
    message: string;
    severity: "info" | "warn" | "error";
  }> = [];
  const bgCoverageDays: string[] = [];
  const bgQuarantinedDays: string[] = [];
  const bgProvisionalDays: string[] = [];

  if (account.rail === "bg") {
    const { data: bData } = await supabase
      .from("recon_bg_batches")
      .select("*")
      .eq("account_id", accountId)
      .eq("is_active", true)
      .order("batch_date_str", { ascending: false });
    if (bData) {
      bgBatches.push(
        ...bData.map((b) => ({
          uid: b.batch_uid,
          batchDateStr: b.batch_date_str,
          batchName: b.batch_filename,
          channel: b.channel,
          fortnight: b.fortnight,
          isDelinquent: b.is_delinquent,
          retryCount: b.retry_count,
          variant: b.variant as "A" | "B" | "PDF" | null,
          effectiveDate: b.effective_date,
          creditDate: b.credit_date,
          totalTransactions: b.total_transactions,
          succeededTransactions: b.succeeded_transactions,
          declaredRejectedTransactions: b.declared_rejected_transactions,
          rejectedRowsCount: b.rejected_rows_count ?? 0,
          succeededRowsCount: b.succeeded_rows_count ?? 0,
          totalAmountMinor: b.total_amount_minor != null ? BigInt(String(b.total_amount_minor)) : null,
          rejectedAmountMinor: b.rejected_amount_minor != null ? BigInt(String(b.rejected_amount_minor)) : null,
          succeededAmountMinor: b.succeeded_amount_minor != null ? BigInt(String(b.succeeded_amount_minor)) : null,
          status: b.status as "settled" | "settled_no_reversals" | "pending" | "anomaly",
          pendingReason: b.pending_reason,
          creditMovUid: b.credit_mov_uid,
          reversalsMovUids: b.reversals_mov_uids || [],
        }))
      );
    }

    const { data: yData } = await supabase
      .from("recon_bg_yappy_batches")
      .select("*")
      .eq("account_id", accountId)
      .eq("is_active", true)
      .order("credit_date", { ascending: false });
    if (yData) {
      bgYappyBatches.push(
        ...yData.map((yb) => ({
          uid: yb.batch_uid,
          creditDate: yb.credit_date,
          transactionDate: yb.transaction_date,
          declaredCount: yb.declared_count ?? 0,
          reportCount: yb.report_count,
          creditAmountMinor: BigInt(String(yb.credit_amount_minor)),
          reportAmountMinor: yb.report_amount_minor != null ? BigInt(String(yb.report_amount_minor)) : null,
          feeAmountMinor: yb.fee_amount_minor != null ? BigInt(String(yb.fee_amount_minor)) : null,
          feeRate: yb.fee_rate,
          status: yb.status as "settled" | "pending" | "anomaly",
          pendingReason: yb.pending_reason,
        }))
      );
    }

    const yLinesData = await fetchAllPages((cursor, pageSize) =>
      supabase
        .from("recon_bg_yappy_lines")
        .select("*")
        .eq("account_id", accountId)
        .eq("is_active", true)
        .order("posted_date", { ascending: false })
        .order("line_uid", { ascending: false })
        .range(cursor, cursor + pageSize - 1),
    );
    if (yLinesData) {
      bgYappyLines.push(
        ...yLinesData.map((yl) => ({
          uid: yl.line_uid,
          postedDate: yl.posted_date,
          postedTime: yl.posted_time || "",
          reference: yl.reference,
          clientName: yl.client_name || "",
          phoneNumber: yl.phone_number || "",
          comment: yl.comment || "",
          amountMinor: BigInt(String(yl.amount_minor)),
          bankStatus: yl.bank_status,
          status: yl.status as "received" | "pending" | "in_transit" | "anomaly" | "other",
          settlementBatchUid: yl.settlement_batch_uid,
          settlementDate: yl.settlement_date,
        }))
      );
    }

    const { data: ptData } = await supabase
      .from("recon_bg_pending_tasks")
      .select("*")
      .eq("account_id", accountId)
      .eq("is_resolved", false);
    if (ptData) {
      bgPendingTasks.push(
        ...ptData.map((pt) => ({
          task_type: pt.task_type as "missing_statement" | "missing_ach_detail" | "missing_yappy_report",
          missing_item: pt.missing_item,
          details: pt.details,
          affects_uid: pt.affects_uid || "",
          amount_minor: pt.amount_minor != null ? BigInt(String(pt.amount_minor)) : null,
        }))
      );
    }

    const { data: alData } = await supabase
      .from("recon_bg_audit_alerts")
      .select("*")
      .eq("account_id", accountId);
    if (alData) {
      bgAlerts.push(
        ...alData.map((al) => ({
          message: al.message,
          severity: (al.severity === "error" ? "error" : al.severity === "warning" ? "warn" : "info") as "info" | "warn" | "error",
        }))
      );
    }

    const { data: covData } = await supabase
      .from("recon_bg_coverage")
      .select("*")
      .eq("account_id", accountId);
    if (covData) {
      for (const cov of covData) {
        if (cov.is_quarantined) bgQuarantinedDays.push(cov.coverage_date);
        else if (cov.is_provisional) bgProvisionalDays.push(cov.coverage_date);
        else bgCoverageDays.push(cov.coverage_date);
      }
    }
  }

  // Surface a one-time hint if any rejected DAs in the system still have a
  // null return_code — the operator can backfill them via the button.
  const { count: nullDaCount } = await supabase
    .from("recon_transactions")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("code", "DA")
    .is("return_code", null);
  const showBackfillHint = (nullDaCount ?? 0) > 0;

  // Unmatched reversals — DAs that auto-pairing left in 'pending_pair'.
  // We surface them so ops can spot the pattern (truncated names, cents
  // mismatches, etc.) and so manual reconciliation has a starting list.
  const { data: unmatchedDARows } = await supabase
    .from("recon_transactions")
    .select("id, posted_at, debit_minor, description, payer_name_raw, return_code, rail_native_ref")
    .eq("account_id", accountId)
    .eq("code", "DA")
    .eq("state", "pending_pair")
    .order("posted_at", { ascending: true })
    .order("id", { ascending: true });
  const unmatchedDAs = unmatchedDARows ?? [];
  const unmatchedTotal = unmatchedDAs.reduce(
    (sum, d) => sum + BigInt(String(d.debit_minor)),
    0n,
  );

  // For each unmatched DA, find PRs in the account with matching amount AND
  // matching name (no date filter). The closest match (by date) tells us
  // why auto-pairing missed it: out-of-window PR, already-paired PR, or
  // none at all. Single batched query keyed on the unique amounts.
  type CandidatePR = {
    id: string;
    posted_at: string;
    state: string;
    description: string;
    rail_native_ref: string | null;
  };
  type ClosestMatch = {
    count: number;
    pairedCount: number;
    unpairedCount: number;
    closest: {
      posted_at: string;
      state: string;
      ref: string | null;
      paired: boolean;
      /** Snapshot of the closest PR's batch state at this moment. Helps
       *  the operator decide whether a manual pair is reasonable
       *  (the batch may already be locked to a different DA batch). */
      batchSummary: {
        total: number;
        rejected: number;
        confirmed: number;
        pending: number;
      } | null;
    } | null;
    /** UNPAIRED candidates the operator can manually match this DA to. */
    pickable: CandidatePR[];
  };
  const closestByDaId = new Map<string, ClosestMatch>();
  if (unmatchedDAs.length > 0) {
    const uniqueAmounts = Array.from(
      new Set(unmatchedDAs.map((d) => Number(d.debit_minor))),
    );
    const pool: {
      id: string;
      posted_at: string;
      description: string;
      state: string;
      credit_minor: number | bigint;
      rail_native_ref: string | null;
    }[] = [];
    let poolCursor = 0;
    while (poolCursor < 200000) {
      const { data: chunk } = await supabase
        .from("recon_transactions")
        .select(
          "id, posted_at, description, state, credit_minor, rail_native_ref",
        )
        .eq("account_id", accountId)
        .eq("code", "PR")
        .in("credit_minor", uniqueAmounts)
        .order("id", { ascending: true })
        .range(poolCursor, poolCursor + 1000 - 1);
      if (!chunk || chunk.length === 0) break;
      for (const r of chunk) {
        pool.push({
          id: r.id as string,
          posted_at: r.posted_at as string,
          description: (r.description as string | null) ?? "",
          state: r.state as string,
          credit_minor: r.credit_minor as number | bigint,
          rail_native_ref: (r.rail_native_ref as string | null) ?? null,
        });
      }
      if (chunk.length < 1000) break;
      poolCursor += 1000;
    }

    // Pre-fetch the set of already-paired PR ids so we don't offer them
    // as manual-match candidates (they'd hit a 23505 from the link PK).
    const pairedPrIdSet = new Set<string>();
    if (pool.length > 0) {
      const poolIds = pool.map((p) => p.id as string);
      // Chunk to dodge URL-length limits (same 100-id pattern recompute uses).
      const ID_CHUNK = 100;
      for (let i = 0; i < poolIds.length; i += ID_CHUNK) {
        const chunk = poolIds.slice(i, i + ID_CHUNK);
        const { data: links } = await supabase
          .from("recon_links")
          .select("pr_txn_id")
          .in("pr_txn_id", chunk);
        for (const l of links ?? []) pairedPrIdSet.add(l.pr_txn_id as string);
      }
    }

    for (const da of unmatchedDAs) {
      const payerRaw = da.payer_name_raw as string | null;
      if (!payerRaw) {
        closestByDaId.set(da.id, {
          count: 0,
          pairedCount: 0,
          unpairedCount: 0,
          closest: null,
          pickable: [],
        });
        continue;
      }
      const target = normalizeName(payerRaw);
      const daAmountNum = Number(da.debit_minor);
      const matches = pool.filter((c) => {
        if (Number(c.credit_minor) !== daAmountNum) return false;
        const prName = extractPRPayerName(c.description as string);
        if (!prName) return false;
        return namesMatch(normalizeName(prName), target);
      });
      // For pickable candidates (manual match dropdown), prioritize PRs matching
      // the payer name first, then include other unpaired PRs of the same amount.
      const nameMatchedIds = new Set(matches.map((m) => m.id as string));
      const otherSameAmount = pool.filter(
        (c) =>
          Number(c.credit_minor) === daAmountNum &&
          !pairedPrIdSet.has(c.id as string) &&
          !nameMatchedIds.has(c.id as string),
      );
      const orderedCandidates = [
        ...matches.filter((m) => !pairedPrIdSet.has(m.id as string)),
        ...otherSameAmount,
      ];
      const pickable: CandidatePR[] = orderedCandidates.map((m) => ({
        id: m.id as string,
        posted_at: m.posted_at as string,
        state: m.state as string,
        description: m.description as string,
        rail_native_ref: (m.rail_native_ref as string | null) ?? null,
      }));
      const pairedCount = matches.filter((m) =>
        pairedPrIdSet.has(m.id as string),
      ).length;
      const unpairedCount = matches.length - pairedCount;
      const first = matches[0];
      let closest: ClosestMatch["closest"] = null;
      if (first) {
        const ref = (first.rail_native_ref as string | null) ?? null;
        const summary = ref ? prBatchSummary.get(ref) : undefined;
        closest = {
          posted_at: first.posted_at as string,
          state: first.state as string,
          ref,
          paired: pairedPrIdSet.has(first.id as string),
          batchSummary: summary
            ? {
                total: summary.total,
                rejected: summary.rejected,
                confirmed: summary.confirmed,
                pending: summary.pending,
              }
            : null,
        };
      }
      closestByDaId.set(da.id, {
        count: matches.length,
        pairedCount,
        unpairedCount,
        closest,
        pickable,
      });
    }
  }

  // KPI: lifetime count of operator-curated manual matches on this account.
  // Joining via inner-side filter on the embedded recon_transactions row
  // keeps the count scoped to this account without an account_id column on
  // recon_links.
  const { count: manualMatchCount } = await supabase
    .from("recon_links")
    .select(
      "pr_txn_id, pr:recon_transactions!recon_links_pr_txn_id_fkey!inner(account_id)",
      { count: "exact", head: true },
    )
    .eq("match_strategy", "manual")
    .eq("pr.account_id", accountId);

  const totalsByState = totalsRows.reduce(
    (acc, r) => {
      const s = r.state as keyof typeof acc;
      if (s in acc) {
        acc[s].count++;
        acc[s].minor += BigInt(String(r.credit_minor));
      }
      return acc;
    },
    {
      pending: { count: 0, minor: 0n },
      confirmed: { count: 0, minor: 0n },
      rejected: { count: 0, minor: 0n },
    } as Record<"pending" | "confirmed" | "rejected", { count: number; minor: bigint }>,
  );

  const baseQS = (overrides: Partial<SearchParams>): string => {
    const merged: SearchParams = {
      state: stateFilter,
      from,
      to,
      sort,
      dir,
      page: String(safePage),
      perPage: String(perPage),
      // Preserve "show all history" toggle across pagination/sort/perPage
      // links — without this, clicking Next or a per-page chip dropped us
      // back to the last-2-working-days default.
      range: showAll ? "all" : undefined,
      ...overrides,
    };
    const usp = new URLSearchParams();
    if (merged.state && merged.state !== "all") usp.set("state", merged.state);
    if (merged.range === "all") usp.set("range", "all");
    if (merged.from) usp.set("from", merged.from);
    if (merged.to) usp.set("to", merged.to);
    if (merged.sort && merged.sort !== "posted_at") usp.set("sort", merged.sort);
    if (merged.dir && merged.dir !== "desc") usp.set("dir", merged.dir);
    if (merged.page && merged.page !== "1") usp.set("page", merged.page);
    if (merged.perPage && merged.perPage !== String(PER_PAGE_DEFAULT))
      usp.set("perPage", merged.perPage);
    const s = usp.toString();
    return s ? `?${s}` : "";
  };

  const exportHref = `/recon/accounts/${accountId}/export${exportQS({
    state: stateFilter,
    from,
    to,
    range: showAll ? "all" : undefined,
  })}`;

  const showingFrom = total === 0 ? 0 : start + 1;
  const showingTo = Math.min(start + perPage, total);

  return (
    <OperatorShell session={session}>
      <BulkSelectionProvider>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <Link href="/recon/upload" className="hover:text-fg">
              Reconciliation
            </Link>
            <span>·</span>
            <span>Accounts</span>
          </div>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
            {account.holder_name}
          </h1>
          <p className="mt-1 text-sm text-fg-muted">
            {account.rail.toUpperCase()} · {account.account_number} · {account.currency}
          </p>
        </div>
        <RecomputeButton accountId={accountId} />
      </header>

      <section
        aria-label="Loan-credit totals"
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        <Stat label="Pending" tone="info" {...totalsByState.pending} />
        <Stat label="Confirmed" tone="success" {...totalsByState.confirmed} />
        <Stat label="Rejected" tone="warning" {...totalsByState.rejected} />
      </section>

      <section
        aria-label="Reconciliation KPIs"
        className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <KpiCard
          label="Unmatched reversals"
          tone={unmatchedDAs.length > 0 ? "warning" : "muted"}
          primary={String(unmatchedDAs.length)}
          secondary={formatMinorUSD(unmatchedTotal)}
        />
        <KpiCard
          label="Manual matches (lifetime)"
          tone="muted"
          primary={String(manualMatchCount ?? 0)}
          secondary="Operator-curated pairings"
        />
      </section>

      {showBackfillHint && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-fg">
          <div>
            <strong className="text-warning">DVTO codes not yet extracted</strong>{" "}
            for {nullDaCount} reversal row{nullDaCount === 1 ? "" : "s"} on this
            account. Re-parse to populate them.
          </div>
          <BackfillButton accountId={accountId} />
        </div>
      )}

      {unmatchedDAs.length > 0 && (
        <Card className="mt-6 border-warning/40">
          <CardHeader>
            <CardTitle>
              Unmatched reversals ({unmatchedDAs.length} ·{" "}
              {formatMinorUSD(unmatchedTotal)})
            </CardTitle>
            <CardDescription>
              DAs that auto-pairing couldn&apos;t place against a PR — usually
              from a name-extraction or cents-mismatch edge case. Spot the
              pattern here, then we can either tighten the auto-matching or
              wire up manual reconciliation.
            </CardDescription>
          </CardHeader>
          <CardBody>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <th className="pb-3 pr-4">Date</th>
                    <th className="pb-3 pr-4">Code</th>
                    <th className="pb-3 pr-4">Payer (parsed)</th>
                    <th className="pb-3 pr-4 text-right">Amount</th>
                    <th className="pb-3 pr-4">Closest PR (any date)</th>
                    <th className="pb-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {unmatchedDAs.map((row) => {
                    const cm = closestByDaId.get(row.id);
                    return (
                      <tr key={row.id}>
                        <td className="py-3 pr-4 text-fg-muted">
                          {formatDate(row.posted_at as string)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs text-fg">
                          {row.return_code ?? "—"}
                        </td>
                        <td className="py-3 pr-4 text-fg">
                          {(row.payer_name_raw as string | null) ?? "—"}
                        </td>
                        <td className="py-3 pr-4 text-right font-medium tabular-nums text-fg">
                          {formatMinorUSD(String(row.debit_minor))}
                        </td>
                        <td className="py-3 pr-4 text-xs">
                          <ClosestPRCell match={cm} />
                        </td>
                        <td className="py-3 align-top">
                          <MatchToPRButton
                            accountId={accountId}
                            daTxnId={row.id as string}
                            candidates={cm?.pickable ?? []}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Pending PR batches — Referencias with ≥1 PR still in `pending`.
          Each row offers a "Confirm batch" action that flips every
          pending PR in that Referencia to `confirmed` in one shot. */}
      {(() => {
        const pendingBatches = Array.from(prBatchSummary.entries())
          .filter(([, s]) => s.pending > 0)
          .sort((a, b) => {
            const da = a[1].earliestPostedAt ?? "";
            const db = b[1].earliestPostedAt ?? "";
            if (da !== db) return da < db ? -1 : 1;
            return a[0] < b[0] ? -1 : 1;
          });
        if (pendingBatches.length === 0) return null;
        const totalPendingPrs = pendingBatches.reduce(
          (acc, [, s]) => acc + s.pending,
          0,
        );
        const totalPendingMinor = pendingBatches.reduce(
          (acc, [, s]) => acc + s.pendingAmountMinor,
          0n,
        );
        return (
          <Card className="mt-6 border-info/40">
            <CardHeader>
              <CardTitle>
                Pending PR batches ({pendingBatches.length} batch
                {pendingBatches.length === 1 ? "" : "es"} ·{" "}
                {totalPendingPrs} PR{totalPendingPrs === 1 ? "" : "s"} ·{" "}
                {formatMinorUSD(totalPendingMinor)})
              </CardTitle>
              <CardDescription>
                Referencias with PRs still awaiting confirmation. Operator
                can confirm an entire batch when the bank has indicated no
                more DAs will arrive (e.g. end-of-day cutoff passed).
                Otherwise leave them — they&apos;ll auto-confirm if a future
                file&apos;s DA batch links to them.
              </CardDescription>
            </CardHeader>
            <CardBody>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                    <tr>
                      <th className="pb-3 pr-4">Earliest posted</th>
                      <th className="pb-3 pr-4">Referencia</th>
                      <th className="pb-3 pr-4 text-right">Pending PRs</th>
                      <th className="pb-3 pr-4 text-right">Pending amount</th>
                      <th className="pb-3 pr-4">Batch state</th>
                      <th className="pb-3">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {pendingBatches.map(([ref, summary]) => (
                      <tr key={ref}>
                        <td className="py-3 pr-4 text-fg-muted">
                          {summary.earliestPostedAt
                            ? formatDate(summary.earliestPostedAt)
                            : "—"}
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs text-fg">
                          {ref}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums text-fg">
                          {summary.pending}
                          <span className="text-fg-subtle"> / {summary.total}</span>
                        </td>
                        <td className="py-3 pr-4 text-right font-medium tabular-nums text-fg">
                          {formatMinorUSD(summary.pendingAmountMinor)}
                        </td>
                        <td className="py-3 pr-4 text-xs text-fg-muted">
                          <span className="text-warning">{summary.rejected}</span>
                          {" rej · "}
                          <span className="text-success">{summary.confirmed}</span>
                          {" conf · "}
                          <span className="text-info">{summary.pending}</span>
                          {" pend"}
                        </td>
                        <td className="py-3 align-top">
                          <BulkConfirmBatchButton
                            accountId={accountId}
                            railNativeRef={ref}
                            pendingCount={summary.pending}
                            pendingAmountLabel={formatMinorUSD(
                              summary.pendingAmountMinor,
                            )}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        );
      })()}

      {/* BG-rail CCBG v2 Reconciliation Panels */}
      {account.rail === "bg" && (
        <div className="mt-6 space-y-6">
          {(bgPendingTasks.length > 0 || bgAlerts.length > 0 || bgQuarantinedDays.length > 0) && (
            <BgPendingTasksPanel
              pendingTasks={bgPendingTasks}
              alerts={bgAlerts}
              quarantinedDays={bgQuarantinedDays}
              provisionalDays={bgProvisionalDays}
            />
          )}

          <BgBatchList batches={bgBatches} />

          <BgYappyPanel accountId={accountId} batches={bgYappyBatches} lines={bgYappyLines} />
        </div>
      )}

      {/* BG-rail only: ACH Debit batches breakdown view */}
      {account.rail === "bg" && achBatches.length > 0 && (
        <Card className="mt-6 border-info/40">
          <CardHeader>
            <CardTitle>
              ACH Debit batches ({achBatches.length} batch
              {achBatches.length === 1 ? "" : "es"} ·{" "}
              {formatMinorUSD(
                achBatches.reduce((a, b) => a + b.totalAmountMinor, 0n),
              )}{" "}
              gross)
            </CardTitle>
            <CardDescription>
              One row per ACH Debit batch (the bank&apos;s response file
              for one outbound submission). Click a row to drill into the
              per-debtor outcomes. Linking to the statement&apos;s lump
              credit / debit rows comes in a later chunk.
            </CardDescription>
          </CardHeader>
          <CardBody>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <th className="pb-3 pr-2 sr-only">Expand</th>
                    <th className="pb-3 pr-4">Effective</th>
                    <th className="pb-3 pr-4">Filename</th>
                    <th className="pb-3 pr-4 text-right">Transactions</th>
                    <th className="pb-3 pr-4 text-right">Gross</th>
                    <th className="pb-3 pr-4 text-right">Approved</th>
                    <th className="pb-3 pr-4 text-right">Rejected</th>
                    <th className="pb-3 pr-4">R-codes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {achBatches.map((batch) => {
                    const rCodeLabel =
                      batch.rejectionsByCode.size === 0
                        ? "—"
                        : Array.from(batch.rejectionsByCode.entries())
                            .sort((a, b) => b[1].count - a[1].count)
                            .map(([code, info]) => `${code}×${info.count}`)
                            .join(" · ");
                    const cells = (
                      <>
                        <td className="py-3 pr-4 text-xs text-fg-muted">
                          {formatDate(batch.effectiveDate)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs text-fg max-w-[280px] truncate">
                          {batch.filename}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums text-fg">
                          {batch.totalLines}
                        </td>
                        <td className="py-3 pr-4 text-right font-medium tabular-nums text-fg">
                          {formatMinorUSD(batch.totalAmountMinor)}
                        </td>
                        <td className="py-3 pr-4 text-right text-success tabular-nums">
                          {batch.approvedLines}
                          <span className="text-fg-subtle">
                            {" · "}
                            {formatMinorUSD(batch.approvedAmountMinor)}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-right text-warning tabular-nums">
                          {batch.rejectedLines}
                          <span className="text-fg-subtle">
                            {" · "}
                            {formatMinorUSD(batch.rejectedAmountMinor)}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-xs text-fg-muted max-w-[260px] truncate">
                          {rCodeLabel}
                        </td>
                      </>
                    );
                    const detail = (
                      <div className="space-y-3">
                        <div className="text-xs text-fg-muted">
                          {batch.totalLines} lines · approved{" "}
                          <span className="text-success">
                            {batch.approvedLines}
                          </span>{" "}
                          ({formatMinorUSD(batch.approvedAmountMinor)}) ·
                          rejected{" "}
                          <span className="text-warning">
                            {batch.rejectedLines}
                          </span>{" "}
                          ({formatMinorUSD(batch.rejectedAmountMinor)})
                        </div>
                        {batch.rejectionsByCode.size > 0 && (
                          <div className="flex flex-wrap gap-2 text-xs">
                            {Array.from(batch.rejectionsByCode.entries())
                              .sort((a, b) => b[1].count - a[1].count)
                              .map(([code, info]) => (
                                <span
                                  key={code}
                                  className="rounded border border-border-subtle bg-bg-surface px-2 py-1"
                                >
                                  <span className="font-mono text-fg">
                                    {code}
                                  </span>
                                  <span className="text-fg-subtle">
                                    {" · "}
                                    {info.count} ·{" "}
                                    {formatMinorUSD(info.amountMinor)}
                                  </span>
                                </span>
                              ))}
                          </div>
                        )}
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="text-left text-[10px] uppercase tracking-wide text-fg-subtle">
                              <tr>
                                <th className="pb-2 pr-3">Target account</th>
                                <th className="pb-2 pr-3 text-right">Amount</th>
                                <th className="pb-2 pr-3">Beneficiary ID</th>
                                <th className="pb-2 pr-3">Name</th>
                                <th className="pb-2 pr-3">R-code</th>
                                <th className="pb-2 pr-3">Reason</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border-subtle">
                              {batch.lines.map((line) => (
                                <tr key={line.id}>
                                  <td className="py-2 pr-3 font-mono text-[11px] text-fg-muted">
                                    {line.target_account}
                                  </td>
                                  <td className="py-2 pr-3 text-right font-medium tabular-nums text-fg">
                                    {formatMinorUSD(line.amount_minor)}
                                  </td>
                                  <td className="py-2 pr-3 font-mono text-[11px] text-fg-muted">
                                    {line.beneficiary_id ?? "—"}
                                  </td>
                                  <td className="py-2 pr-3 text-fg">
                                    {line.beneficiary_name ?? "—"}
                                  </td>
                                  <td className="py-2 pr-3 font-mono text-[11px]">
                                    {line.error_code ? (
                                      <span className="text-warning">
                                        {line.error_code}
                                      </span>
                                    ) : (
                                      <span className="text-success">
                                        OK
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-2 pr-3 text-fg-muted">
                                    {line.error_description ?? "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                    return (
                      <BGAchBatchRow
                        key={`${batch.effectiveDate}|${batch.filename}`}
                        rowKey={`${batch.effectiveDate}|${batch.filename}`}
                        cells={cells}
                        detail={detail}
                        cellCount={7}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}

      <Card className="mt-8">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>
              {account.rail === "bg"
                ? "Transacciones regulares (Estado de cuenta)"
                : "Loan-related credits"}
            </CardTitle>
            <CardDescription>
              {account.rail === "bg"
                ? "Transferencias en línea, banca móvil, ACH Xpress, ACH interbancario y depósitos conciliados del estado de cuenta."
                : "PR (Junto-initiated ACH inbound) and 4C / 4E (irrevocable inbound ACH) only."}
            </CardDescription>
          </div>
          <Button asChild variant="secondary" size="sm">
            <a href={exportHref}>
              <Download className="h-4 w-4" />
              Export Excel ({total})
            </a>
          </Button>
        </CardHeader>

        <form className="border-b border-border-subtle bg-bg-raised/40 px-6 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="state">Status</Label>
              <select
                id="state"
                name="state"
                defaultValue={stateFilter}
                className="block w-full rounded border border-border bg-bg-inset px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="from">From</Label>
              <Input id="from" type="date" name="from" defaultValue={from ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to">To</Label>
              <Input id="to" type="date" name="to" defaultValue={to ?? ""} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm">
                <Filter className="h-4 w-4" />
                Apply
              </Button>
              {(stateFilter !== "all" || explicitFrom || explicitTo || showAll) && (
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/recon/accounts/${accountId}`}>Reset</Link>
                </Button>
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-fg-subtle">
            <span>
              {usingDefault
                ? `Showing the last 2 working days (${from} → ${to}). `
                : showAll
                  ? "Showing all history. "
                  : "Custom range. "}
            </span>
            {!showAll && (
              <Link
                href={`/recon/accounts/${accountId}${baseQS({ range: "all", from: undefined, to: undefined, page: "1" })}`}
                className="text-brand-300 hover:text-brand-200"
              >
                Show all history
              </Link>
            )}
            {showAll && (
              <Link
                href={`/recon/accounts/${accountId}${baseQS({ range: undefined, from: undefined, to: undefined, page: "1" })}`}
                className="text-brand-300 hover:text-brand-200"
              >
                Back to last 2 working days
              </Link>
            )}
          </div>
          {/* Preserve sort + perPage when re-applying filters */}
          {sort !== "posted_at" && <input type="hidden" name="sort" value={sort} />}
          {dir !== "desc" && <input type="hidden" name="dir" value={dir} />}
          {perPage !== PER_PAGE_DEFAULT && (
            <input type="hidden" name="perPage" value={String(perPage)} />
          )}
        </form>

        <CardBody>
          {credits.length === 0 ? (
            <p className="text-sm text-fg-muted">
              {account.rail === "bg"
                ? "No hay transacciones regulares del estado de cuenta con los filtros seleccionados."
                : "No loan credits match the current filters."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <th className="pb-3 pr-2 sr-only">Expand</th>
                    <th className="pb-3 pr-2 sr-only">Select</th>
                    <SortHeader col="posted_at" label="Date" sort={sort} dir={dir} accountId={accountId} qs={baseQS} />
                    <SortHeader col="code" label="Code" sort={sort} dir={dir} accountId={accountId} qs={baseQS} />
                    <SortHeader col="description" label="Payer" sort={sort} dir={dir} accountId={accountId} qs={baseQS} />
                    <SortHeader col="credit_minor" label="Amount" sort={sort} dir={dir} accountId={accountId} qs={baseQS} align="right" />
                    <SortHeader col="state" label="Status" sort={sort} dir={dir} accountId={accountId} qs={baseQS} />
                    <th className="pb-3 pr-4">Reason / Detail</th>
                    <SortHeader col="rail_native_ref" label="Reference" sort={sort} dir={dir} accountId={accountId} qs={baseQS} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {credits.map((row) => {
                    const reason = reasonByPrId.get(row.id);
                    let reasonText: string;
                    if (row.state === "rejected") {
                      if (reason?.code) {
                        reasonText = `${reason.code} · ${reasonForDvtoCode(reason.code).label}`;
                      } else if (reason?.description) {
                        // Legacy fallback: the parser regex missed this DA's
                        // code, so surface the raw description so the operator
                        // still has actionable context.
                        reasonText = reason.description;
                      } else {
                        reasonText = "—";
                      }
                    } else if (row.state === "pending") {
                      reasonText = account.rail === "bg" ? "Por asignar" : "Awaiting batch link";
                    } else if (account.rail === "bg" && row.state === "confirmed") {
                      reasonText = "Recibido / Confirmado";
                    } else {
                      reasonText = "—";
                    }
                    const payer =
                      (row.payer_name_raw as string | null) ??
                      extractPRPayerName(row.description as string) ??
                      "—";
                    const cells = (
                      <>
                        <td className="py-3 pr-4 text-fg-muted">
                          {formatDate(row.posted_at as string)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs text-fg">
                          {row.code}
                        </td>
                        <td className="py-3 pr-4 text-fg">{payer}</td>
                        <td className="py-3 pr-4 text-right font-medium tabular-nums text-fg">
                          {formatMinorUSD(String(row.credit_minor))}
                        </td>
                        <td className="py-3 pr-4">
                          <StateBadge state={row.state as string} />
                        </td>
                        <td className="py-3 pr-4 text-xs text-fg-muted">
                          {reasonText}
                        </td>
                        <td className="py-3 font-mono text-xs text-fg-muted">
                          {(row.rail_native_ref as string) || "—"}
                        </td>
                      </>
                    );
                    const ref = row.rail_native_ref as string | null;
                    const confirmedByBatch =
                      row.code === "PR" &&
                      row.state === "confirmed" &&
                      Boolean(ref) &&
                      consumedBatchRefs.has(ref!);
                    const detail = (
                      <RowDetailPanel
                        accountId={accountId}
                        row={{
                          id: row.id as string,
                          posted_at: row.posted_at as string,
                          code: row.code as string,
                          state: row.state as string,
                          credit_minor: row.credit_minor as string | number,
                          description: row.description as string | null,
                          rail_native_ref: ref,
                          payer_name_raw: row.payer_name_raw as string | null,
                          confirmedByBatch,
                        }}
                        linkedDA={linkedDaByPrId.get(row.id as string)}
                        manualActions={manualActionsByPrId.get(row.id as string) ?? []}
                        actors={actorById}
                        rejectCandidates={candidateDAsByPrId.get(row.id as string) ?? []}
                        prBatchSummary={ref ? prBatchSummary.get(ref) : undefined}
                      />
                    );
                    // Bulk-selectable iff this is a pending PR. Other rows
                    // (rejected, confirmed, 4C, 4E) don't have a bulk action
                    // path and render an empty checkbox cell.
                    const selectable =
                      row.code === "PR" && row.state === "pending"
                        ? {
                            id: row.id as string,
                            amountMinor: BigInt(String(row.credit_minor)),
                          }
                        : undefined;
                    return (
                      <LoanCreditRow
                        key={row.id}
                        rowKey={row.id as string}
                        cells={cells}
                        detail={detail}
                        cellCount={7}
                        selectable={selectable}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>

        {total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-6 py-3 text-sm text-fg-muted">
            <div>
              Showing <span className="text-fg tabular-nums">{showingFrom}</span>–
              <span className="text-fg tabular-nums">{showingTo}</span> of{" "}
              <span className="text-fg tabular-nums">{total}</span>
            </div>
            <div className="flex items-center gap-3">
              <PerPageSelect accountId={accountId} qs={baseQS} current={perPage} />
              <div className="flex items-center gap-1">
                <PageLink
                  accountId={accountId}
                  qs={baseQS}
                  page={Math.max(1, safePage - 1)}
                  disabled={safePage <= 1}
                  label="Prev"
                />
                <span className="px-2 text-xs">
                  Page <span className="text-fg tabular-nums">{safePage}</span> of{" "}
                  <span className="text-fg tabular-nums">{totalPages}</span>
                </span>
                <PageLink
                  accountId={accountId}
                  qs={baseQS}
                  page={Math.min(totalPages, safePage + 1)}
                  disabled={safePage >= totalPages}
                  label="Next"
                />
              </div>
            </div>
          </div>
        )}
      </Card>

      <BulkActionBar accountId={accountId} />
      </BulkSelectionProvider>
    </OperatorShell>
  );
}

function SortHeader({
  col,
  label,
  sort,
  dir,
  accountId,
  qs,
  align = "left",
}: {
  col: SortKey;
  label: string;
  sort: SortKey;
  dir: "asc" | "desc";
  accountId: string;
  qs: (overrides: Partial<SearchParams>) => string;
  align?: "left" | "right";
}) {
  const active = sort === col;
  // Toggle direction on the active column; new column defaults to desc
  // (matching the page's overall recency-first orientation).
  const nextDir = active && dir === "desc" ? "asc" : "desc";
  const Icon = !active ? ChevronsUpDown : dir === "desc" ? ChevronDown : ChevronUp;
  return (
    <th className={`pb-3 pr-4 ${align === "right" ? "text-right" : ""}`}>
      <Link
        href={`/recon/accounts/${accountId}${qs({ sort: col, dir: nextDir, page: "1" })}`}
        className={`inline-flex items-center gap-1 hover:text-fg ${active ? "text-fg" : ""} ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        <span>{label}</span>
        <Icon className="h-3 w-3" />
      </Link>
    </th>
  );
}

function PageLink({
  accountId,
  qs,
  page,
  disabled,
  label,
}: {
  accountId: string;
  qs: (overrides: Partial<SearchParams>) => string;
  page: number;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="rounded border border-border-subtle px-3 py-1 text-xs text-fg-subtle opacity-50">
        {label}
      </span>
    );
  }
  return (
    <Link
      href={`/recon/accounts/${accountId}${qs({ page: String(page) })}`}
      className="rounded border border-border-subtle px-3 py-1 text-xs text-fg hover:bg-bg-raised"
    >
      {label}
    </Link>
  );
}

function PerPageSelect({
  accountId,
  qs,
  current,
}: {
  accountId: string;
  qs: (overrides: Partial<SearchParams>) => string;
  current: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs">Per page</span>
      <div className="flex gap-1">
        {PER_PAGE_OPTIONS.map((n) => (
          <Link
            key={n}
            href={`/recon/accounts/${accountId}${qs({ perPage: String(n), page: "1" })}`}
            className={`rounded px-2 py-0.5 text-xs ${
              n === current
                ? "bg-bg-raised text-fg"
                : "text-fg-subtle hover:bg-bg-raised hover:text-fg"
            }`}
          >
            {n}
          </Link>
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  count,
  minor,
  tone,
}: {
  label: string;
  count: number;
  minor: bigint;
  tone: "info" | "success" | "warning";
}) {
  const colors = {
    info: "bg-info-subtle text-info",
    success: "bg-success-subtle text-success",
    warning: "bg-warning-subtle text-warning",
  } as const;
  return (
    <div className="rounded border border-border-subtle bg-bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-fg-subtle">{label}</span>
        <span className={`rounded px-2 py-0.5 text-xs ${colors[tone]}`}>{count}</span>
      </div>
      <div className="mt-2 font-display text-2xl font-semibold text-fg tabular-nums">
        {formatMinorUSD(minor)}
      </div>
    </div>
  );
}

function KpiCard({
  label,
  tone,
  primary,
  secondary,
}: {
  label: string;
  tone: "warning" | "muted";
  primary: string;
  secondary: string;
}) {
  const headingColor = tone === "warning" ? "text-warning" : "text-fg";
  return (
    <div className="rounded border border-border-subtle bg-bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className={`mt-2 font-display text-2xl font-semibold tabular-nums ${headingColor}`}>
        {primary}
      </div>
      <div className="mt-1 text-xs text-fg-muted">{secondary}</div>
    </div>
  );
}

function ClosestPRCell({
  match,
}: {
  match:
    | {
        count: number;
        pairedCount: number;
        unpairedCount: number;
        closest: {
          posted_at: string;
          state: string;
          ref: string | null;
          paired: boolean;
          batchSummary: {
            total: number;
            rejected: number;
            confirmed: number;
            pending: number;
          } | null;
        } | null;
      }
    | undefined;
}) {
  if (!match || match.count === 0) {
    return <span className="text-fg-subtle">No matching PR found</span>;
  }
  const c = match.closest!;
  const headerTone = c.paired ? "text-warning" : "text-info";
  return (
    <div className="space-y-0.5">
      <div className={headerTone}>
        {match.count} candidate{match.count === 1 ? "" : "s"}
        {match.unpairedCount > 0 && match.pairedCount > 0
          ? ` · ${match.unpairedCount} unpaired, ${match.pairedCount} paired`
          : c.paired
            ? " · already paired"
            : ` · ${c.state}`}
      </div>
      <div className="text-xs text-fg-muted">
        Closest: {formatDate(c.posted_at)}
        {c.ref ? (
          <>
            {" · ref "}
            <code className="font-mono text-[11px] text-fg">{c.ref}</code>
          </>
        ) : null}
      </div>
      {c.batchSummary && (
        <div className="text-[11px] text-fg-subtle">
          Batch: {c.batchSummary.total} PR
          {c.batchSummary.total === 1 ? "" : "s"} ·{" "}
          <span className="text-warning">{c.batchSummary.rejected}</span> rej ·{" "}
          <span className="text-success">{c.batchSummary.confirmed}</span> conf ·{" "}
          <span className={c.batchSummary.pending > 0 ? "text-info" : ""}>
            {c.batchSummary.pending}
          </span>{" "}
          pend
        </div>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const tone =
    state === "confirmed"
      ? "bg-success-subtle text-success"
      : state === "rejected"
        ? "bg-warning-subtle text-warning"
        : "bg-info-subtle text-info";
  return (
    <span className={`rounded px-2 py-0.5 text-xs capitalize ${tone}`}>{state}</span>
  );
}

// Export route only takes filters, never sort/pagination — admins always
// get the full filtered set in the .xlsx. We pass an explicit `range=all`
// in show-all mode so the export skips date filters even though no from/to
// are present in the URL (different from the page's "no params" default,
// which would otherwise apply the last-2-working-days window).
function exportQS(params: {
  state: string;
  from?: string;
  to?: string;
  range?: string;
}): string {
  const sp = new URLSearchParams();
  if (params.state && params.state !== "all") sp.set("state", params.state);
  if (params.range === "all") sp.set("range", "all");
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  const s = sp.toString();
  return s ? `?${s}` : "";
}
