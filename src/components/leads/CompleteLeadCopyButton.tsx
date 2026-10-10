import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Lead } from "@/types";
import { buildCompleteLeadCopyText, copyTextToClipboard } from "@/lib/lead-copy";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { isOperatorRole } from "@/lib/access";

interface CompleteLeadCopyButtonProps {
  lead: Lead;
  className?: string;
}

export default function CompleteLeadCopyButton({ lead, className }: CompleteLeadCopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const { role } = useAuth();

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const includeQuote = !isOperatorRole(role) || lead.show_quote_to_opr !== false;
    try {
      await copyTextToClipboard(buildCompleteLeadCopyText(lead, includeQuote));
      setCopied(true);
      toast.success("Complete lead details copied");
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("Unable to copy lead details. Please try again.");
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      title="Copy complete lead details"
      aria-label="Copy complete lead details"
      className={cn("h-auto min-h-10 min-w-0 max-w-full gap-2 whitespace-normal rounded-xl px-3 py-2 text-[12px] font-semibold", className)}
      onClick={handleCopy}
    >
      {copied ? <Check className="h-3.5 w-3.5 shrink-0" /> : <Copy className="h-3.5 w-3.5 shrink-0" />}
      <span>{copied ? "Copied" : "Copy Details"}</span>
    </Button>
  );
}
