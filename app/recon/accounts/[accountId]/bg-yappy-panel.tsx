"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Clock,
  Smartphone,
  AlertTriangle,
  ListFilter,
  Layers,
  Search,
  X,
  Download,
  Calendar,
  ArrowRight,
} from "lucide-react";

import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { formatMinorUSD } from "@/lib/recon/format";
import { toSpanishBatchStatus, toSpanishYappyStatus } from "@/lib/recon/bg/formatters";

export interface BgYappyBatchView {
  uid: string;
  creditDate: string;
  transactionDate: string | null;
  declaredCount: number;
  reportCount: number | null;
  creditAmountMinor: bigint;
  reportAmountMinor: bigint | null;
  feeAmountMinor: bigint | null;
  feeRate: number | null;
  status: "settled" | "pending" | "anomaly";
  pendingReason: string | null;
}

export interface BgYappyLineView {
  uid: string;
  postedDate: string;
  postedTime: string;
  reference: string;
  clientName: string;
  phoneNumber: string;
  comment: string;
  amountMinor: bigint;
  bankStatus: string;
  status: "received" | "pending" | "in_transit" | "anomaly" | "other";
  settlementBatchUid: string | null;
  settlementDate: string | null;
}

interface Props {
  accountId?: string;
  batches: BgYappyBatchView[];
  lines?: BgYappyLineView[];
}

