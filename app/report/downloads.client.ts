"use client";

import { reportMarkdownFilename, reportViewModelToMarkdown, type ReportViewModel } from "../../lib/report-export";

function saveBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined") throw new Error("Report downloads require a browser.");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadReportMarkdown(viewModel: ReportViewModel): void {
  const markdown = reportViewModelToMarkdown(viewModel);
  saveBlob(new Blob([markdown], { type: "text/markdown;charset=utf-8" }), reportMarkdownFilename(viewModel));
}

/**
 * The browser requests React-PDF/Yoga only from this click-time function.
 * vite.config.ts replaces this boundary with a fail-closed SSR stub, keeping
 * the renderer out of the Worker module graph.
 */
export async function downloadReportPdf(viewModel: ReportViewModel): Promise<void> {
  const pdfModule = await import("./pdf-download.client");
  const { blob, filename } = await pdfModule.renderReportPdfBlob(viewModel);
  saveBlob(blob, filename);
}
