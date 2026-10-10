import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useExtensionRelease } from "@/hooks/useExtensionRelease";
import { detectInstalledExtension, formatExtensionReleaseDate, isNewerExtension, type InstalledExtension } from "@/lib/extension-release";
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
  installed?: InstalledExtension | null;
  checkingInstalled?: boolean;
}

export default function InstallExtensionDialog({ open, onOpenChange, installed: suppliedInstalled, checkingInstalled }: InstallExtensionDialogProps) {
  const [copied, setCopied] = useState(false);
  const { user } = useAuth();
  const { data: release, isError: releaseError } = useExtensionRelease();
  const installedQuery = useQuery({
    queryKey: ["installed-extension", user?.id], queryFn: detectInstalledExtension,
    enabled: open, staleTime: 30_000,
  });
  const installed = suppliedInstalled === undefined ? installedQuery.data : suppliedInstalled;
  const checking = checkingInstalled ?? installedQuery.isPending;
  const outdated = release && installed && isNewerExtension(release.version, installed.version);
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
                 Donut Extension & Updates
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                 Release information and manual Chrome installation.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-2 rounded-2xl border border-border/60 bg-muted/30 p-3 text-xs">
            <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">Latest release</span><strong>{release ? `Donut v${release.version}` : releaseError ? "Check unavailable" : "Checking..."}</strong></div>
            {release && <>
              <p className="text-muted-foreground">Released {formatExtensionReleaseDate(release.releasedAt)}</p>
              <p>{release.summary}</p>
            </>}
            <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-2"><span className="text-muted-foreground">Installed in this browser</span><strong>{checking ? "Checking..." : installed ? `v${installed.version}` : "Not detected"}</strong></div>
            {installed?.releasedAt && !Number.isNaN(Date.parse(installed.releasedAt)) && <p className="text-muted-foreground">Installed release: {formatExtensionReleaseDate(installed.releasedAt)}</p>}
            {!checking && <p className={outdated ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>
              {outdated ? `Update required: please install Donut v${release.version}.` : installed && release ? "Your installed version is current or newer." : installed ? "Latest release information is unavailable. Check again when connected." : "Earlier manual ZIP releases cannot report their version. Check Donut in chrome://extensions and update if needed."}
            </p>}
          </div>
          <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3 text-xs leading-5">
            <strong>Already using Donut? Update manually</strong>
            <ol className="mt-1 list-decimal space-y-1 pl-4">
              <li>Download the latest ZIP below and extract it.</li>
              <li>Replace the contents of the existing <strong>quo-crm-extension</strong> folder Chrome loads. Keep the same folder path.</li>
              <li>Open <code>chrome://extensions</code>, enable Developer mode, and click <strong>Reload</strong> on Donut.</li>
              <li>Refresh CRM and Quo tabs, reopen Donut, and confirm the installed version matches the latest release.</li>
            </ol>
            <p className="mt-2 text-muted-foreground">Donut is distributed by ZIP, not the Chrome Web Store. Chrome cannot install this update automatically. First-time setup is below.</p>
          </div>
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
                <a href={release ? `/Donut.zip?v=${release.version}` : "/Donut.zip"} download={release ? `Donut-v${release.version}.zip` : "Donut.zip"}>
                  <Download className="h-3.5 w-3.5" />
                  {release ? `Download Donut v${release.version}` : "Download Extension ZIP"}
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
                Click the extension icon in Chrome, open <strong>Settings</strong>, and paste your CRM Website URL:
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
