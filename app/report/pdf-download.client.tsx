"use client";

import {
  Circle,
  Document,
  Link,
  Page,
  Path,
  pdf,
  StyleSheet,
  Svg,
  Text,
  View,
} from "@react-pdf/renderer";
import type { ReactNode } from "react";
import { reportPdfFilename } from "../../lib/report-export/markdown";
import { softWrapUrl } from "../../lib/report-export/sanitize";
import type {
  ReportEvidenceView,
  ReportFindingView,
  ReportViewModel,
} from "../../lib/report-export/types";

const colors = {
  ink: "#0c111b",
  muted: "#5f6b7a",
  faint: "#eef1f5",
  line: "#d9dee7",
  paper: "#ffffff",
  black: "#05070a",
  blue: "#4f8cff",
  green: "#22c55e",
  amber: "#f59e0b",
  orange: "#f97316",
};

const styles = StyleSheet.create({
  cover: {
    backgroundColor: colors.black,
    color: colors.paper,
    paddingTop: 58,
    paddingBottom: 48,
    paddingHorizontal: 54,
    fontFamily: "Helvetica",
  },
  coverRule: { width: 48, height: 3, backgroundColor: colors.blue, marginBottom: 26 },
  classification: {
    color: "#9fb9e9",
    fontSize: 8,
    letterSpacing: 2.2,
    fontFamily: "Helvetica-Bold",
    marginBottom: 56,
  },
  coverTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 30,
    lineHeight: 1.08,
    maxWidth: 465,
    marginBottom: 18,
  },
  coverSubject: { color: "#c6d0de", fontSize: 13, lineHeight: 1.5, maxWidth: 450 },
  coverGraph: { marginTop: 48, marginBottom: 34 },
  coverMeta: { marginTop: "auto", borderTopWidth: 0.7, borderTopColor: "#263244", paddingTop: 18 },
  coverMetaRow: { display: "flex", flexDirection: "row", marginBottom: 8 },
  coverMetaLabel: { width: 82, color: "#7f8ea3", fontSize: 7.5, letterSpacing: 0.5 },
  coverMetaValue: { flexGrow: 1, color: "#dce3ec", fontSize: 8.5, lineHeight: 1.3 },
  bodyPage: {
    backgroundColor: colors.paper,
    color: colors.ink,
    paddingTop: 55,
    paddingBottom: 48,
    paddingHorizontal: 48,
    fontFamily: "Helvetica",
    fontSize: 9,
    lineHeight: 1.45,
  },
  header: {
    position: "absolute",
    top: 22,
    left: 48,
    right: 48,
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 0.6,
    borderBottomColor: colors.line,
    paddingBottom: 7,
    color: colors.muted,
    fontSize: 6.8,
    letterSpacing: 0.45,
  },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 48,
    right: 48,
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.6,
    borderTopColor: colors.line,
    paddingTop: 7,
    color: colors.muted,
    fontSize: 6.8,
  },
  section: { marginBottom: 18 },
  sectionKicker: {
    color: colors.blue,
    fontFamily: "Helvetica-Bold",
    fontSize: 6.8,
    letterSpacing: 1.25,
    marginBottom: 4,
  },
  sectionTitle: { fontFamily: "Helvetica-Bold", fontSize: 15, lineHeight: 1.2, marginBottom: 9 },
  paragraph: { color: colors.ink, fontSize: 9, lineHeight: 1.5, marginBottom: 7 },
  muted: { color: colors.muted },
  metricGrid: { display: "flex", flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4 },
  metricCard: {
    width: "25%",
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  metricInner: { backgroundColor: "#f6f8fb", borderRadius: 3, padding: 9, minHeight: 43 },
  metricValue: { fontFamily: "Helvetica-Bold", fontSize: 12, color: colors.ink, marginBottom: 2 },
  metricLabel: { fontSize: 6.6, color: colors.muted, letterSpacing: 0.25 },
  label: { color: colors.muted, fontFamily: "Helvetica-Bold", fontSize: 6.7, letterSpacing: 0.4 },
  value: { color: colors.ink, fontSize: 8.5, marginTop: 2, lineHeight: 1.35 },
  detailRow: { display: "flex", flexDirection: "row", marginBottom: 8 },
  detailCell: { width: "50%", paddingRight: 16 },
  decision: {
    borderLeftWidth: 3,
    borderLeftColor: colors.green,
    backgroundColor: "#f4fbf6",
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 10,
  },
  decisionTitle: { fontFamily: "Helvetica-Bold", fontSize: 10, marginBottom: 3 },
  decisionText: { fontSize: 8.4, lineHeight: 1.45 },
  candidateRow: {
    display: "flex",
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: colors.line,
    paddingVertical: 7,
  },
  candidateName: { width: "30%", fontFamily: "Helvetica-Bold", fontSize: 8.2 },
  candidateState: { width: "18%", fontSize: 7.7 },
  candidateSignals: { width: "52%", color: colors.muted, fontSize: 7.3, lineHeight: 1.35 },
  findingCard: {
    borderWidth: 0.7,
    borderColor: colors.line,
    borderRadius: 4,
    padding: 12,
    marginBottom: 10,
  },
  findingTop: { display: "flex", flexDirection: "row", alignItems: "flex-start", marginBottom: 6 },
  findingIndex: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.ink,
    color: colors.paper,
    fontFamily: "Helvetica-Bold",
    fontSize: 7.5,
    textAlign: "center",
    paddingTop: 7.3,
    marginRight: 9,
  },
  findingHeading: { flexGrow: 1, fontFamily: "Helvetica-Bold", fontSize: 10.5, lineHeight: 1.25 },
  badge: {
    borderRadius: 9,
    backgroundColor: "#eaf1ff",
    color: "#2258aa",
    paddingVertical: 3,
    paddingHorizontal: 7,
    fontFamily: "Helvetica-Bold",
    fontSize: 6.5,
  },
  findingDescription: { fontSize: 8.7, lineHeight: 1.48, marginBottom: 7 },
  citationLine: { color: colors.blue, fontFamily: "Helvetica-Bold", fontSize: 7.3 },
  citationLink: { color: colors.blue, textDecoration: "underline" },
  evidenceCard: {
    borderTopWidth: 1.2,
    borderTopColor: colors.blue,
    backgroundColor: "#f8fafc",
    padding: 11,
    marginBottom: 10,
  },
  evidenceTop: { display: "flex", flexDirection: "row", alignItems: "flex-start", marginBottom: 6 },
  evidenceRef: { color: colors.blue, fontFamily: "Helvetica-Bold", fontSize: 9, width: 34 },
  evidenceTitle: { flexGrow: 1, fontFamily: "Helvetica-Bold", fontSize: 9, lineHeight: 1.3 },
  evidenceLabel: { color: colors.muted, fontFamily: "Helvetica-Bold", fontSize: 6.5, letterSpacing: 0.35 },
  evidenceClaim: { fontSize: 8.2, lineHeight: 1.45, marginTop: 3, marginBottom: 7 },
  excerpt: {
    borderLeftWidth: 2,
    borderLeftColor: colors.green,
    paddingLeft: 9,
    color: "#273348",
    fontSize: 8.1,
    lineHeight: 1.45,
    marginBottom: 8,
  },
  evidenceMeta: { fontSize: 6.9, color: colors.muted, lineHeight: 1.45, marginBottom: 4 },
  link: { color: "#2258aa", fontSize: 6.8, lineHeight: 1.35, textDecoration: "none" },
  tierRow: { display: "flex", flexDirection: "row", marginBottom: 6 },
  tierNumber: { width: 24, color: colors.amber, fontFamily: "Helvetica-Bold", fontSize: 8.5 },
  tierDetail: { flexGrow: 1, fontSize: 7.7, lineHeight: 1.4 },
  pathRow: { display: "flex", flexDirection: "row", marginBottom: 6 },
  pathStatus: { width: 96, fontFamily: "Helvetica-Bold", fontSize: 7.2 },
  pathText: { width: 380, flexShrink: 1, color: colors.muted, fontSize: 7.2, lineHeight: 1.35 },
  bullet: { display: "flex", flexDirection: "row", marginBottom: 5 },
  bulletMark: { width: 12, color: colors.orange, fontFamily: "Helvetica-Bold" },
  bulletText: { flexGrow: 1, fontSize: 8.1, lineHeight: 1.45 },
  methodologyCard: { backgroundColor: colors.ink, color: colors.paper, padding: 13, marginBottom: 8 },
  methodologyTitle: { color: "#9fb9e9", fontFamily: "Helvetica-Bold", fontSize: 7, letterSpacing: 0.5, marginBottom: 4 },
  methodologyText: { color: "#e3e8ef", fontSize: 8, lineHeight: 1.45 },
});

