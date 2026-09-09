// Unit test for syncSnapshotToDatabase with Banco General snapshot.incoming synchronization.

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  reconcileBancoGeneral,
  syncSnapshotToDatabase,
} from "@/lib/recon/bg";

import { loadBgSamples } from "./fixtures/load-samples";

describe("syncSnapshotToDatabase · BG Incoming synchronization", () => {
  const loaded = loadBgSamples();
  const snapshot = reconcileBancoGeneral(
    loaded.statements,
    loaded.achDetails,
    loaded.yappyReports,
  );

  it("syncs voluntary incoming transactions into recon_transactions", async () => {
    const upsertedRows: Record<string, unknown>[] = [];

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === "recon_uploads") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: "00000000-0000-0000-0000-000000000001" },
              error: null,
            }),
          };
        }

        if (table === "recon_transactions") {
          return {
            upsert: vi.fn((rows: Record<string, unknown>[]) => {
              upsertedRows.push(...rows);
              return Promise.resolve({ error: null });
            }),
          };
        }

        if (table === "recon_bg_batches" || table === "recon_bg_yappy_batches") {
          return {
            upsert: vi.fn().mockResolvedValue({ error: null }),
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ error: null }),
            update: vi.fn().mockReturnThis(),
          };
        }

        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          insert: vi.fn().mockResolvedValue({ error: null }),
          delete: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({ error: null }),
        };
      }),
    };

    const accountId = "00000000-0000-0000-0000-000000000099";
    const result = await syncSnapshotToDatabase(
      mockSupabase as unknown as SupabaseClient,
      accountId,
      snapshot,
    );

    expect(result.incomingUpserted).toBe(snapshot.incoming.length);
    expect(upsertedRows.length).toBe(snapshot.incoming.length);

    // Verify properties of upserted recon_transactions
    const receivedRows = upsertedRows.filter((r) => r.state === "confirmed");
    expect(receivedRows.length).toBeGreaterThan(0);

    for (const r of upsertedRows) {
      expect(r.account_id).toBe(accountId);
      expect(typeof r.posted_at).toBe("string");
      expect(["loan_inflow", "non_loan"]).toContain(r.kind);
      expect(["confirmed", "pending", "non_loan"]).toContain(r.state);
      expect(typeof r.row_hash).toBe("string");
      expect((r.row_hash as string).startsWith(`${accountId}|bg_incoming|`)).toBe(true);
    }

    // Verify specific August 20 transactions
    const aug20Jonathan = upsertedRows.find(
      (r) =>
        r.posted_at === "2026-08-20" &&
        typeof r.description === "string" &&
        r.description.includes("JONATHAN ALFREDO APONTE"),
    );
    expect(aug20Jonathan).toBeDefined();
    expect(aug20Jonathan?.payer_name_raw).toContain("JONATHAN ALFREDO APONTE");
    expect(aug20Jonathan?.state).toBe("confirmed");
    expect(aug20Jonathan?.kind).toBe("loan_inflow");
    expect(aug20Jonathan?.code).toBe("TRANSF_ONLINE");
  });
});
