import {
  COVERAGE_CLASS,
  COVERAGE_DOT_CLASS,
  COVERAGE_LABEL,
  coverageLevelFor,
  coverageTitle,
  type CoverageLevel,
} from "@/lib/lead-coverage";

interface Props {
  /** As stored by the database. Null while a lead has no resolvable address. */
  level?: CoverageLevel | string | null;
  /** Active technicians counted for the area. */
  count?: number | null;
  /** The place it was measured against, e.g. "Dallas, TX". */
  areaLabel?: string | null;
  className?: string;
}

/**
 * The small coverage pill that sits beside a lead's other tags.
 *
 * Deliberately renders nothing rather than a placeholder when the address cannot
 * be resolved. A grey "unknown" chip on every new lead would train people to stop
 * reading it, and the only states worth interrupting someone for are the ones
 * that mean work might not get done.
 *
 * The stored level is preferred, and the count is only used to derive one when the
 * row has not been written yet, so a lead created a moment ago still shows the
 * right colour before its first update lands.
 */
export default function LeadCoverageBadge({ level, count, areaLabel, className }: Props) {
  const resolved =
    level === "good" || level === "normal" || level === "bad"
      ? level
      : coverageLevelFor(count);

  if (!resolved) return null;

  return (
    <span
      title={coverageTitle(resolved, count, areaLabel)}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${COVERAGE_CLASS[resolved]} ${className ?? ""}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${COVERAGE_DOT_CLASS[resolved]}`} aria-hidden="true" />
      {COVERAGE_LABEL[resolved]}
    </span>
  );
}