function human(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function safeMetadataDate(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

function Section({ index, title, children }: { index: string; title: string; children: ReactNode }) {
  return (
    <View style={styles.section} minPresenceAhead={72}>
      <Text style={styles.sectionKicker}>{index}</Text>
      <Text style={styles.sectionTitle} minPresenceAhead={42}>{title}</Text>
      {children}
    </View>
  );
}

function BodyPage({
  viewModel,
  bookmark,
  children,
}: {
  viewModel: ReportViewModel;
  bookmark: string;
  children: ReactNode;
}) {
  return (
    <Page size="LETTER" style={styles.bodyPage} wrap bookmark={bookmark}>
      <View style={styles.header} fixed>
        <Text>ATLAS / PUBLIC-SOURCE INTELLIGENCE</Text>
        <Text>{viewModel.subject}</Text>
      </View>
      <View style={styles.footer} fixed>
        <Text>{viewModel.run.id}</Text>
        <Text render={({ pageNumber, totalPages }) => `PAGE ${pageNumber} / ${totalPages}`} />
      </View>
      {children}
    </Page>
  );
}

function CoverPath({ viewModel }: { viewModel: ReportViewModel }) {
  const accepted = viewModel.searchStrategy.paths.filter((path) =>
    path.disposition === "accepted" || path.disposition === "mutation_accepted",
  ).length;
  const values = [
    ["QUERY", 0],
    [`${viewModel.searchStrategy.nodeCount} NODES`, 1],
    [`${accepted} PATHS`, 2],
    [`${viewModel.evidence.length} EVIDENCE`, 3],
    [`${viewModel.findings.length} FINDINGS`, 4],
  ] as const;
  return (
    <View style={styles.coverGraph}>
      <Svg width={476} height={44} viewBox="0 0 476 44">
        <Path d="M18 14 H458" stroke="#30425c" strokeWidth={1.4} />
        <Path d="M18 14 H348" stroke={colors.green} strokeWidth={2.2} />
        {values.map(([, index]) => (
          <Circle
            key={index}
            cx={18 + (index * 110)}
            cy={14}
            r={index === 0 ? 7 : 5}
            fill={index === 0 ? colors.blue : index < 4 ? colors.green : colors.amber}
          />
        ))}
      </Svg>
      <View style={{ display: "flex", flexDirection: "row", justifyContent: "space-between", marginTop: -11 }}>
        {values.map(([label]) => (
          <Text key={label} style={{ width: 82, color: "#8190a5", fontSize: 5.8, letterSpacing: 0.3 }}>{label}</Text>
        ))}
      </View>
    </View>
  );
}

function FindingCard({ finding, index }: { finding: ReportFindingView; index: number }) {
  return (
    <View style={styles.findingCard} wrap={false}>
      <View style={styles.findingTop}>
        <Text style={styles.findingIndex}>{String(index + 1).padStart(2, "0")}</Text>
        <Text style={styles.findingHeading}>{finding.title}</Text>
        <Text style={styles.badge}>{human(finding.confidenceLabel)} {percent(finding.confidenceScore)}</Text>
      </View>
      <Text style={styles.findingDescription}>{finding.description}</Text>
      <Text style={styles.citationLine}>Sources: {finding.sources.length > 0
        ? finding.sources.map((source, sourceIndex) => (
            <Text key={`${source.url}-${sourceIndex}`}>
              {sourceIndex > 0 ? ", " : ""}
              <Link src={source.url} style={styles.citationLink}>{source.domain}</Link>
            </Text>
          ))
        : "None"}</Text>
      {finding.caveats.map((caveat) => (
        <View key={caveat} style={[styles.bullet, { marginTop: 5 }]}>
          <Text style={styles.bulletMark}>!</Text>
          <Text style={styles.bulletText}>{caveat}</Text>
        </View>
      ))}
    </View>
  );
}

function EvidenceCard({ evidence }: { evidence: ReportEvidenceView }) {
  const title = evidence.title ?? evidence.sourceFamily;
  return (
    <View style={styles.evidenceCard} wrap={false}>
      <View style={styles.evidenceTop}>
        <Text style={styles.evidenceRef}>{evidence.ref}</Text>
        <Text style={styles.evidenceTitle}>{title}</Text>
        <Text style={styles.badge}>TIER {evidence.sourceTier}</Text>
      </View>
      <Text style={styles.evidenceLabel}>{evidence.contentLabel.toLocaleUpperCase("en-US")}</Text>
      <Text style={styles.evidenceClaim}>{evidence.claim}</Text>
      {evidence.exactExcerpt !== null ? <Text style={styles.excerpt}>{`"${evidence.exactExcerpt}"`}</Text> : null}
      <Text style={styles.evidenceMeta}>
        {evidence.sourceFamily} / {human(evidence.sourceType)} / {human(evidence.verificationMethod)} / {human(evidence.temporalStatus)}
      </Text>
      <Text style={styles.evidenceMeta}>
        Retrieved {evidence.retrievedAt} / Observed {evidence.observedAt ?? "not supplied"} / Hash {evidence.contentHash ?? "not supplied"}
      </Text>
      {evidence.sourceUrl ? (
        <Link src={evidence.sourceUrl} style={styles.link}>{softWrapUrl(evidence.sourceUrl)}</Link>
      ) : <Text style={styles.evidenceMeta}>Source URL unavailable</Text>}
    </View>
  );
}

function ReportDocument({ viewModel }: { viewModel: ReportViewModel }) {
  const selected = viewModel.identity.selected;
  const created = safeMetadataDate(viewModel.run.generatedAt);
  const statusCounts = viewModel.searchStrategy.nodeStatusCounts
    .map((item) => `${human(item.label)} ${item.count}`)
    .join(" / ") || "No canonical graph statistics";
  const frontierCounts = viewModel.searchStrategy.frontierCounts
    .map((item) => `${human(item.label)} ${item.count}`)
    .join(" / ") || "No frontier entries";
  return (
    <Document
      title={viewModel.title}
      author="Atlas People Intelligence"
      subject={`Public-source professional intelligence for ${viewModel.subject}`}
      creator="Atlas"
      producer="Atlas / @react-pdf/renderer"
      keywords="public-source intelligence, evidence, provenance, identity resolution"
      language="en-US"
      creationDate={created}
      modificationDate={created}
      pageMode="useOutlines"
      pageLayout="singlePage"
    >
      <Page size="LETTER" style={styles.cover} bookmark="Cover">
        <View style={styles.coverRule} />
        <Text style={styles.classification}>{viewModel.classification}</Text>
        <Text style={styles.coverTitle}>Atlas intelligence report</Text>
        <Text style={styles.coverSubject}>{viewModel.subject}</Text>
        <CoverPath viewModel={viewModel} />
        <Text style={{ color: "#dce3ec", fontSize: 11, lineHeight: 1.55, maxWidth: 460 }}>
          {viewModel.executiveSummary}
        </Text>
        <View style={styles.coverMeta}>
          <View style={styles.coverMetaRow}><Text style={styles.coverMetaLabel}>QUERY</Text><Text style={styles.coverMetaValue}>{viewModel.run.query}</Text></View>
          <View style={styles.coverMetaRow}><Text style={styles.coverMetaLabel}>RUN</Text><Text style={styles.coverMetaValue}>{viewModel.run.id}</Text></View>
          <View style={styles.coverMetaRow}><Text style={styles.coverMetaLabel}>SCOPE</Text><Text style={styles.coverMetaValue}>{viewModel.run.scope}</Text></View>
          <View style={styles.coverMetaRow}><Text style={styles.coverMetaLabel}>GENERATED</Text><Text style={styles.coverMetaValue}>{viewModel.run.generatedAt}</Text></View>
        </View>
      </Page>

      <BodyPage viewModel={viewModel} bookmark="Assessment">
        <Section index="01 / ASSESSMENT" title="Executive summary">
          <View style={styles.metricGrid}>
            <View style={styles.metricCard} wrap={false}><View style={styles.metricInner}><Text style={styles.metricValue}>{human(viewModel.identity.status)}</Text><Text style={styles.metricLabel}>IDENTITY</Text></View></View>
            <View style={styles.metricCard} wrap={false}><View style={styles.metricInner}><Text style={styles.metricValue}>{viewModel.findings.length}</Text><Text style={styles.metricLabel}>FINDINGS</Text></View></View>
            <View style={styles.metricCard} wrap={false}><View style={styles.metricInner}><Text style={styles.metricValue}>{viewModel.evidence.length}</Text><Text style={styles.metricLabel}>EVIDENCE</Text></View></View>
            <View style={styles.metricCard} wrap={false}><View style={styles.metricInner}><Text style={styles.metricValue}>{percent(viewModel.coverage.score)}</Text><Text style={styles.metricLabel}>COVERAGE</Text></View></View>
          </View>
          <Text style={styles.paragraph}>{viewModel.executiveSummary}</Text>
          <View style={styles.detailRow}>
            <View style={styles.detailCell}><Text style={styles.label}>STATUS</Text><Text style={styles.value}>{human(viewModel.run.status)}</Text></View>
            <View style={styles.detailCell}><Text style={styles.label}>STOP REASON</Text><Text style={styles.value}>{human(viewModel.run.stopReason)}</Text></View>
          </View>
        </Section>

        <Section index="02 / IDENTITY" title="Identity resolution">
          <View style={styles.decision}>
            <Text style={styles.decisionTitle}>{selected ? `${selected.name} / ${human(selected.status)} / ${percent(selected.score)}` : "No selected candidate"}</Text>
            <Text style={styles.decisionText}>{viewModel.identity.rationale}</Text>
          </View>
          <Text style={[styles.paragraph, styles.muted]}>
            Runner-up margin {percent(viewModel.identity.runnerUpMargin)} / required margin {percent(viewModel.identity.marginThreshold)} / resolution threshold {percent(viewModel.identity.resolutionThreshold)}
          </Text>
          {viewModel.identity.alternatives.length > 0 ? (
            <View>
              <Text style={[styles.label, { marginBottom: 3 }]}>RETAINED ALTERNATIVES</Text>
              {viewModel.identity.alternatives.map((candidate) => (
                <View key={candidate.id} style={styles.candidateRow} wrap={false}>
                  <Text style={styles.candidateName}>{candidate.name}</Text>
                  <Text style={styles.candidateState}>{human(candidate.status)} / {percent(candidate.score)}</Text>
                  <Text style={styles.candidateSignals}>Matched {candidate.matchedSignals.join(", ") || "none"}; conflicts {candidate.conflictingSignals.join(", ") || "none"}</Text>
                </View>
              ))}
            </View>
          ) : <Text style={styles.paragraph}>No alternative candidate was retained.</Text>}
        </Section>

        <Section index="03 / FINDINGS" title="Evidence-backed findings">
          {viewModel.findings.length > 0
            ? viewModel.findings.map((finding, index) => <FindingCard key={finding.id} finding={finding} index={index} />)
            : <Text style={styles.paragraph}>No finding met the admission and confidence rules.</Text>}
        </Section>
      </BodyPage>

      <BodyPage viewModel={viewModel} bookmark="Evidence ledger">
        <Section index="04 / SOURCES" title="Evidence and source ledger">
          <Text style={[styles.paragraph, styles.muted]}>Stable E-references distinguish exact excerpts from structured API claims. Links remain live; raw provider payloads are excluded.</Text>
          {viewModel.evidence.length > 0
            ? viewModel.evidence.map((evidence) => <EvidenceCard key={evidence.id} evidence={evidence} />)
            : <Text style={styles.paragraph}>No evidence was admitted.</Text>}
        </Section>
      </BodyPage>

      <BodyPage viewModel={viewModel} bookmark="Search strategy">
        <Section index="05 / SEARCH" title="Search strategy and retained paths">
          <Text style={styles.paragraph}>{viewModel.searchStrategy.narrative}</Text>
          <View style={styles.metricGrid}>
            <View style={styles.metricCard} wrap={false}><View style={styles.metricInner}><Text style={styles.metricValue}>{viewModel.searchStrategy.nodeCount}</Text><Text style={styles.metricLabel}>GRAPH NODES</Text></View></View>
            <View style={styles.metricCard} wrap={false}><View style={styles.metricInner}><Text style={styles.metricValue}>{viewModel.searchStrategy.edgeCount}</Text><Text style={styles.metricLabel}>GRAPH EDGES</Text></View></View>
            <View style={styles.metricCard} wrap={false}><View style={styles.metricInner}><Text style={styles.metricValue}>{viewModel.searchStrategy.mutation.accepted}</Text><Text style={styles.metricLabel}>MUTATIONS ACCEPTED</Text></View></View>
            <View style={styles.metricCard} wrap={false}><View style={styles.metricInner}><Text style={styles.metricValue}>{viewModel.searchStrategy.mutation.rejected}</Text><Text style={styles.metricLabel}>MUTATIONS REJECTED</Text></View></View>
          </View>
          <Text style={[styles.paragraph, styles.muted]}>Graph nodes: {statusCounts}</Text>
          <Text style={[styles.paragraph, styles.muted]}>Frontier entries: {frontierCounts}</Text>
          <Text style={[styles.label, { marginBottom: 6 }]}>SOURCE LADDER</Text>
          {viewModel.searchStrategy.sourceLadder.map((tier) => (
            <View key={tier.tier} style={styles.tierRow} wrap={false}>
              <Text style={styles.tierNumber}>T{tier.tier}</Text>
              <Text style={styles.tierDetail}>{tier.label} / {tier.frontierCount} frontier entries / {tier.verifiedCount} verified / {tier.rejectedCount} rejected / {tier.exhaustedCount} exhausted / {tier.evidenceCount} admitted / {tier.sourceFamilies.join(", ") || "no source family"}</Text>
            </View>
          ))}
          <Text style={[styles.label, { marginTop: 6, marginBottom: 6 }]}>ACCEPTED, REJECTED, AND MUTATION PATHS</Text>
          {viewModel.searchStrategy.paths.length > 0 ? viewModel.searchStrategy.paths.map((path) => (
            <View key={path.id} style={styles.pathRow} wrap={false}>
              <Text style={[styles.pathStatus, { color: path.disposition.includes("rejected") ? colors.orange : colors.green }]}>{human(path.disposition)}</Text>
              <Text style={styles.pathText}>{path.path.join(" -> ")}{path.cost === null ? "" : ` / cost ${path.cost.toFixed(3)}`}</Text>
            </View>
          )) : <Text style={styles.paragraph}>No canonical path summary was available.</Text>}
        </Section>

        <Section index="06 / LIMITS" title="Coverage gaps and limitations">
          {[...viewModel.coverage.gaps, ...viewModel.limitations].map((item) => (
            <View key={item} style={styles.bullet}><Text style={styles.bulletMark}>-</Text><Text style={styles.bulletText}>{item}</Text></View>
          ))}
          {viewModel.coverage.gaps.length + viewModel.limitations.length === 0
            ? <Text style={styles.paragraph}>No additional limitation was recorded.</Text>
            : null}
        </Section>
      </BodyPage>

      <BodyPage viewModel={viewModel} bookmark="Execution and methodology">
        <Section index="07 / EXECUTION" title="Usage, latency, and stopping">
          <View style={styles.metricGrid}>
            {viewModel.execution.usage.map((metric) => (
              <View key={metric.label} style={styles.metricCard} wrap={false}><View style={styles.metricInner}><Text style={styles.metricValue}>{metric.value}</Text><Text style={styles.metricLabel}>{metric.label.toLocaleUpperCase("en-US")}</Text></View></View>
            ))}
          </View>
          <Text style={styles.label}>STOP DETAIL</Text>
          <Text style={styles.value}>{viewModel.execution.stopDetail}</Text>
        </Section>

        <Section index="08 / METHOD" title="Methodology and safety">
          {[
            ["EVIDENCE STANDARD", viewModel.methodology.evidenceStandard],
            ["CONFIDENCE STANDARD", viewModel.methodology.confidenceStandard],
            ["GRAPH STANDARD", viewModel.methodology.graphStandard],
            ["SAFETY NOTE", viewModel.methodology.safetyNote],
          ].map(([title, text]) => (
            <View key={title} style={styles.methodologyCard} wrap={false}>
              <Text style={styles.methodologyTitle}>{title}</Text>
              <Text style={styles.methodologyText}>{text}</Text>
            </View>
          ))}
        </Section>
      </BodyPage>
    </Document>
  );
}

export async function renderReportPdfBlob(
  viewModel: ReportViewModel,
): Promise<{ blob: Blob; filename: string }> {
  const rendered = await pdf(<ReportDocument viewModel={viewModel} />).toBlob();
  const blob = rendered.type === "application/pdf"
    ? rendered
    : new Blob([await rendered.arrayBuffer()], { type: "application/pdf" });
  return { blob, filename: reportPdfFilename(viewModel) };
}

export async function renderReportPdfBytes(viewModel: ReportViewModel): Promise<Uint8Array> {
  const { blob } = await renderReportPdfBlob(viewModel);
  return new Uint8Array(await blob.arrayBuffer());
}
