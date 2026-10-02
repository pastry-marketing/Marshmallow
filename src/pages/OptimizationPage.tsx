import { useAuth } from "@/contexts/AuthContext";

import { OptimizedAreasSection } from "@/components/optimization/OptimizedAreasSection";

/**
 * The Optimization section.
 *
 * One job only: decide which areas to push, and track what those areas have
 * done since. The technician report is deliberately not here - it lives on the
 * Technicians page, and repeating several hundred rows of it on both pages made
 * this one do two jobs badly. Good Tech is likewise decided at payment
 * approval, or on the Technicians page, and is not toggled from here.
 */
export default function OptimizationPage() {
  const { role } = useAuth();

  if (role !== "admin") {
    return (
      <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">
        Optimization is available to administrators only.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1440px] space-y-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-[-0.04em] text-foreground">Optimization</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Which areas are worth pushing more work into, and what they have done since. Areas
          can be marked here from the evidence below, or while approving a payment where the
          evidence for that job is on the same page.
        </p>
      </header>

      <OptimizedAreasSection />
    </div>
  );
}