export type CompletedLead = { tech_number: string | null; status: string };

export type TechnicianJobCounts = {
  completed: number | null;
  paid: number | null;
  error: string | null;
};

/** US numbers are stored with mixed punctuation and sometimes a leading 1. */
export function technicianPhoneKey(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}

export function technicianJobCounts(phone: string | null, leads: CompletedLead[]): TechnicianJobCounts {
  const key = technicianPhoneKey(phone);
  if (!key) return { completed: null, paid: null, error: "No valid technician phone number is available to match leads." };
  const matches = leads.filter((lead) => technicianPhoneKey(lead.tech_number) === key);
  return {
    completed: matches.length,
    paid: matches.filter((lead) => lead.status === "paid").length,
    error: null,
  };
}
