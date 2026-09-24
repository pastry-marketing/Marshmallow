import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Chrome, FolderOpen, Puzzle, Settings, Check } from "lucide-react";

interface InstallExtensionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function InstallExtensionDialog({ open, onOpenChange }: InstallExtensionDialogProps) {
  const [copied, setCopied] = useState(false);
  const currentOrigin = window.location.origin;

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(currentOrigin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy URL:", err);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-3xl border border-border/60 bg-card/95 shadow-brand backdrop-blur-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader className="border-b border-border/50 pb-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-primary/[0.08] text-primary flex items-center justify-center border border-primary/10">
              <Puzzle className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg font-bold tracking-tight text-foreground">
                Install Chrome Extension
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                Setup the Quo CRM Lead Capture Chrome Extension.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Step 1 */}
          <div className="flex gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
              1
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-foreground">Download the Extension Package</h4>
              <p className="text-xs text-muted-foreground leading-normal">
                Download the prepackaged extension ZIP archive directly to your computer.
              </p>
              <Button asChild className="w-full gap-2 mt-1 h-9 text-xs" size="sm">
                <a href="/Donut.zip" download="Donut.zip">
                  <Download className="h-3.5 w-3.5" />
                  Download Extension ZIP
                </a>
              </Button>
            </div>
          </div>

          {/* Step 2 */}
          <div className="flex gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
              2
            </div>
            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-foreground">Extract the ZIP Folder</h4>
              <p className="text-xs text-muted-foreground leading-normal flex items-start gap-1">
                <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                Unzip the downloaded <code>Donut.zip</code> file to a permanent folder on your computer (e.g. your Documents directory).
              </p>
            </div>
          </div>

          {/* Step 3 */}
          <div className="flex gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
              3
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-foreground">Load Extension into Google Chrome</h4>
              <div className="text-xs text-muted-foreground leading-normal space-y-1.5">
                <p className="flex items-start gap-1">
                  <Chrome className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  Open Chrome and navigate to: <code>chrome://extensions</code>
                </p>
                <p>
                  Enable <strong>Developer mode</strong> using the toggle switch in the top-right corner.
                </p>
                <p>
                  Click the <strong>Load unpacked</strong> button in the top-left, and select the folder you unzipped in Step 2.
                </p>
              </div>
            </div>
          </div>

          {/* Step 4 */}
          <div className="flex gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
              4
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-foreground">Configure Website URL & Log In</h4>
              <p className="text-xs text-muted-foreground leading-normal">
                Click the extension icon in Chrome, navigate to **Settings**, and paste your CRM Website URL:
              </p>
              <div className="flex items-center gap-1.5 bg-muted/50 p-2 rounded-xl border border-border/40">
                <code className="text-[11px] font-mono truncate flex-1 text-foreground">{currentOrigin}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[10px] px-2 gap-1 rounded-lg hover:bg-muted"
                  onClick={handleCopyUrl}
                >
                  {copied ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-500" />
                      Copied
                    </>
                  ) : (
                    "Copy URL"
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground leading-normal">
                Log in with your standard CRM email and password, and begin capturing leads!
              </p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
