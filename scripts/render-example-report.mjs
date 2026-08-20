import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const exampleId = process.argv[2] ?? "chris-anderson-ted";
if (!/^[a-z0-9-]+$/.test(exampleId)) {
  throw new TypeError("Example ID must contain only lowercase letters, numbers, and hyphens.");
}

const report = JSON.parse(
  await readFile(path.join(projectRoot, "examples", exampleId, "output.json"), "utf8"),
);
const vite = await createServer({
  root: projectRoot,
  configFile: false,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const [reportExport, pdfRenderer] = await Promise.all([
    vite.ssrLoadModule("/lib/report-export/index.ts"),
    vite.ssrLoadModule("/app/report/pdf-download.client.tsx"),
  ]);
  const viewModel = reportExport.createReportViewModel(report);
  const markdown = reportExport.reportViewModelToMarkdown(viewModel);
  const markdownFilename = reportExport.reportMarkdownFilename(viewModel);
  const { blob, filename } = await pdfRenderer.renderReportPdfBlob(viewModel);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (blob.type !== "application/pdf" || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new TypeError("React-PDF did not produce a valid PDF payload.");
  }

  const pdfDirectory = path.join(projectRoot, "output", "pdf");
  const markdownDirectory = path.join(projectRoot, "output", "markdown");
  await Promise.all([
    mkdir(pdfDirectory, { recursive: true }),
    mkdir(markdownDirectory, { recursive: true }),
  ]);
  const pdfPath = path.join(pdfDirectory, filename);
  const markdownPath = path.join(markdownDirectory, markdownFilename);
  await Promise.all([
    writeFile(pdfPath, bytes),
    writeFile(markdownPath, markdown, "utf8"),
  ]);
  process.stdout.write(`${JSON.stringify({
    exampleId,
    pdfPath,
    pdfBytes: bytes.byteLength,
    markdownPath,
    markdownBytes: Buffer.byteLength(markdown),
  })}\n`);
} finally {
  await vite.close();
}
