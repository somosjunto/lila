import "@supabase/functions-js/edge-runtime.d.ts";

import { requireAuth, getAdminClient } from "../_shared/auth.ts";
import { computeFileSha256, uploadToStorage } from "../_shared/storage.ts";
import { detectAndParseBgFile } from "./parsers/sniffer.ts";
import { reconcileBancoGeneral } from "./reconcile.ts";
import { syncSnapshotToDatabase, fetchManualAssignments } from "./snapshot-sync.ts";
import { toCanonicalJsonContract } from "./formatters.ts";
import type {
  BgParsedAchDetail,
  BgParsedStatement,
  BgParsedYappyReport,
} from "./types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export default {
  fetch: async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    try {
      // 1. Authenticate Request
      const session = await requireAuth(req);
      const url = new URL(req.url);
      const accountIdParam = url.searchParams.get("account_id");
      const isRecompute = url.searchParams.get("recompute") === "true";

      const adminSupabase = getAdminClient();

      let accountId = accountIdParam || "";
      const statements: BgParsedStatement[] = [];
      const achDetails: BgParsedAchDetail[] = [];
      const yappyReports: BgParsedYappyReport[] = [];
      const parsedFilesSummary: Array<{ filename: string; fileType: string; rowsCount: number }> = [];

      const contentType = req.headers.get("content-type") || "";

      if (contentType.includes("multipart/form-data")) {
        const formData = await req.formData();
        accountId = (formData.get("account_id") as string) || accountId;

        for (const [_, value] of formData.entries()) {
          if (value instanceof File) {
            const buf = new Uint8Array(await value.arrayBuffer());
            const sha = await computeFileSha256(buf);
            const ext = value.name.endsWith(".xls") ? "xls" : value.name.endsWith(".pdf") ? "pdf" : "xlsx";
            const storagePath = `${accountId}/${sha}.${ext}`;

            // Save raw file in Supabase Storage
            await uploadToStorage(storagePath, buf, value.type || "application/octet-stream").catch(() => {});

            const parsed = detectAndParseBgFile(buf, value.name);
            if (parsed) {
              let uploadMethod: "statement_bg_excel" | "ach_detail_bg_excel" | "yappy_bg_excel" = "statement_bg_excel";

              if (parsed.fileType === "statement") {
                uploadMethod = "statement_bg_excel";
                statements.push(parsed);
                parsedFilesSummary.push({
                  filename: value.name,
                  fileType: "statement",
                  rowsCount: parsed.rows.length,
                });
              } else if (parsed.fileType === "ach_detail") {
                uploadMethod = "ach_detail_bg_excel";
                achDetails.push(parsed);
                parsedFilesSummary.push({
                  filename: value.name,
                  fileType: "ach_detail",
                  rowsCount: parsed.rows.length,
                });
              } else if (parsed.fileType === "yappy") {
                uploadMethod = "yappy_bg_excel";
                yappyReports.push(parsed);
                parsedFilesSummary.push({
                  filename: value.name,
                  fileType: "yappy",
                  rowsCount: parsed.rows.length,
                });
              }

              // Record in recon_uploads table
              await adminSupabase.from("recon_uploads").upsert(
                {
                  account_id: accountId,
                  original_filename: value.name,
                  file_sha256: sha,
                  uploaded_by: session.userId,
                  storage_path: storagePath,
                  method: uploadMethod,
                },
                { onConflict: "account_id,file_sha256" },
              );
            }
          }
        }
      } else if (contentType.includes("application/json")) {
        const body = await req.json().catch(() => ({}));
        accountId = body.account_id || accountId;
      }

      if (!accountId) {
        return new Response(
          JSON.stringify({ error: "account_id is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Verify account belongs to 'bg' rail
      const { data: account, error: accError } = await adminSupabase
        .from("bank_accounts")
        .select("id, account_number, holder_name, rail")
        .eq("id", accountId)
        .single();

      if (accError || !account) {
        return new Response(
          JSON.stringify({ error: `Bank account ${accountId} not found` }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // If no files uploaded and not recomputing, return bad request
      if (statements.length === 0 && achDetails.length === 0 && yappyReports.length === 0 && !isRecompute) {
        return new Response(
          JSON.stringify({ error: "No recognized Banco General files uploaded (.xlsx, .xls, .pdf)" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // 2. Fetch operator manual assignments
      const manualAssignments = await fetchManualAssignments(adminSupabase, accountId);

      // 3. Execute deterministic reconciliation
      const snapshot = reconcileBancoGeneral(
        statements,
        achDetails,
        yappyReports,
        {
          expectedAccount: account.account_number,
          manualAssignments,
        },
      );

      // 4. Sync snapshot into Supabase tables
      const syncResult = await syncSnapshotToDatabase(adminSupabase, accountId, snapshot);

      // 5. Format canonical response
      const canonicalContract = toCanonicalJsonContract(snapshot);

      return new Response(
        JSON.stringify({
          status: "ok",
          user_id: session.userId,
          account_id: accountId,
          files_processed: parsedFilesSummary,
          sync: syncResult,
          contract: canonicalContract,
          controls: snapshot.controls,
          alerts_count: snapshot.alerts.length,
          pending_tasks_count: snapshot.pendingTasks.length,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message || "Internal server error in bg-recon" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  },
};
