type Evidence = { label?: string; quote?: string; source?: string };

/** A verbatim quote alone does not establish the meaning of a serious label. */
export function supportsTechnicianLabel(label: string, evidence: Evidence[]): boolean {
  const quotes = evidence.filter((item) => item.label === label && item.source === "Technician / contact")
    .map((item) => item.quote ?? "");

  if (label === "late_payment") {
    // A request for a refund, an agent asking for their share, or a technician
    // saying they already transferred money cannot prove an overdue debt.
    return quotes.some((quote) =>
      /\b(?:i owe (?:you|your (?:company|business|team))|i(?:'|’)m (?:late|behind) on (?:the |my )?payment|my payment is overdue|i (?:have not|haven(?:'|’)t) paid (?:you|your (?:company|business|team)))\b/i.test(quote)
      && !/\b(?:refund|return|money back|transferred|already sent)\b/i.test(quote)
    );
  }

  if (label === "dont_cooperate") {
    return quotes.some((quote) =>
      /\b(?:i (?:will not|won(?:'|’)t|refuse to) (?:do|complete|finish|help with) (?:the|this|your) (?:job|work|project)|i refuse to cooperate)\b/i.test(quote)
      && !/\b(?:out of (?:my|our) (?:service )?area|do not do|don(?:'|’)t do|not (?:our|my) service|plumbing company|refund|money back|return)\b/i.test(quote)
    );
  }

  if (label === "tech_is_scammer") {
    // Someone accusing the technician of a scam is not an admission by them.
    return quotes.some((quote) => /\b(?:i scammed|i (?:stole|defrauded)|i lied about (?:the|that) (?:job|payment))\b/i.test(quote));
  }

  if (label === "good_tech") {
    return evidence.some((item) => item.label === label && /\b(?:great job|excellent work|good work|customer (?:was|is) happy|well done)\b/i.test(item.quote ?? ""));
  }

  return evidence.some((item) => item.label === label);
}
