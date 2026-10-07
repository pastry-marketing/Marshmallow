import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import CancellationReasonSuggest from "./CancellationReasonSuggest";

interface CancellationRequestSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (comment: string, proof: string, proofImage: File | null, aiReasonCode?: string, aiReasonApplied?: boolean) => void | Promise<void>;
  loading?: boolean;
  requesterLabel?: string;
  mode?: "request" | "direct";
  leadId?: string;
}

export default function CancellationRequestSheet({
  open,
  onOpenChange,
  onSubmit,
  loading = false,
  requesterLabel = "your manager",
  mode = "request",
  leadId,
}: CancellationRequestSheetProps) {
  const [comment, setComment] = useState("");
  const [proof, setProof] = useState("");
  const [proofImage, setProofImage] = useState<File | null>(null);
  const [aiReasonCode, setAiReasonCode] = useState<string | undefined>();
  const [aiReasonApplied, setAiReasonApplied] = useState(false);

  useEffect(() => {
    if (!open) {
      setComment("");
      setProof("");
      setProofImage(null);
      setAiReasonCode(undefined);
      setAiReasonApplied(false);
    }
  }, [open]);

  const handleSubmit = async () => {
    await onSubmit(comment, proof, proofImage, aiReasonCode, aiReasonApplied);
  };
  const isDirect = mode === "direct";

  const handleApplyAiReason = (reasonText: string, isAi: boolean, reasonCode: string) => {
    setComment((prev) => (prev ? `${prev}\n\n${reasonText}` : reasonText));
    setAiReasonCode(reasonCode);
    setAiReasonApplied(true);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{isDirect ? "Cancel lead" : "Request cancellation"}</SheetTitle>
          <SheetDescription>
            {isDirect
              ? "Add the cancellation reason before this lead is marked cancelled."
              : `This lead will move to Cancellation Pending first. ${requesterLabel} can approve or reject it after checking your comment and proof.`}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 pt-4">
          {leadId && (
            <CancellationReasonSuggest 
              leadId={leadId} 
              onApply={handleApplyAiReason} 
            />
          )}

          <div className="space-y-2">
            <Label htmlFor="cancel-comment">Cancellation reason *</Label>
            <Textarea
              id="cancel-comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Explain why this lead should be cancelled..."
              rows={4}
              autoFocus
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
            <Label htmlFor="cancel-proof">Proof / reference / link</Label>
            <Input
              id="cancel-proof"
              value={proof}
              onChange={(event) => setProof(event.target.value)}
              placeholder="Paste proof, note, screenshot link, or reference..."
            />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cancel-proof-image">Upload image</Label>
              <Input
                id="cancel-proof-image"
                type="file"
                accept="image/*"
                onChange={(event) => setProofImage(event.target.files?.[0] ?? null)}
              />
            </div>
          </div>
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Back
          </Button>
          <Button onClick={handleSubmit} disabled={loading || !comment.trim()}>
            {loading ? "Saving..." : isDirect ? "Cancel lead" : "Send request"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
