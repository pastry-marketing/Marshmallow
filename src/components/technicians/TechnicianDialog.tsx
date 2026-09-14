import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { geocodeAddress } from "@/lib/geo";
import { formatUSPhone, stripPhone } from "@/lib/phone";
import { lookupZipCentroid, resolveZip } from "@/lib/zipCentroids";
import { TECHNICIANS_QUERY_KEY, upsertTechnicianInList } from "@/lib/technicians";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";

export interface TechnicianRecord {
  id: string;
  name: string;
  area: string;
  service: string | null;
  notes: string | null;
  chat_link: string | null;
  phone_number: string | null;
  latitude: number | null;
  longitude: number | null;
  code?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  technician?: TechnicianRecord | null;
  onSaved?: (saved: TechnicianRecord) => void;
}

export function formatTechCode(num: number): string {
  return `TECH ${String(num).padStart(3, "0")}`;
}

export function TechnicianDialog({ open, onOpenChange, technician, onSaved }: Props) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [existingCodes, setExistingCodes] = useState<Array<{ code: string; count: number }>>([]);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [area, setArea] = useState("");
  const [service, setService] = useState("");
  const [chatLink, setChatLink] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(technician?.name ?? "");
      setCode(technician?.code ?? "");
      setPhone(formatUSPhone(technician?.phone_number ?? ""));
      setPhoneError(null);
      setArea(technician?.area ?? "");
      setService(technician?.service ?? "");
      setChatLink(technician?.chat_link ?? "");
      setNotes(technician?.notes ?? "");

      // Load existing codes with technician counts for the dropdown
      supabase
        .from("technicians")
        .select("code")
        .not("code", "is", null)
        .then(({ data, error }) => {
          if (error || !data) return;
          const counts: Record<string, number> = {};
          for (const row of data) {
            const c = (row.code || "").trim();
            if (c) counts[c] = (counts[c] || 0) + 1;
          }
          const list = Object.entries(counts).map(([codeKey, count]) => ({ code: codeKey, count }));
          list.sort((a, b) => {
            const ma = a.code.match(/tech\s*(\d+)/i);
            const mb = b.code.match(/tech\s*(\d+)/i);
            if (ma && mb) return parseInt(ma[1], 10) - parseInt(mb[1], 10);
            return a.code.localeCompare(b.code);
          });
          setExistingCodes(list);
        });
    }
  }, [open, technician]);

  const handleGenerateNextCode = async () => {
    setGeneratingCode(true);
    try {
      let maxNum = 0;
      const { data } = await supabase.from("technicians").select("code").not("code", "is", null);
      for (const row of data || []) {
        const c = (row.code || "").trim();
        if (c) {
          const m = c.match(/tech\s*(\d+)/i);
          if (m) {
            const val = parseInt(m[1], 10);
            if (val > maxNum) maxNum = val;
          }
        }
      }
      for (const item of existingCodes) {
        const m = item.code.match(/tech\s*(\d+)/i);
        if (m) {
          const val = parseInt(m[1], 10);
          if (val > maxNum) maxNum = val;
        }
      }
      const nextNum = maxNum + 1;
      const nextCode = formatTechCode(nextNum);
      setCode(nextCode);
      setExistingCodes((prev) => {
        if (prev.some((x) => x.code.toLowerCase() === nextCode.toLowerCase())) return prev;
        return [...prev, { code: nextCode, count: 0 }].sort((a, b) => {
          const ma = a.code.match(/tech\s*(\d+)/i);
          const mb = b.code.match(/tech\s*(\d+)/i);
          if (ma && mb) return parseInt(ma[1], 10) - parseInt(mb[1], 10);
          return a.code.localeCompare(b.code);
        });
      });
      toast({ title: "Name Code generated", description: `Assigned ${nextCode} to this technician.` });
    } catch (e) {
      toast({ title: "Generation failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setGeneratingCode(false);
    }
  };

  const handleSubmit = async () => {
    const cleanName = name.trim();
    const cleanArea = area.trim();
    const cleanService = service.trim();
    const cleanPhone = formatUSPhone(phone);
    const phoneDigits = stripPhone(cleanPhone);

    // Required fields: Technician Name, Number, Service, and Area.
    if (!cleanName) {
      toast({ title: "Technician Name is required", variant: "destructive" });
      return;
    }
    if (!phoneDigits) {
      setPhoneError("Phone number is required");
      return;
    }
    if (phoneDigits.length !== 10) {
      setPhoneError("Enter a valid 10-digit U.S. phone number");
      return;
    }
    if (!cleanService) {
      toast({ title: "Service is required", variant: "destructive" });
      return;
    }
    if (!cleanArea) {
      toast({ title: "Area is required", variant: "destructive" });
      return;
    }
    setPhoneError(null);
    setSaving(true);
    try {
      let latitude = technician?.latitude ?? null;
      let longitude = technician?.longitude ?? null;
      const areaChanged = !technician || technician.area !== cleanArea;
      if (areaChanged && cleanArea) {
        const zip = resolveZip({ address: cleanArea });
        const centroid = await lookupZipCentroid(zip);
        const coords = centroid ?? await geocodeAddress(cleanArea);
        if (coords) {
          latitude = coords.latitude;
          longitude = coords.longitude;
        } else {
          latitude = null;
          longitude = null;
        }
      } else if (!cleanArea) {
        latitude = null;
        longitude = null;
      }

      const payload = {
        name: cleanName,
        area: cleanArea,
        phone_number: cleanPhone,
        service: cleanService,
        chat_link: chatLink.trim() || null,
        notes: notes.trim() || null,
        code: code.trim() || null,
        latitude,
        longitude,
      };

      const SELECT = "id, name, area, service, notes, chat_link, phone_number, latitude, longitude, code";
      const SELECT_FALLBACK = "id, name, area, service, notes, chat_link, phone_number, latitude, longitude";
      let saved: TechnicianRecord | null = null;
      let error: { message: string } | null = null;
      if (technician) {
        let res = await supabase.from("technicians").update(payload).eq("id", technician.id).select(SELECT).single();
        if (res.error && (res.error.message?.includes("code") || (res.error as any).code === "42703")) {
          const { code: _, ...withoutCode } = payload;
          res = await supabase.from("technicians").update(withoutCode).eq("id", technician.id).select(SELECT_FALLBACK).single();
        }
        error = res.error;
        saved = (res.data as TechnicianRecord | null) ?? null;
      } else {
        const { data: { user } } = await supabase.auth.getUser();
        let res = await supabase.from("technicians").insert({ ...payload, created_by: user?.id ?? null }).select(SELECT).single();
        if (res.error && (res.error.message?.includes("code") || (res.error as any).code === "42703")) {
          const { code: _, ...withoutCode } = payload;
          res = await supabase.from("technicians").insert({ ...withoutCode, created_by: user?.id ?? null }).select(SELECT_FALLBACK).single();
        }
        error = res.error;
        saved = (res.data as TechnicianRecord | null) ?? null;
      }

      if (error || !saved?.id) {
        toast({ title: "Save failed", description: error?.message ?? "Could not verify the saved technician.", variant: "destructive" });
      } else {
        const geoWarn = !!cleanArea && (latitude == null || longitude == null);
        queryClient.setQueryData<TechnicianRecord[]>(TECHNICIANS_QUERY_KEY, (current) =>
          upsertTechnicianInList(current, saved),
        );
        toast({
          title: technician ? "Technician updated" : "Technician added",
          description: geoWarn ? "Saved, but the area could not be located on the map." : undefined,
        });
        if (!technician) {
          setPhone("");
          setCode("");
        }
        onSaved?.(saved);
        onOpenChange(false);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{technician ? "Edit Technician" : "Add Technician"}</DialogTitle>
          <DialogDescription>Manage a technician for the Map View.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="tech-name">Technician Name <span className="text-destructive">*</span></Label>
            <Input id="tech-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. John Smith" />
          </div>

          {/* Name Code field: Dropdown selection + Sequential Generator only (No manual typing) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="tech-code">Name Code</Label>
              <span className="text-[11px] text-muted-foreground">Select existing or generate</span>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={code || "__none__"}
                onValueChange={(val) => setCode(val === "__none__" ? "" : val)}
              >
                <SelectTrigger id="tech-code" className="flex-1 text-xs">
                  <SelectValue placeholder="Select existing code..." />
                </SelectTrigger>
                <SelectContent className="max-h-56">
                  <SelectItem value="__none__">None (No code)</SelectItem>
                  {existingCodes.map((item) => (
                    <SelectItem key={item.code} value={item.code}>
                      {item.code} ({item.count} tech{item.count === 1 ? "" : "s"})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleGenerateNextCode}
                disabled={generatingCode || saving}
                className="h-9 px-3 shrink-0 gap-1.5 text-xs font-medium"
                title="Generate next sequential TECH code (e.g. TECH 001, TECH 002)"
              >
                {generatingCode ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                )}
                Generate
              </Button>
            </div>
            {code ? (
              <div className="flex items-center justify-between rounded-md bg-primary/10 border border-primary/20 px-2.5 py-1 text-xs text-primary">
                <div className="flex items-center gap-1.5 font-medium">
                  <span>Assigned Code:</span>
                  <span className="bg-background text-foreground font-semibold px-2 py-0.5 rounded border border-border tracking-wider text-[11px]">
                    {code}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setCode("")}
                  className="text-[11px] text-muted-foreground hover:text-destructive underline cursor-pointer"
                >
                  Clear Code
                </button>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Pick a shared code from the dropdown or click Generate for the next sequential TECH code. No manual typing.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tech-phone">Phone Number <span className="text-destructive">*</span></Label>
            <Input
              id="tech-phone"
              type="tel"
              value={phone}
              onChange={(e) => { setPhone(formatUSPhone(e.target.value)); if (phoneError) setPhoneError(null); }}
              placeholder="e.g. (305) 555-0123"
              inputMode="tel"
              autoComplete="tel"
              maxLength={14}
            />
            {phoneError && <p className="text-[11px] text-destructive">{phoneError}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tech-area">Area <span className="text-destructive">*</span></Label>
            <Input id="tech-area" value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Miami, FL or 33101" />
            <p className="text-[11px] text-muted-foreground">City & state, ZIP code, or full address. Used to place the marker.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tech-service">Service <span className="text-destructive">*</span></Label>
            <Input id="tech-service" value={service} onChange={(e) => setService(e.target.value)} placeholder="e.g. Plumbing" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tech-chat">Quo Chat Link</Label>
            <Input id="tech-chat" value={chatLink} onChange={(e) => setChatLink(e.target.value)} placeholder="https://app.openphone.com/..." />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tech-notes">Notes</Label>
            <Textarea id="tech-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {technician ? "Save Changes" : "Add Technician"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
