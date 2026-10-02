import { useAuth } from "@/contexts/AuthContext";

import { TechnicianPerformance } from "@/components/technicians/TechnicianPerformance";
import { OptimizedAreasSection } from "@/components/optimization/OptimizedAreasSection";

/**
 * The Optimization section.
 *
 * Two parts, in the order a decision gets made: the areas you have already
 * marked as worth optimising and how they have performed since, then the
 * technician and area performance underneath it that tells you where the next
 * one should go.
 *
 * The performance body is the same component the Technicians page renders for
 * its Tech Report tab. They are one report reached two ways, so they are one
 * implementation - a second copy would eventually report different numbers for
 * the same technician.
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
          Where jobs close, which technicians close them, and which areas are worth pushing
          more work into. Areas are marked from the payment approval screen, where the
          evidence for the decision is on the same page.
        </p>
      </header>

      <OptimizedAreasSection />

      <TechnicianPerformance />
    </div>
  );
}