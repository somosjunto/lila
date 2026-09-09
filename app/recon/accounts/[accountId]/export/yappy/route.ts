import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

import { requireReconWriter } from "@/lib/auth/guard";
import { toSpanishYappyStatus } from "@/lib/recon/bg/formatters";
import type { BgYappyStatus } from "@/lib/recon/bg/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  await requireReconWriter();
  const { accountId } = await params;
  const url = new URL(request.url);

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const date = url.searchParams.get("date");
  const YAPPY_STATUSES = ["received", "pending", "in_transit", "anomaly", "other"] as const;
  type YappyStatusFilter = (typeof YAPPY_STATUSES)[number];

  const statusParam = url.searchParams.get("status") ?? "all";
  const statusFilter: YappyStatusFilter | "all" = (YAPPY_STATUSES as readonly string[]).includes(statusParam)
    ? (statusParam as YappyStatusFilter)
    : "all";

  const supabase = await createSupabaseServerClient();

  const { data: account, error: acctErr } = await supabase
    .from("bank_accounts")
    .select("id, rail, account_number, holder_name, currency")
    .eq("id", accountId)
    .single();

  if (acctErr || !account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  type YappyRow = {
    posted_date: string;
    posted_time: string | null;
    reference: string;
    client_name: string | null;
    phone_number: string | null;
    comment: string | null;
    amount_minor: string | number | bigint;
    bank_status: string;
    status: string;
    settlement_batch_uid: string | null;
    settlement_date: string | null;
  };

  const PAGE = 1000;
  const SAFETY_CAP = 200_000;
  const lines: YappyRow[] = [];
  let cursor = 0;

  while (cursor < SAFETY_CAP) {
    let q = supabase
      .from("recon_bg_yappy_lines")
      .select(
        "posted_date, posted_time, reference, client_name, phone_number, comment, amount_minor, bank_status, status, settlement_batch_uid, settlement_date",
      )
      .eq("account_id", accountId)
      .eq("is_active", true)
      .order("posted_date", { ascending: false })
      .order("line_uid", { ascending: false })
      .range(cursor, cursor + PAGE - 1);

    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      q = q.eq("posted_date", date);
    } else {
      if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) q = q.gte("posted_date", from);
      if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) q = q.lte("posted_date", to);
    }

    if (statusFilter !== "all") {
      q = q.eq("status", statusFilter);
    }

    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) break;

    lines.push(...(data as unknown as YappyRow[]));
    if (data.length < PAGE) break;
    cursor += PAGE;
  }

  const sheetData = lines.map((r) => {
    const amountNum = Number(r.amount_minor) / 100;
    return {
      Fecha: r.posted_date,
      Hora: r.posted_time || "",
      Referencia: r.reference,
      Cliente: r.client_name || "",
      Celular: r.phone_number || "",
      Comentario: r.comment || "",
      Monto: amountNum,
      "Estado Banco": r.bank_status,
      Conciliación: toSpanishYappyStatus(r.status as BgYappyStatus),
      "Fecha Liquidación": r.settlement_date || "",
      "Lote / Batch": r.settlement_batch_uid || "",
    };
  });

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(sheetData, {
    header: [
      "Fecha",
      "Hora",
      "Referencia",
      "Cliente",
      "Celular",
      "Comentario",
      "Monto",
      "Estado Banco",
      "Conciliación",
      "Fecha Liquidación",
      "Lote / Batch",
    ],
  });

  worksheet["!cols"] = [
    { wch: 12 }, // Fecha
    { wch: 10 }, // Hora
    { wch: 22 }, // Referencia
    { wch: 30 }, // Cliente
    { wch: 14 }, // Celular
    { wch: 28 }, // Comentario
    { wch: 12 }, // Monto
    { wch: 14 }, // Estado Banco
    { wch: 14 }, // Conciliación
    { wch: 16 }, // Fecha Liquidación
    { wch: 20 }, // Lote
  ];

  XLSX.utils.book_append_sheet(workbook, worksheet, "Transacciones Yappy");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const stamp = date || (from ? `${from}_a_${to || "hoy"}` : new Date().toISOString().slice(0, 10));
  const filename = `yappy-transacciones-${account.account_number}-${stamp}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