export function BgYappyPanel({ accountId, batches, lines = [] }: Props) {
  const [activeTab, setActiveTab] = useState<"batches" | "lines">("batches");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const settledBatchesCount = batches.filter((b) => b.status === "settled").length;
  const receivedLinesCount = lines.filter((l) => l.status === "received").length;
  const inTransitLinesCount = lines.filter((l) => l.status === "in_transit").length;
  const pendingLinesCount = lines.filter((l) => l.status === "pending").length;

  // List of distinct dates present in lines, sorted descending
  const availableDates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of lines) {
      if (l.postedDate) {
        counts.set(l.postedDate, (counts.get(l.postedDate) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, count]) => ({ date, count }));
  }, [lines]);

  const filteredLines = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return lines.filter((l) => {
      if (statusFilter !== "all" && l.status !== statusFilter) return false;
      if (selectedDate && l.postedDate !== selectedDate) return false;
      if (query) {
        const matchesClient = (l.clientName || "").toLowerCase().includes(query);
        const matchesPhone = (l.phoneNumber || "").toLowerCase().includes(query);
        const matchesRef = (l.reference || "").toLowerCase().includes(query);
        const matchesComment = (l.comment || "").toLowerCase().includes(query);
        if (!matchesClient && !matchesPhone && !matchesRef && !matchesComment) {
          return false;
        }
      }
      return true;
    });
  }, [lines, statusFilter, selectedDate, searchQuery]);

  const totalFilteredAmountMinor = useMemo(() => {
    return filteredLines.reduce((sum, l) => sum + l.amountMinor, 0n);
  }, [filteredLines]);

  function handleFilterByBatch(batch: BgYappyBatchView) {
    if (batch.transactionDate) {
      setSelectedDate(batch.transactionDate);
    } else {
      const d = new Date(`${batch.creditDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      setSelectedDate(d.toISOString().slice(0, 10));
    }
    setStatusFilter("all");
    setSearchQuery("");
    setActiveTab("lines");
  }

  const exportUrl = useMemo(() => {
    if (!accountId) return null;
    const params = new URLSearchParams();
    if (selectedDate) params.set("date", selectedDate);
    if (statusFilter !== "all") params.set("status", statusFilter);
    return `/recon/accounts/${accountId}/export/yappy?${params.toString()}`;
  }, [accountId, selectedDate, statusFilter]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Smartphone className="h-5 w-5 text-indigo-500" />
              <CardTitle>Liquidaciones Yappy T+1</CardTitle>
            </div>
            <CardDescription className="mt-1">
              Depósitos consolidados de Yappy conciliados contra el reporte diario de transacciones (T+1 incluyendo fines de semana).
            </CardDescription>
          </div>

          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-xs font-medium">
              <button
                type="button"
                onClick={() => setActiveTab("batches")}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors ${
                  activeTab === "batches"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                <span>Lotes ({settledBatchesCount}/{batches.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("lines")}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors ${
                  activeTab === "lines"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <ListFilter className="h-3.5 w-3.5" />
                <span>Transacciones ({lines.length})</span>
              </button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardBody>
        {activeTab === "batches" ? (
          batches.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No hay depósitos Yappy registrados.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2.5 px-3 font-medium">Fecha Crédito</th>
                    <th className="py-2.5 px-3 font-medium">Fecha Pagos (T-1)</th>
                    <th className="py-2.5 px-3 font-medium text-center">Transacciones</th>
                    <th className="py-2.5 px-3 font-medium text-right">Depósito Neto</th>
                    <th className="py-2.5 px-3 font-medium text-right">Comisión Banco</th>
                    <th className="py-2.5 px-3 font-medium text-center">Estado</th>
                    <th className="py-2.5 px-3 font-medium">Observación</th>
                    <th className="py-2.5 px-3 font-medium text-center">Acción</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {batches.map((batch) => {
                    const isSettled = batch.status === "settled";
                    const isPending = batch.status === "pending";
                    const isAnomaly = batch.status === "anomaly";

                    return (
                      <tr key={batch.uid} className="hover:bg-muted/20">
                        <td className="py-3 px-3 font-mono text-xs font-medium whitespace-nowrap">
                          {batch.creditDate}
                        </td>
                        <td className="py-3 px-3 font-mono text-xs text-muted-foreground whitespace-nowrap">
                          {batch.transactionDate || "—"}
                        </td>
                        <td className="py-3 px-3 text-center text-xs whitespace-nowrap">
                          {batch.reportCount != null ? (
                            <span>
                              {batch.reportCount} <span className="text-muted-foreground">/ {batch.declaredCount}</span>
                            </span>
                          ) : (
                            <span>{batch.declaredCount}</span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-semibold whitespace-nowrap">
                          {formatMinorUSD(batch.creditAmountMinor)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-xs text-muted-foreground whitespace-nowrap">
                          {batch.feeAmountMinor != null ? formatMinorUSD(batch.feeAmountMinor) : "—"}
                        </td>
                        <td className="py-3 px-3 text-center whitespace-nowrap">
                          {isSettled && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                              <CheckCircle2 className="h-3 w-3" />
                              {toSpanishBatchStatus(batch.status)}
                            </span>
                          )}
                          {isPending && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                              <Clock className="h-3 w-3" />
                              {toSpanishBatchStatus(batch.status)}
                            </span>
                          )}
                          {isAnomaly && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">
                              <AlertTriangle className="h-3 w-3" />
                              {toSpanishBatchStatus(batch.status)}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-xs text-muted-foreground max-w-xs truncate">
                          {batch.pendingReason || "Liquidada al centavo con reporte Yappy"}
                        </td>
                        <td className="py-3 px-3 text-center whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => handleFilterByBatch(batch)}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-sm hover:bg-muted/50 transition-colors"
                            title="Ver pagos individuales de este día"
                          >
                            <span>Ver detalle</span>
                            <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <div className="space-y-4">
            {/* Filters bar */}
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Status Pills */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setStatusFilter("all")}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                      statusFilter === "all"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Todas ({lines.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("received")}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                      statusFilter === "received"
                        ? "bg-emerald-600 text-white"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Confirmadas ({receivedLinesCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("pending")}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                      statusFilter === "pending"
                        ? "bg-amber-600 text-white"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Pendientes ({pendingLinesCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("in_transit")}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                      statusFilter === "in_transit"
                        ? "bg-blue-600 text-white"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    En tránsito ({inTransitLinesCount})
                  </button>
                </div>

                {/* Export button */}
                {exportUrl && (
                  <a
                    href={exportUrl}
                    className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 transition-colors ml-auto"
                    title="Exportar transacciones filtradas a Excel"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Exportar Excel</span>
                  </a>
                )}
              </div>

              {/* Date & Search Inputs */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                {/* Date dropdown */}
                <div className="relative flex items-center min-w-[220px]">
                  <Calendar className="absolute left-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <select
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="">Todas las fechas ({lines.length} pagos)</option>
                    {selectedDate && !availableDates.some((d) => d.date === selectedDate) && (
                      <option value={selectedDate}>{selectedDate} (0 pagos)</option>
                    )}
                    {availableDates.map(({ date, count }) => (
                      <option key={date} value={date}>
                        {date} ({count} pagos)
                      </option>
                    ))}
                  </select>
                  {selectedDate && (
                    <button
                      type="button"
                      onClick={() => setSelectedDate("")}
                      className="absolute right-2 text-muted-foreground hover:text-foreground"
                      title="Limpiar fecha"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Search box */}
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Buscar cliente, celular, referencia o comentario..."
                    className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery("")}
                      className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                      title="Limpiar búsqueda"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Metrics Summary Strip */}
              <div className="flex flex-wrap items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border/50">
                <div className="flex items-center gap-2">
                  <span>
                    Mostrando <strong className="text-foreground">{filteredLines.length}</strong> transacciones
                  </span>
                  <span>·</span>
                  <span>
                    Monto total: <strong className="font-mono text-foreground">{formatMinorUSD(totalFilteredAmountMinor)}</strong>
                  </span>
                </div>
                {(selectedDate || searchQuery || statusFilter !== "all") && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedDate("");
                      setSearchQuery("");
                      setStatusFilter("all");
                    }}
                    className="text-primary hover:underline text-[11px]"
                  >
                    Restablecer filtros
                  </button>
                )}
              </div>
            </div>

            {lines.length === 0 ? (
              <div className="py-8 text-center space-y-2">
                <p className="text-sm font-medium text-foreground">
                  No hay transacciones individuales de Yappy registradas todavía.
                </p>
                <p className="text-xs text-muted-foreground max-w-md mx-auto">
                  Para ver el desglose detallado de pagos por cliente, sube el reporte de Yappy (.xlsx) en la sección de <strong className="text-foreground">Cargar Archivos</strong>.
                </p>
              </div>
            ) : filteredLines.length === 0 ? (
              <div className="py-8 text-center space-y-2">
                <p className="text-sm text-muted-foreground">
                  No se encontraron transacciones con los filtros aplicados.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedDate("");
                    setSearchQuery("");
                    setStatusFilter("all");
                  }}
                  className="text-xs text-primary hover:underline font-medium"
                >
                  Restablecer filtros
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="py-2.5 px-3 font-medium">Fecha / Hora</th>
                      <th className="py-2.5 px-3 font-medium">Referencia</th>
                      <th className="py-2.5 px-3 font-medium">Cliente / Celular</th>
                      <th className="py-2.5 px-3 font-medium">Comentario</th>
                      <th className="py-2.5 px-3 font-medium text-right">Monto</th>
                      <th className="py-2.5 px-3 font-medium text-center">Estado Banco</th>
                      <th className="py-2.5 px-3 font-medium text-center">Conciliación</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredLines.map((line) => {
                      const isReceived = line.status === "received";
                      const isPending = line.status === "pending";
                      const isInTransit = line.status === "in_transit";
                      const isAnomaly = line.status === "anomaly";

                      return (
                        <tr key={line.uid} className="hover:bg-muted/20">
                          <td className="py-2.5 px-3 font-mono text-xs whitespace-nowrap">
                            <div>{line.postedDate}</div>
                            {line.postedTime && (
                              <div className="text-[11px] text-muted-foreground">{line.postedTime}</div>
                            )}
                          </td>
                          <td className="py-2.5 px-3 font-mono text-xs whitespace-nowrap">
                            {line.reference}
                          </td>
                          <td className="py-2.5 px-3 max-w-xs">
                            <div className="font-medium text-xs truncate">{line.clientName || "—"}</div>
                            {line.phoneNumber && (
                              <div className="text-[11px] text-muted-foreground font-mono">{line.phoneNumber}</div>
                            )}
                          </td>
                          <td className="py-2.5 px-3 max-w-[200px] text-xs text-muted-foreground truncate">
                            {line.comment || "—"}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-semibold text-xs whitespace-nowrap">
                            {formatMinorUSD(line.amountMinor)}
                          </td>
                          <td className="py-2.5 px-3 text-center text-xs whitespace-nowrap">
                            <span className="rounded bg-muted px-1.5 py-0.5 font-medium">
                              {line.bankStatus}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-center whitespace-nowrap">
                            {isReceived && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 className="h-3 w-3" />
                                {toSpanishYappyStatus(line.status)}
                                {line.settlementDate && (
                                  <span className="text-[10px] text-emerald-700 dark:text-emerald-300 ml-0.5">
                                    ({line.settlementDate})
                                  </span>
                                )}
                              </span>
                            )}
                            {isPending && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                                <Clock className="h-3 w-3" />
                                {toSpanishYappyStatus(line.status)}
                              </span>
                            )}
                            {isInTransit && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-semibold text-blue-600 dark:text-blue-400">
                                <Clock className="h-3 w-3" />
                                {toSpanishYappyStatus(line.status)}
                              </span>
                            )}
                            {isAnomaly && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">
                                <AlertTriangle className="h-3 w-3" />
                                {toSpanishYappyStatus(line.status)}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
