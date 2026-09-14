import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { MapPin, Search, X, Contact, User } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { TechnicianRecord } from "@/components/technicians/TechnicianDialog";
import { TechnicianDetailsContent } from "@/components/map/TechnicianDetailsContent";
import { fetchAllTechnicians, TECHNICIANS_QUERY_KEY } from "@/lib/technicians";
import { haversineMiles, isValidLatLng, LatLng } from "@/lib/geo";
import { resolveZip, lookupZipCentroidSync, preloadZipDataset, ZipCentroid } from "@/lib/zipCentroids";
import { STATUS_LABELS } from "@/lib/constants";
import { useIsMobile } from "@/hooks/use-mobile";
import type { LeadStatus } from "@/types";
import { toast } from "sonner";


const RADIUS_MILES = 20;
const RADIUS_METERS = RADIUS_MILES * 1609.344;
const US_STATES: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",DC:"District of Columbia",
};
const STATE_NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]),
);

interface UrgentLead {
  id: string;
  job_id: string;
  customer_name: string;
  customer_phone: string;
  address: string;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  service_type: string;
  status: LeadStatus;
  latitude: number | null;
  longitude: number | null;
}

interface MappedLead extends UrgentLead {
  coords: LatLng;
  zip: string;
  zipCity: string;
  zipState: string;
}

interface MappedTech extends TechnicianRecord {
  coords: LatLng;
}

interface SearchableTech extends TechnicianRecord {
  coords: LatLng | null;
  locationUnavailable: boolean;
}

type CanvasPinKind = "lead" | "tech";

interface CanvasPin {
  id: string;
  kind: CanvasPinKind;
  lat: number;
  lng: number;
  selected?: boolean;
}

interface CanvasHitTarget extends CanvasPin {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

class MapPinCanvasLayer extends L.Layer {
  private canvas: HTMLCanvasElement | null = null;
  private map: L.Map | null = null;
  private topLeft = L.point(0, 0);
  private pins: CanvasPin[] = [];
  private leadHitTargets: CanvasHitTarget[] = [];
  private techHitTargets: CanvasHitTarget[] = [];
  private resetFrame: number | null = null;
  private redrawFrame: number | null = null;
  private hoverFrame: number | null = null;
  private lastMouseMoveEvent: MouseEvent | null = null;
  private isMoving = false;
  private canvasCssWidth = 0;
  private canvasCssHeight = 0;
  private canvasScale = 0;

  constructor(
    private readonly onTechClick: (id: string, latlng: L.LatLng) => void,
    private readonly onLeadClick: (id: string, latlng: L.LatLng) => void,
    private readonly getTechTooltip: (id: string) => string,
  ) {
    super();
  }

  onAdd(map: L.Map): this {
    this.map = map;
    this.canvas = L.DomUtil.create("canvas", "marshmallow-map-pin-canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.zIndex = "620";
    this.canvas.style.pointerEvents = "auto";
    this.canvas.addEventListener("click", this.handleClick);
    this.canvas.addEventListener("mousemove", this.handleMouseMove);
    this.canvas.addEventListener("mouseleave", this.handleMouseLeave);
    const pane = map.getPane("marshmallow-tech-pins") ?? map.getPanes().overlayPane;
    pane.appendChild(this.canvas);
    map.on("movestart zoomstart", this.handleMoveStart, this);
    map.on("moveend zoomend", this.handleMoveEnd, this);
    map.on("resize viewreset", this.scheduleReset, this);
    this.reset();
    return this;
  }

  onRemove(map: L.Map): this {
    map.off("movestart zoomstart", this.handleMoveStart, this);
    map.off("moveend zoomend", this.handleMoveEnd, this);
    map.off("resize viewreset", this.scheduleReset, this);
    this.cancelFrames();
    if (this.canvas) {
      this.canvas.removeEventListener("click", this.handleClick);
      this.canvas.removeEventListener("mousemove", this.handleMouseMove);
      this.canvas.removeEventListener("mouseleave", this.handleMouseLeave);
      L.DomUtil.remove(this.canvas);
    }
    this.canvas = null;
    this.map = null;
    this.leadHitTargets = [];
    this.techHitTargets = [];
    this.lastMouseMoveEvent = null;
    return this;
  }

  setPins(pins: CanvasPin[]) {
    this.pins = pins;
    this.scheduleRedraw();
  }

  private cancelFrames() {
    if (this.resetFrame !== null) window.cancelAnimationFrame(this.resetFrame);
    if (this.redrawFrame !== null) window.cancelAnimationFrame(this.redrawFrame);
    if (this.hoverFrame !== null) window.cancelAnimationFrame(this.hoverFrame);
    this.resetFrame = null;
    this.redrawFrame = null;
    this.hoverFrame = null;
  }

  private scheduleReset = () => {
    if (this.resetFrame !== null) return;
    this.resetFrame = window.requestAnimationFrame(() => {
      this.resetFrame = null;
      this.reset();
    });
  };

  private scheduleRedraw = () => {
    if (this.redrawFrame !== null) return;
    this.redrawFrame = window.requestAnimationFrame(() => {
      this.redrawFrame = null;
      this.redraw();
    });
  };

  private handleMoveStart = () => {
    this.isMoving = true;
    if (!this.canvas) return;
    this.canvas.style.cursor = "";
    this.canvas.title = "";
  };

  private handleMoveEnd = () => {
    this.isMoving = false;
    this.scheduleReset();
  };

  private reset = () => {
    if (!this.map || !this.canvas) return;
    const size = this.map.getSize();
    this.topLeft = this.map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, this.topLeft);
    const scale = window.devicePixelRatio || 1;
    const nextPixelWidth = Math.max(1, Math.round(size.x * scale));
    const nextPixelHeight = Math.max(1, Math.round(size.y * scale));
    if (
      this.canvas.width !== nextPixelWidth
      || this.canvas.height !== nextPixelHeight
      || this.canvasScale !== scale
    ) {
      this.canvas.width = nextPixelWidth;
      this.canvas.height = nextPixelHeight;
      this.canvasScale = scale;
    }
    if (this.canvasCssWidth !== size.x) {
      this.canvas.style.width = `${size.x}px`;
      this.canvasCssWidth = size.x;
    }
    if (this.canvasCssHeight !== size.y) {
      this.canvas.style.height = `${size.y}px`;
      this.canvasCssHeight = size.y;
    }
    const ctx = this.canvas.getContext("2d");
    if (ctx) ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.redraw();
  };

  private redraw() {
    if (!this.map || !this.canvas) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const size = this.map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);
    this.leadHitTargets = [];
    this.techHitTargets = [];

    for (const pin of this.pins) {
      if (pin.kind === "lead") this.drawPin(ctx, pin, "#ef4444", 30);
    }
    for (const pin of this.pins) {
      if (pin.kind === "tech") this.drawPin(ctx, pin, pin.selected ? "#2563eb" : "#3b82f6", pin.selected ? 34 : 30);
    }
  }

  private drawPin(ctx: CanvasRenderingContext2D, pin: CanvasPin, fill: string, size: number) {
    if (!this.map) return;
    const point = this.map.latLngToLayerPoint([pin.lat, pin.lng]).subtract(this.topLeft);
    const halfWidth = size * 0.42;
    const target: CanvasHitTarget = {
      ...pin,
      minX: point.x - halfWidth,
      maxX: point.x + halfWidth,
      minY: point.y - size,
      maxY: point.y + 3,
    };
    if (pin.kind === "tech") this.techHitTargets.push(target);
    else this.leadHitTargets.push(target);

    const scale = size / 32;
    ctx.save();
    ctx.translate(point.x - 12 * scale, point.y - 31.25 * scale);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.moveTo(12, 0.75);
    ctx.bezierCurveTo(5.65, 0.75, 0.75, 5.65, 0.75, 12);
    ctx.bezierCurveTo(0.75, 20.5, 12, 31.25, 12, 31.25);
    ctx.bezierCurveTo(12, 31.25, 23.25, 20.5, 23.25, 12);
    ctx.bezierCurveTo(23.25, 5.65, 18.35, 0.75, 12, 0.75);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(12, 12, 4.25, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.restore();
  }

  private findHit(event: MouseEvent) {
    if (!this.map) return null;
    const point = this.map.mouseEventToLayerPoint(event).subtract(this.topLeft);
    for (let i = this.techHitTargets.length - 1; i >= 0; i -= 1) {
      const pin = this.techHitTargets[i];
      if (this.pinContainsPoint(pin, point)) return pin;
    }
    for (let i = this.leadHitTargets.length - 1; i >= 0; i -= 1) {
      const pin = this.leadHitTargets[i];
      if (this.pinContainsPoint(pin, point)) return pin;
    }
    return null;
  }

  private pinContainsPoint(pin: CanvasHitTarget, point: L.Point) {
    return point.x >= pin.minX
      && point.x <= pin.maxX
      && point.y >= pin.minY
      && point.y <= pin.maxY;
  }

  private handleClick = (event: MouseEvent) => {
    if (!this.map) return;
    const hit = this.findHit(event);
    if (!hit) return;
    L.DomEvent.stop(event);
    const latlng = L.latLng(hit.lat, hit.lng);
    if (hit.kind === "tech") this.onTechClick(hit.id, latlng);
    else this.onLeadClick(hit.id, latlng);
  };

  private handleMouseMove = (event: MouseEvent) => {
    if (!this.canvas || this.isMoving) return;
    this.lastMouseMoveEvent = event;
    if (this.hoverFrame !== null) return;
    this.hoverFrame = window.requestAnimationFrame(() => {
      this.hoverFrame = null;
      if (!this.canvas || this.isMoving || !this.lastMouseMoveEvent) return;
      const hit = this.findHit(this.lastMouseMoveEvent);
      this.canvas.style.cursor = hit ? "pointer" : "";
      this.canvas.title = hit?.kind === "tech" ? this.getTechTooltip(hit.id) : "";
    });
  };

  private handleMouseLeave = () => {
    this.lastMouseMoveEvent = null;
    if (this.hoverFrame !== null) {
      window.cancelAnimationFrame(this.hoverFrame);
      this.hoverFrame = null;
    }
    if (!this.canvas) return;
    this.canvas.style.cursor = "";
    this.canvas.title = "";
  };
}

function escapeHtml(v: string) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function phoneTelHref(phone: string) {
  return phone ? `tel:${phone.startsWith("+") ? "+" : ""}${phone.replace(/\D/g, "")}` : "";
}

function leadMarkerLatLng(l: MappedLead): L.LatLngTuple {
  let latHash = 0;
  let lngHash = 0;
  for (let i = 0; i < l.id.length; i++) {
    latHash = (latHash * 31 + l.id.charCodeAt(i) + 1) | 0;
    lngHash = (lngHash * 31 + l.id.charCodeAt(i) + 7) | 0;
  }
  const latJitter = (((latHash % 1000) / 500) - 1) * 0.0015;
  const lngJitter = (((lngHash % 1000) / 500) - 1) * 0.0015;
  return [l.coords.latitude + latJitter, l.coords.longitude + lngJitter];
}

export default function MapViewPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const mapRef = useRef<L.Map | null>(null);
  const mapEl = useRef<HTMLDivElement | null>(null);
  const pinLayerRef = useRef<MapPinCanvasLayer | null>(null);
  const radiusLayer = useRef<L.Circle | null>(null);
  const leadDataRefs = useRef<Map<string, MappedLead>>(new Map());
  const techDataRefs = useRef<Map<string, SearchableTech>>(new Map());
  const selectedTechRef = useRef<SearchableTech | null>(null);
  const activeSelectedTechIdRef = useRef<string | null>(null);
  const isMobileRef = useRef(isMobile);
  const mapPopupRef = useRef<L.Popup | null>(null);
  const visibleLeadIdsRef = useRef<Set<string>>(new Set());
  const desiredVisibleLeadIdsRef = useRef<Set<string>>(new Set());
  const leadVisibilityFrameRef = useRef<number | null>(null);
  const leadVisibilityGenerationRef = useRef(0);
  const mapInvalidateTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leadFocusTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const techFocusTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedTechId, setSelectedTechId] = useState<string | null>(null);
  const [serviceFilter, setServiceFilter] = useState<string>("all");
  const [techSearch, setTechSearch] = useState("");
  const [showTechSuggestions, setShowTechSuggestions] = useState(false);
  const [techActiveIndex, setTechActiveIndex] = useState(0);
  const [pendingFocusTechId, setPendingFocusTechId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [zipDatasetReady, setZipDatasetReady] = useState(false);
  const [mapVisible, setMapVisible] = useState(false);
  const [viewMode, setViewMode] = useState<"leads" | "techs" | "both">("both");
  const [customerSearch, setCustomerSearch] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [pendingFocusLeadId, setPendingFocusLeadId] = useState<string | null>(null);
  const [areaSearch, setAreaSearch] = useState("");
  const [areaQuery, setAreaQuery] = useState(""); // applied on Search Area click
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [mapReady, setMapReady] = useState(false);
  const [pinRenderVersion, setPinRenderVersion] = useState(0);

  const urgentLeadsQuery = useQuery({
    queryKey: ["map-urgent-leads"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("id, job_id, customer_name, customer_phone, address, city, state, zip_code, service_type, status, latitude, longitude")
        .eq("status", "urgent_job")
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as UrgentLead[];
    },
    staleTime: 60_000,
  });

  const queryClient = useQueryClient();

  useEffect(() => {
    const channel = supabase
      .channel("map-page-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "leads" },
        (payload) => {
          const newRow = payload.new as UrgentLead | undefined;
          const oldRow = payload.old as UrgentLead | undefined;

          queryClient.setQueryData<UrgentLead[]>(["map-urgent-leads"], (old) => {
            if (!old) return old;

            if (payload.eventType === "INSERT" && newRow) {
              if (newRow.status === "urgent_job") return [...old, newRow];
            } else if (payload.eventType === "UPDATE" && newRow) {
              const exists = old.some(l => l.id === newRow.id);
              if (exists) {
                if (newRow.status === "urgent_job") {
                  return old.map(l => l.id === newRow.id ? { ...l, ...newRow } : l);
                } else {
                  return old.filter(l => l.id !== newRow.id);
                }
              } else if (newRow.status === "urgent_job") {
                return [...old, newRow];
              }
            } else if (payload.eventType === "DELETE" && oldRow) {
              return old.filter(l => l.id !== oldRow.id);
            }
            return old;
          });
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const techniciansQuery = useQuery({
    queryKey: TECHNICIANS_QUERY_KEY,
    queryFn: fetchAllTechnicians,
    staleTime: 60_000,
  });

  useEffect(() => {
    let cancelled = false;
    preloadZipDataset().finally(() => { if (!cancelled) setZipDatasetReady(true); });
    return () => { cancelled = true; };
  }, []);

  const mappedLeads = useMemo<MappedLead[]>(() => {
    if (!zipDatasetReady) return [];
    const rows = urgentLeadsQuery.data ?? [];
    const out: MappedLead[] = [];
    for (const l of rows) {
      const zip = resolveZip({ zip_code: l.zip_code, address: l.address });
      const centroid: ZipCentroid | null = lookupZipCentroidSync(zip);
      const hasSavedCoords = isValidLatLng(l.latitude, l.longitude);
      if (!hasSavedCoords && !centroid) continue;
      out.push({
        ...l,
        coords: hasSavedCoords
          ? { latitude: l.latitude as number, longitude: l.longitude as number }
          : { latitude: centroid?.latitude as number, longitude: centroid?.longitude as number },
        zip: zip ?? "",
        zipCity: centroid?.city ?? l.city ?? "",
        zipState: centroid?.state ?? l.state ?? "",
      });
    }
    return out;
  }, [urgentLeadsQuery.data, zipDatasetReady]);

  const searchableTechs = useMemo<SearchableTech[]>(() => {
    if (!zipDatasetReady) return [];
    return (techniciansQuery.data ?? []).map((t) => {
      if (isValidLatLng(t.latitude, t.longitude)) {
        return {
          ...t,
          coords: { latitude: t.latitude as number, longitude: t.longitude as number },
          locationUnavailable: false,
        };
      }
      const zip = resolveZip({ address: t.area });
      const centroid = lookupZipCentroidSync(zip);
      if (centroid) {
        return {
          ...t,
          coords: { latitude: centroid.latitude, longitude: centroid.longitude },
          locationUnavailable: false,
        };
      }
      return { ...t, coords: null, locationUnavailable: true };
    });
  }, [techniciansQuery.data, zipDatasetReady]);

  const mappedTechs = useMemo<MappedTech[]>(() => {
    return searchableTechs
      .filter((t): t is SearchableTech & { coords: LatLng; locationUnavailable: false } => !!t.coords && !t.locationUnavailable)
      .map((t) => ({ ...t, coords: t.coords }));
  }, [searchableTechs]);

  const services = useMemo(() => {
    const set = new Set<string>();
    for (const t of techniciansQuery.data ?? []) if (t.service) set.add(t.service);
    return Array.from(set).sort();
  }, [techniciansQuery.data]);

  const extractStateFromText = useCallback((s: string | null | undefined): string | null => {
    if (!s) return null;
    const txt = s.trim();
    if (!txt) return null;
    // Match 2-letter code as whole token
    const m = txt.match(/\b([A-Z]{2})\b/);
    if (m && US_STATES[m[1]]) return m[1];
    const lower = txt.toLowerCase();
    for (const name in STATE_NAME_TO_CODE) {
      if (lower.includes(name)) return STATE_NAME_TO_CODE[name];
    }
    return null;
  }, []);

  const availableStates = useMemo(() => {
    const set = new Set<string>();
    for (const l of mappedLeads) {
      const code = (l.state && l.state.length === 2 ? l.state.toUpperCase() : extractStateFromText(l.state)) || extractStateFromText(l.zipState);
      if (code && US_STATES[code]) set.add(code);
    }
    for (const t of searchableTechs) {
      const code = extractStateFromText(t.area);
      if (code && US_STATES[code]) set.add(code);
    }
    return Array.from(set).sort();
  }, [extractStateFromText, mappedLeads, searchableTechs]);

  const techMatchesArea = useCallback((t: TechnicianRecord, area: string) => {
    if (!area) return true;
    const q = area.trim().toLowerCase();
    return (t.area ?? "").toLowerCase().includes(q) || (t.name ?? "").toLowerCase().includes(q);
  }, []);
  const leadMatchesArea = useCallback((l: Pick<UrgentLead, "address" | "city" | "state" | "zip_code"> & { zipCity?: string; zipState?: string }, area: string) => {
    if (!area) return true;
    const q = area.trim().toLowerCase();
    return [l.address, l.city, l.state, l.zip_code, l.zipCity, l.zipState]
      .some((v) => (v ?? "").toString().toLowerCase().includes(q));
  }, []);
  const techMatchesState = useCallback((t: TechnicianRecord, code: string) => {
    if (code === "all") return true;
    return extractStateFromText(t.area) === code;
  }, [extractStateFromText]);
  const leadMatchesState = useCallback((l: Pick<UrgentLead, "state"> & { zipState?: string }, code: string) => {
    if (code === "all") return true;
    const lc = (l.state && l.state.length === 2 ? l.state.toUpperCase() : extractStateFromText(l.state)) || extractStateFromText(l.zipState);
    return lc === code;
  }, [extractStateFromText]);

  const filteredSearchableTechs = useMemo(() => {
    return searchableTechs.filter((t) => {
      if (serviceFilter !== "all" && (t.service ?? "") !== serviceFilter) return false;
      if (!techMatchesState(t, stateFilter)) return false;
      if (!techMatchesArea(t, areaQuery)) return false;
      return true;
    });
  }, [areaQuery, searchableTechs, serviceFilter, stateFilter, techMatchesArea, techMatchesState]);

  const filteredTechs = useMemo(() => {
    return filteredSearchableTechs
      .filter((t): t is SearchableTech & { coords: LatLng; locationUnavailable: false } => !!t.coords && !t.locationUnavailable)
      .map((t) => ({ ...t, coords: t.coords }));
  }, [filteredSearchableTechs]);

  const filteredLeads = useMemo(() => {
    return mappedLeads.filter((l) => {
      if (!leadMatchesState(l, stateFilter)) return false;
      if (!leadMatchesArea(l, areaQuery)) return false;
      return true;
    });
  }, [areaQuery, leadMatchesArea, leadMatchesState, mappedLeads, stateFilter]);

  const filteredUrgentLeadTotal = useMemo(() => {
    if (!zipDatasetReady) return 0;
    return (urgentLeadsQuery.data ?? []).filter((l) => {
      const zip = resolveZip({ zip_code: l.zip_code, address: l.address });
      const centroid = lookupZipCentroidSync(zip);
      const leadForFilters = {
        ...l,
        zipCity: centroid?.city ?? "",
        zipState: centroid?.state ?? "",
      };
      if (!leadMatchesState(leadForFilters, stateFilter)) return false;
      if (!leadMatchesArea(leadForFilters, areaQuery)) return false;
      return true;
    }).length;
  }, [areaQuery, leadMatchesArea, leadMatchesState, stateFilter, urgentLeadsQuery.data, zipDatasetReady]);

  const technicianCountLabel = filteredSearchableTechs.length === filteredTechs.length
    ? `${filteredTechs.length} techs`
    : `${filteredSearchableTechs.length} techs · ${filteredTechs.length} mapped`;
  const urgentLeadCountLabel = filteredUrgentLeadTotal === filteredLeads.length
    ? `${filteredLeads.length} urgent leads`
    : `${filteredUrgentLeadTotal} urgent leads · ${filteredLeads.length} mapped`;

  const selectedTech = useMemo(
    () => filteredSearchableTechs.find((t) => t.id === selectedTechId) ?? searchableTechs.find((t) => t.id === selectedTechId) ?? null,
    [filteredSearchableTechs, searchableTechs, selectedTechId],
  );

  useEffect(() => {
    selectedTechRef.current = selectedTech;
  }, [selectedTech]);

  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  const leadsInRange = useMemo(() => {
    if (!selectedTech?.coords) return [] as Array<MappedLead & { distance: number }>;
    return filteredLeads
      .map((l) => ({ ...l, distance: haversineMiles(selectedTech.coords, l.coords) }))
      .filter((l) => l.distance <= RADIUS_MILES)
      .sort((a, b) => a.distance - b.distance);
  }, [selectedTech, filteredLeads]);

  const getMapPopup = useCallback(() => {
    if (!mapPopupRef.current) {
      mapPopupRef.current = L.popup({
        autoPan: true,
        autoClose: true,
        closeOnClick: true,
        closeButton: true,
        keepInView: true,
        autoPanPaddingTopLeft: L.point(16, 16),
        autoPanPaddingBottomRight: L.point(16, 16),
        minWidth: 230,
        maxWidth: 360,
      });
    }
    return mapPopupRef.current;
  }, []);

  const openSharedPopup = useCallback((latlng: L.LatLngExpression, content: HTMLElement) => {
    const map = mapRef.current;
    if (!map) return;
    const popup = getMapPopup();
    map.closePopup(popup);
    popup.setLatLng(latlng).setContent(content).openOn(map);
    popup.update();
  }, [getMapPopup]);

  const createTechPopupElement = useCallback((t: SearchableTech) => {
    const root = document.createElement("div");
    root.style.minWidth = "280px";
    root.style.maxWidth = "360px";
    root.style.maxHeight = "420px";
    root.style.overflowY = "auto";
    root.style.fontFamily = "inherit";
    root.addEventListener("click", (event) => event.stopPropagation());

    const phone = (t.phone_number ?? "").trim();
    const telHref = phoneTelHref(phone);
    const phoneBlock = phone
      ? `<div style="margin-top:6px"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280">Phone</div>
           <a href="${escapeHtml(telHref)}" style="font-size:13px;color:#2563eb;font-weight:600;text-decoration:none">${escapeHtml(phone)}</a>
           <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
             <a href="${escapeHtml(telHref)}" style="padding:4px 8px;background:#111827;color:#fff;border-radius:6px;font-size:11px;text-decoration:none">Call Tech</a>
             <button type="button" class="ml-copy-phone" style="padding:4px 8px;background:#f3f4f6;color:#111827;border:1px solid #e5e7eb;border-radius:6px;font-size:11px;cursor:pointer">Copy Phone</button>
           </div>
         </div>`
      : `<div style="margin-top:6px;font-size:12px;color:#6b7280">No phone number</div>`;
    const serviceBlock = t.service
      ? `<div style="margin-top:8px"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280">Service</div><div style="font-size:13px">${escapeHtml(t.service)}</div></div>`
      : "";
    const areaBlock = t.area
      ? `<div style="margin-top:8px"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280">Area</div><div style="font-size:13px">${escapeHtml(t.area)}</div></div>`
      : "";
    const locationBlock = t.locationUnavailable
      ? `<div style="margin-top:8px;font-size:11px;color:#92400e;background:#fef3c7;border:1px solid #fde68a;padding:4px 6px;border-radius:4px">Location unavailable</div>`
      : "";
    const notesBlock = t.notes
      ? `<div style="margin-top:8px"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280">Notes</div><div style="font-size:12px;white-space:pre-wrap;word-break:break-word">${escapeHtml(t.notes)}</div></div>`
      : "";
    const chatBtn = t.chat_link
      ? `<div style="margin-top:10px"><a href="${escapeHtml(t.chat_link)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:6px 10px;background:#2563eb;color:#fff;border-radius:6px;font-size:12px;text-decoration:none">Quick Chat</a></div>`
      : "";

    root.innerHTML = `<div style="font-weight:600;font-size:14px">${escapeHtml(t.name)}</div>${phoneBlock}${serviceBlock}${areaBlock}${locationBlock}${notesBlock}${chatBtn}`;
    const copyButton = root.querySelector<HTMLButtonElement>(".ml-copy-phone");
    if (copyButton) {
      copyButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(phone);
          else {
            const ta = document.createElement("textarea");
            ta.value = phone; ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
          }
          toast("Phone number copied");
        } catch { toast("Failed to copy"); }
      });
    }
    return root;
  }, []);

  const createLeadPopupElement = useCallback((l: MappedLead, currentSelectedTech: SearchableTech | null) => {
    const root = document.createElement("div");
    root.style.minWidth = "230px";
    root.style.fontFamily = "inherit";
    root.addEventListener("click", (event) => event.stopPropagation());

    const distance = currentSelectedTech?.coords ? haversineMiles(currentSelectedTech.coords, l.coords) : null;
    const zipCity = [l.zipCity, l.zipState].filter(Boolean).join(", ");
    const distanceLine = currentSelectedTech && distance !== null && distance <= RADIUS_MILES
      ? `<div style="font-size:11px;color:#6b7280;margin-top:4px">${distance.toFixed(1)} mi from ${escapeHtml(currentSelectedTech.name)} (approx.)</div>`
      : "";

    root.innerHTML = `
      <div style="font-weight:600;font-size:13px">${escapeHtml(l.customer_name || "Unnamed")}</div>
      <div style="font-size:11px;color:#6b7280">Job ${escapeHtml(l.job_id ?? "")}</div>
      <div style="margin-top:6px;font-size:12px">${escapeHtml(l.customer_phone || "")}</div>
      <div style="font-size:12px"><b>ZIP:</b> ${escapeHtml(l.zip)}${zipCity ? ` <span style="color:#6b7280">· ${escapeHtml(zipCity)}</span>` : ""}</div>
      <div style="margin-top:6px;font-size:12px"><b>Service:</b> ${escapeHtml(l.service_type || "-")}</div>
      <div style="font-size:12px"><b>Status:</b> ${escapeHtml(STATUS_LABELS[l.status] ?? l.status)}</div>
      ${distanceLine}
      <div style="margin-top:6px;font-size:10px;color:#92400e;background:#fef3c7;border:1px solid #fde68a;padding:3px 6px;border-radius:4px;display:inline-block">Approximate ZIP area</div>
      <div><button type="button" class="ml-view-lead" style="margin-top:8px;padding:6px 10px;background:#111827;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer">View Lead</button></div>
    `;
    const viewButton = root.querySelector<HTMLButtonElement>(".ml-view-lead");
    if (viewButton) {
      viewButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        navigate(`/leads/${l.id}`);
      });
    }
    return root;
  }, [navigate]);

  const applyTechMarkerSelection = useCallback((techId: string | null) => {
    activeSelectedTechIdRef.current = techId;
    setPinRenderVersion((version) => version + 1);
  }, []);

  const openTechPopup = useCallback((techId: string, latlng: L.LatLngExpression) => {
    const tech = techDataRefs.current.get(techId);
    if (!tech) return;
    openSharedPopup(latlng, createTechPopupElement(tech));
  }, [createTechPopupElement, openSharedPopup]);

  const openLeadPopup = useCallback((leadId: string, latlng: L.LatLngExpression) => {
    const lead = leadDataRefs.current.get(leadId);
    if (!lead) return;
    openSharedPopup(latlng, createLeadPopupElement(lead, selectedTechRef.current));
  }, [createLeadPopupElement, openSharedPopup]);

  const cancelLeadVisibilityWork = useCallback(() => {
    leadVisibilityGenerationRef.current += 1;
    if (leadVisibilityFrameRef.current !== null) {
      window.cancelAnimationFrame(leadVisibilityFrameRef.current);
      leadVisibilityFrameRef.current = null;
    }
  }, []);

  const scheduleLeadVisibility = useCallback((nextVisibleLeadIds: Set<string>) => {
    desiredVisibleLeadIdsRef.current = new Set(nextVisibleLeadIds);
    if (!pinLayerRef.current) return;
    cancelLeadVisibilityWork();
    const generation = leadVisibilityGenerationRef.current;
    const visibleLeadIds = visibleLeadIdsRef.current;
    const toAdd: string[] = [];
    const toRemove: string[] = [];

    for (const id of nextVisibleLeadIds) {
      if (leadDataRefs.current.has(id) && !visibleLeadIds.has(id)) toAdd.push(id);
    }
    for (const id of visibleLeadIds) {
      if (!nextVisibleLeadIds.has(id) || !leadDataRefs.current.has(id)) toRemove.push(id);
    }

    const applyAllNow = activeSelectedTechIdRef.current === null;
    const batchSize = 40;
    const runBatch = () => {
      if (leadVisibilityGenerationRef.current !== generation) return;
      let processed = 0;
      while ((applyAllNow || processed < batchSize) && (toRemove.length || toAdd.length)) {
        const removeId = toRemove.pop();
        if (removeId) {
          visibleLeadIds.delete(removeId);
          processed += 1;
          continue;
        }

        const addId = toAdd.pop();
        if (addId) {
          if (leadDataRefs.current.has(addId)) visibleLeadIds.add(addId);
          processed += 1;
        }
      }
      setPinRenderVersion((version) => version + 1);
      if (toRemove.length || toAdd.length) {
        leadVisibilityFrameRef.current = window.requestAnimationFrame(runBatch);
      } else {
        leadVisibilityFrameRef.current = null;
      }
    };

    runBatch();
  }, [cancelLeadVisibilityWork]);

  const handleTechMarkerClick = useCallback((techId: string, latlng: L.LatLng) => {
    const tech = techDataRefs.current.get(techId);
    if (!tech) return;
    cancelLeadVisibilityWork();
    selectedTechRef.current = tech;
    applyTechMarkerSelection(techId);
    openTechPopup(techId, latlng);
    setSelectedTechId(techId);
    if (isMobileRef.current) setSheetOpen(true);
  }, [applyTechMarkerSelection, cancelLeadVisibilityWork, openTechPopup]);

  const clearSelectedTech = useCallback(() => {
    cancelLeadVisibilityWork();
    selectedTechRef.current = null;
    applyTechMarkerSelection(null);
    setSelectedTechId(null);
  }, [applyTechMarkerSelection, cancelLeadVisibilityWork]);

  useEffect(() => {
    if (!mapVisible) return;
    if (mapRef.current || !mapEl.current) return;
    setMapReady(false);
    const map = L.map(mapEl.current, { zoomControl: true, preferCanvas: true, markerZoomAnimation: false }).setView([39.5, -98.35], 4);
    const leadPane = map.createPane("marshmallow-lead-pins");
    const techPane = map.createPane("marshmallow-tech-pins");
    leadPane.style.zIndex = "610";
    techPane.style.zIndex = "620";
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);
    const pinLayer = new MapPinCanvasLayer(
      handleTechMarkerClick,
      (leadId, latlng) => openLeadPopup(leadId, latlng),
      (techId) => techDataRefs.current.get(techId)?.phone_number?.trim() ?? "",
    ).addTo(map);
    pinLayerRef.current = pinLayer;
    mapRef.current = map;
    const leadData = leadDataRefs.current;
    const techData = techDataRefs.current;
    const visibleLeadIds = visibleLeadIdsRef.current;
    const desiredVisibleLeadIds = desiredVisibleLeadIdsRef.current;
    mapInvalidateTimeout.current = setTimeout(() => map.invalidateSize(), 50);
    setMapReady(true);
    return () => {
      setMapReady(false);
      cancelLeadVisibilityWork();
      if (mapInvalidateTimeout.current) clearTimeout(mapInvalidateTimeout.current);
      if (leadFocusTimeout.current) clearTimeout(leadFocusTimeout.current);
      if (techFocusTimeout.current) clearTimeout(techFocusTimeout.current);
      mapInvalidateTimeout.current = null;
      leadFocusTimeout.current = null;
      techFocusTimeout.current = null;
      if (mapPopupRef.current) {
        map.closePopup(mapPopupRef.current);
        mapPopupRef.current.remove();
        mapPopupRef.current = null;
      }
      pinLayer.remove();
      map.remove();
      leadData.clear();
      techData.clear();
      visibleLeadIds.clear();
      desiredVisibleLeadIds.clear();
      activeSelectedTechIdRef.current = null;
      mapRef.current = null;
      pinLayerRef.current = null;
      radiusLayer.current = null;
    };
  }, [cancelLeadVisibilityWork, handleTechMarkerClick, mapVisible, openLeadPopup]);

  // Canvas marker data
  useEffect(() => {
    if (!mapReady) return;
    const nextIds = new Set(filteredSearchableTechs.map((t) => t.id));
    for (const id of techDataRefs.current.keys()) {
      if (!nextIds.has(id)) {
        techDataRefs.current.delete(id);
      }
    }
    for (const t of filteredSearchableTechs) {
      techDataRefs.current.set(t.id, t);
    }
    setPinRenderVersion((version) => version + 1);
  }, [filteredSearchableTechs, mapReady]);

  useEffect(() => {
    applyTechMarkerSelection(selectedTechId);
  }, [applyTechMarkerSelection, selectedTechId]);

  useEffect(() => {
    if (!mapReady) return;
    const nextIds = new Set(filteredLeads.map((l) => l.id));

    for (const id of leadDataRefs.current.keys()) {
      if (!nextIds.has(id)) {
        leadDataRefs.current.delete(id);
        visibleLeadIdsRef.current.delete(id);
      }
    }

    for (const l of filteredLeads) {
      leadDataRefs.current.set(l.id, l);
    }
    setPinRenderVersion((version) => version + 1);
  }, [filteredLeads, mapReady]);

  useEffect(() => {
    if (!mapReady) return;
    const visibleLeadIds = new Set((selectedTech ? leadsInRange : filteredLeads).map((l) => l.id));
    if (viewMode === "techs") visibleLeadIds.clear();
    scheduleLeadVisibility(visibleLeadIds);
  }, [filteredLeads, leadsInRange, mapReady, scheduleLeadVisibility, selectedTech, viewMode]);

  useEffect(() => {
    if (!mapReady || !pinLayerRef.current) return;
    const pins: CanvasPin[] = [];
    if (viewMode !== "techs") {
      for (const l of filteredLeads) {
        if (!visibleLeadIdsRef.current.has(l.id)) continue;
        const [lat, lng] = leadMarkerLatLng(l);
        pins.push({ id: l.id, kind: "lead", lat, lng });
      }
    }
    if (viewMode !== "leads") {
      for (const t of filteredTechs) {
        pins.push({
          id: t.id,
          kind: "tech",
          lat: t.coords.latitude,
          lng: t.coords.longitude,
          selected: t.id === activeSelectedTechIdRef.current,
        });
      }
    }
    pinLayerRef.current.setPins(pins);
  }, [filteredLeads, filteredTechs, mapReady, pinRenderVersion, viewMode]);

  // Handle pending customer focus after markers render
  useEffect(() => {
    if (!pendingFocusLeadId) return;
    const map = mapRef.current;
    const lead = leadDataRefs.current.get(pendingFocusLeadId);
    if (!map || !lead) return;
    const latlng = L.latLng(leadMarkerLatLng(lead));
    map.flyTo(latlng, 12, { duration: 0.7 });
    if (leadFocusTimeout.current) clearTimeout(leadFocusTimeout.current);
    leadFocusTimeout.current = setTimeout(() => {
      openLeadPopup(pendingFocusLeadId, latlng);
      leadFocusTimeout.current = null;
    }, 650);
    setPendingFocusLeadId(null);
  }, [mappedLeads, leadsInRange, mapReady, openLeadPopup, pendingFocusLeadId, viewMode]);

  // Selected-tech radius circle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (selectedTech?.coords) {
      const latlng: L.LatLngExpression = [selectedTech.coords.latitude, selectedTech.coords.longitude];
      if (radiusLayer.current) {
        radiusLayer.current.setLatLng(latlng);
      } else {
        radiusLayer.current = L.circle(latlng, {
          radius: RADIUS_METERS,
          color: "#2563eb",
          weight: 1.5,
          fillColor: "#3b82f6",
          fillOpacity: 0.08,
        }).addTo(map);
      }
    } else if (radiusLayer.current) {
      map.removeLayer(radiusLayer.current);
      radiusLayer.current = null;
    }
  }, [selectedTech, mapVisible]);

  useEffect(() => {
    if (!mapVisible) return;
    const map = mapRef.current;
    if (!map) return;
    const t = setTimeout(() => map.invalidateSize(), 60);
    return () => clearTimeout(t);
  }, [mapVisible]);

  const focusLead = (lead: MappedLead) => {
    const map = mapRef.current;
    if (!map) return;
    map.flyTo([lead.coords.latitude, lead.coords.longitude], 11, { duration: 0.6 });
  };

  const customerMatches = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return [] as MappedLead[];
    return mappedLeads
      .filter((l) => (l.customer_name ?? "").toLowerCase().includes(q))
      .slice(0, 25);
  }, [customerSearch, mappedLeads]);

  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => { setActiveIndex(0); }, [customerSearch]);

  const selectCustomer = (lead: MappedLead) => {
    if (!mapVisible) setMapVisible(true);
    if (viewMode === "techs") setViewMode("both");
    if (selectedTech) {
      const inRange = leadsInRange.some((l) => l.id === lead.id);
      if (!inRange) clearSelectedTech();
    }
    setShowSuggestions(false);
    setCustomerSearch(lead.customer_name || "");
    setPendingFocusLeadId(lead.id);
  };

  const performCustomerSearch = () => {
    const q = customerSearch.trim();
    if (!q) return;
    if (customerMatches.length === 0) {
      toast("No customer found");
      return;
    }
    if (customerMatches.length === 1) {
      selectCustomer(customerMatches[0]);
    } else {
      const target = customerMatches[activeIndex] ?? customerMatches[0];
      selectCustomer(target);
    }
  };

  const clearCustomerSearch = () => {
    setCustomerSearch("");
    setShowSuggestions(false);
    setPendingFocusLeadId(null);
  };

  // Technician search
  const techMatches = useMemo(() => {
    const q = techSearch.trim().toLowerCase();
    if (!q) return [] as SearchableTech[];
    return searchableTechs.filter((t) => {
      if (serviceFilter !== "all" && (t.service ?? "") !== serviceFilter) return false;
      return (t.name ?? "").toLowerCase().includes(q);
    }).slice(0, 25);
  }, [techSearch, searchableTechs, serviceFilter]);

  useEffect(() => { setTechActiveIndex(0); }, [techSearch]);

  const selectTech = (tech: SearchableTech) => {
    if (!mapVisible) setMapVisible(true);
    if (viewMode === "leads") setViewMode("both");
    setShowTechSuggestions(false);
    setTechSearch(tech.name || "");
    setSelectedTechId(tech.id);
    selectedTechRef.current = tech;
    if (tech.coords) {
      setPendingFocusTechId(tech.id);
    } else {
      setPendingFocusTechId(null);
      toast("Location unavailable");
    }
    if (isMobile) setSheetOpen(true);
  };

  const performTechSearch = () => {
    const q = techSearch.trim();
    if (!q) return;
    // Exact case-insensitive match wins
    const exact = techMatches.find((t) => (t.name ?? "").toLowerCase() === q.toLowerCase());
    if (exact) { selectTech(exact); return; }
    if (techMatches.length === 0) {
      toast("No technician found");
      return;
    }
    if (techMatches.length === 1) {
      selectTech(techMatches[0]);
    } else {
      setShowTechSuggestions(true);
    }
  };

  const clearTechSearch = () => {
    setTechSearch("");
    setShowTechSuggestions(false);
  };

  const performAreaSearch = () => {
    if (!mapVisible) setMapVisible(true);
    setAreaQuery(areaSearch);
    // Compute matches based on current filters + this area query
    const q = areaSearch.trim().toLowerCase();
    const techs = mappedTechs.filter((t) => {
      if (serviceFilter !== "all" && (t.service ?? "") !== serviceFilter) return false;
      if (!techMatchesState(t, stateFilter)) return false;
      return !q || techMatchesArea(t, q);
    });
    const leads = mappedLeads.filter((l) => {
      if (!leadMatchesState(l, stateFilter)) return false;
      return !q || leadMatchesArea(l, q);
    });
    const pts: L.LatLngExpression[] = [];
    if (viewMode !== "leads") techs.forEach((t) => pts.push([t.coords.latitude, t.coords.longitude]));
    if (viewMode !== "techs") leads.forEach((l) => pts.push([l.coords.latitude, l.coords.longitude]));
    if (pts.length === 0) {
      toast("No technicians or customers found in this area");
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    setTimeout(() => {
      const m = mapRef.current;
      if (!m) return;
      if (pts.length === 1) {
        m.flyTo(pts[0] as L.LatLngTuple, 11, { duration: 0.6 });
      } else {
        m.fitBounds(L.latLngBounds(pts as L.LatLngTuple[]), { padding: [40, 40], maxZoom: 12 });
      }
    }, 60);
  };

  const resetLocationFilters = () => {
    setAreaSearch("");
    setAreaQuery("");
    setStateFilter("all");
    const map = mapRef.current;
    if (map) map.flyTo([39.5, -98.35], 4, { duration: 0.6 });
  };

  useEffect(() => {
    if (!pendingFocusTechId) return;
    const map = mapRef.current;
    const tech = techDataRefs.current.get(pendingFocusTechId) ?? filteredTechs.find((t) => t.id === pendingFocusTechId);
    if (!map || !tech?.coords) return;
    const ll = L.latLng(tech.coords.latitude, tech.coords.longitude);
    map.flyTo(ll, 10, { duration: 0.6 });
    if (techFocusTimeout.current) clearTimeout(techFocusTimeout.current);
    techFocusTimeout.current = setTimeout(() => {
      openTechPopup(pendingFocusTechId, ll);
      techFocusTimeout.current = null;
    }, 650);
    setPendingFocusTechId(null);
  }, [filteredTechs, mapReady, openTechPopup, pendingFocusTechId, viewMode]);


  // Portal-positioned dropdown anchoring
  const customerInputWrapRef = useRef<HTMLDivElement | null>(null);
  const [anchorRect, setAnchorRect] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!showSuggestions) return;
    const update = () => {
      const el = customerInputWrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchorRect({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [showSuggestions, customerSearch]);

  const techInputWrapRef = useRef<HTMLDivElement | null>(null);
  const [techAnchorRect, setTechAnchorRect] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!showTechSuggestions) return;
    const update = () => {
      const el = techInputWrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setTechAnchorRect({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [showTechSuggestions, techSearch]);


  const highlightMatch = (name: string, query: string) => {
    const q = query.trim();
    if (!q) return name;
    const lower = name.toLowerCase();
    const idx = lower.indexOf(q.toLowerCase());
    if (idx < 0) return name;
    return (
      <>
        {name.slice(0, idx)}
        <span className="bg-primary/25 text-primary-foreground rounded px-0.5">{name.slice(idx, idx + q.length)}</span>
        {name.slice(idx + q.length)}
      </>
    );
  };

  const renderSuggestionsDropdown = () => {
    if (!showSuggestions || !customerSearch.trim() || !anchorRect) return null;
    const width = Math.max(360, anchorRect.width);
    return createPortal(
      <div
        role="listbox"
        style={{ position: "fixed", top: anchorRect.top, left: anchorRect.left, width, zIndex: 2000 }}
        className="rounded-md border bg-popover text-popover-foreground shadow-xl overflow-hidden"
        onMouseDown={(e) => e.preventDefault()}
      >
        {customerMatches.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground text-center">
            No matching customers found
          </div>
        ) : (
          <ul className="max-h-72 overflow-y-auto py-1 divide-y divide-border">
            {customerMatches.map((l, i) => {
              const loc = [l.city, l.state].filter(Boolean).join(", ");
              const zip = l.zip_code || l.zip;
              const locLine = [loc, zip].filter(Boolean).join(" ");
              const isActive = i === activeIndex;
              return (
                <li key={l.id} role="option" aria-selected={isActive}>
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => selectCustomer(l)}
                    className={`w-full text-left px-3 py-2.5 text-xs transition-colors ${
                      isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
                    }`}
                  >
                    <div className="font-semibold text-sm text-foreground truncate">
                      {highlightMatch(l.customer_name || "Unnamed", customerSearch)}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                      Job {l.job_id}
                      {locLine ? ` · ${locLine}` : ""}
                    </div>
                    {l.service_type && (
                      <div className="text-[11px] text-muted-foreground/90 truncate mt-0.5">
                        {l.service_type}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>,
      document.body,
    );
  };

  const renderTechSuggestionsDropdown = () => {
    if (!showTechSuggestions || !techSearch.trim() || !techAnchorRect) return null;
    const width = Math.max(360, techAnchorRect.width);
    return createPortal(
      <div
        role="listbox"
        style={{ position: "fixed", top: techAnchorRect.top, left: techAnchorRect.left, width, zIndex: 2000 }}
        className="rounded-md border bg-popover text-popover-foreground shadow-xl overflow-hidden"
        onMouseDown={(e) => e.preventDefault()}
      >
        {techMatches.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground text-center">
            No matching technicians found
          </div>
        ) : (
          <ul className="max-h-72 overflow-y-auto py-1 divide-y divide-border">
            {techMatches.map((t, i) => {
              const isActive = i === techActiveIndex;
              const svcArea = [t.service, t.area].filter(Boolean).join(" · ");
              return (
                <li key={t.id} role="option" aria-selected={isActive}>
                  <button
                    type="button"
                    onMouseEnter={() => setTechActiveIndex(i)}
                    onClick={() => selectTech(t)}
                    className={`w-full text-left px-3 py-2.5 text-xs transition-colors ${
                      isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
                    }`}
                  >
                    <div className="font-semibold text-sm text-foreground truncate">
                      {highlightMatch(t.name || "Unnamed", techSearch)}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                      {t.phone_number ? t.phone_number : "No phone number"}
                    </div>

                    {svcArea && (
                      <div className="text-[11px] text-muted-foreground/90 truncate mt-0.5">
                        {svcArea}
                      </div>
                    )}
                    {t.locationUnavailable && (
                      <div className="text-[11px] text-amber-600 truncate mt-0.5">
                        Location unavailable
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>,
      document.body,
    );
  };




  const SidePanel = (
    <div className="space-y-3">
      {selectedTech ? (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <TechnicianDetailsContent technician={selectedTech} />
              {selectedTech.locationUnavailable && (
                <Badge variant="outline" className="mt-2 text-[11px] text-amber-700 border-amber-300 bg-amber-50">
                  Location unavailable
                </Badge>
              )}
            </div>
            <Button size="icon" variant="ghost" onClick={clearSelectedTech}><X className="h-4 w-4" /></Button>
          </div>
          <div className="border-t pt-3">
            <div className="flex flex-wrap gap-2 mb-2">
              <Badge variant="secondary">Coverage: {RADIUS_MILES} mi</Badge>
              <Badge>{leadsInRange.length} urgent lead{leadsInRange.length === 1 ? "" : "s"} in range</Badge>
            </div>
            <div className="text-xs font-medium text-muted-foreground mb-1">Urgent leads by distance</div>
            {leadsInRange.length === 0 ? (
              <div className="text-xs text-muted-foreground">No urgent leads within {RADIUS_MILES} miles.</div>
            ) : (
              <ul className="space-y-1 max-h-[45vh] overflow-y-auto pr-1">
                {leadsInRange.map((l) => {
                  const svcMatch = selectedTech.service && l.service_type &&
                    l.service_type.toLowerCase().includes(selectedTech.service.toLowerCase());
                  return (
                    <li key={l.id} className="rounded-md border p-2 text-xs hover:bg-muted/40 transition cursor-pointer" onClick={() => focusLead(l)}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium truncate">{l.customer_name || "Unnamed"}</span>
                        <span className="text-muted-foreground shrink-0">{l.distance.toFixed(1)} mi</span>
                      </div>
                      <div className="text-muted-foreground truncate">{l.service_type || "—"}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {svcMatch ? <Badge variant="secondary" className="text-[10px]">Service Match</Badge> : selectedTech.service && <Badge variant="outline" className="text-[10px]">Different Service</Badge>}
                        <Button size="sm" variant="link" className="h-5 px-0 text-[11px]" onClick={(e) => { e.stopPropagation(); navigate(`/leads/${l.id}`); }}>View Lead →</Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      ) : (
        <div className="text-xs text-muted-foreground">
          {filteredTechs.length === 0
            ? "Add technicians in the Technicians section to see coverage."
            : `Select a technician marker to see coverage and matching urgent leads within ${RADIUS_MILES} miles.`}
        </div>
      )}
    </div>
  );


  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-2xl bg-primary/10 flex items-center justify-center">
            <MapPin className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Map View</h1>
            <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
              <Contact className="h-3 w-3" /> {technicianCountLabel} · {urgentLeadCountLabel}
              {selectedTech?.coords && <><span>·</span><span>{leadsInRange.length} within {RADIUS_MILES} mi</span></>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5">
          <Label htmlFor="map-visible-toggle" className="text-[11px] font-medium text-foreground cursor-pointer">Map View</Label>
          <Switch id="map-visible-toggle" checked={mapVisible} onCheckedChange={setMapVisible} />
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{mapVisible ? "On" : "Off"}</span>
        </div>
      </div>

      {mapVisible && (
        <Card className="border-border/60">
          <CardContent className="p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border bg-background p-0.5">
                {([
                  { key: "leads", label: "Urgent Leads" },
                  { key: "techs", label: "Technicians" },
                  { key: "both", label: "Both" },
                ] as const).map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => setViewMode(opt.key)}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                      viewMode === opt.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <Select value={serviceFilter} onValueChange={setServiceFilter}>
                <SelectTrigger className="h-10 w-full text-sm sm:h-8 sm:w-[180px] sm:text-xs">
                  <SelectValue placeholder="All services" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All services</SelectItem>
                  {services.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={stateFilter} onValueChange={setStateFilter}>
                <SelectTrigger className="h-10 w-full text-sm sm:h-8 sm:w-[150px] sm:text-xs">
                  <SelectValue placeholder="All states" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All states</SelectItem>
                  {availableStates.map((code) => (
                    <SelectItem key={code} value={code}>{code} · {US_STATES[code]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1">
                <div className="relative">
                  <MapPin className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={areaSearch}
                    onChange={(e) => setAreaSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); performAreaSearch(); } }}
                    placeholder="City, ZIP, or area"
                    className="h-10 w-full pl-8 pr-8 text-sm sm:h-8 sm:w-[200px] sm:text-xs"
                    aria-label="Area search"
                  />
                  {areaSearch && (
                    <button
                      type="button"
                      onClick={() => { setAreaSearch(""); setAreaQuery(""); }}
                      aria-label="Clear area search"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <Button size="sm" variant="outline" className="h-10 text-sm sm:h-8 sm:text-xs" onClick={performAreaSearch}>Search Area</Button>
                <Button size="sm" variant="ghost" className="h-10 text-sm sm:h-8 sm:text-xs" onClick={resetLocationFilters}>Reset</Button>
              </div>
              <div className="relative" ref={techInputWrapRef}>
                <div className="flex items-center gap-1">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={techSearch}
                      onChange={(e) => { setTechSearch(e.target.value); setShowTechSuggestions(true); }}
                      onFocus={() => { if (techSearch.trim()) setShowTechSuggestions(true); }}
                      onBlur={() => { setTimeout(() => setShowTechSuggestions(false), 150); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (showTechSuggestions && techMatches.length > 0) {
                            const target = techMatches[techActiveIndex] ?? techMatches[0];
                            selectTech(target);
                          } else {
                            performTechSearch();
                          }
                        } else if (e.key === "Escape") {
                          setShowTechSuggestions(false);
                        } else if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setShowTechSuggestions(true);
                          setTechActiveIndex((i) => Math.min(i + 1, Math.max(0, techMatches.length - 1)));
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setShowTechSuggestions(true);
                          setTechActiveIndex((i) => Math.max(i - 1, 0));
                        }
                      }}
                      placeholder="Search technician"
                      className="h-10 w-full pl-8 pr-8 text-sm sm:h-8 sm:w-[220px] sm:text-xs"
                      aria-autocomplete="list"
                      aria-expanded={showTechSuggestions}
                    />
                    {techSearch && (
                      <button
                        type="button"
                        onClick={clearTechSearch}
                        aria-label="Clear technician search"
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <Button size="sm" variant="outline" className="h-10 text-sm sm:h-8 sm:text-xs" onClick={performTechSearch}>Search</Button>
                </div>
              </div>
              {renderTechSuggestionsDropdown()}
              <div className="relative" ref={customerInputWrapRef}>
                <div className="flex items-center gap-1">
                  <div className="relative">
                    <User className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={customerSearch}
                      onChange={(e) => { setCustomerSearch(e.target.value); setShowSuggestions(true); }}
                      onFocus={() => { if (customerSearch.trim()) setShowSuggestions(true); }}
                      onBlur={() => { setTimeout(() => setShowSuggestions(false), 150); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          performCustomerSearch();
                        } else if (e.key === "Escape") {
                          setShowSuggestions(false);
                        } else if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setShowSuggestions(true);
                          setActiveIndex((i) => Math.min(i + 1, Math.max(0, customerMatches.length - 1)));
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setShowSuggestions(true);
                          setActiveIndex((i) => Math.max(i - 1, 0));
                        }
                      }}
                      placeholder="Search customer name"
                      className="h-10 w-full pl-8 pr-8 text-sm sm:h-8 sm:w-[240px] sm:text-xs"
                      aria-autocomplete="list"
                      aria-expanded={showSuggestions}
                    />
                    {customerSearch && (
                      <button
                        type="button"
                        onClick={clearCustomerSearch}
                        aria-label="Clear customer search"
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <Button size="sm" className="h-10 text-sm sm:h-8 sm:text-xs" onClick={performCustomerSearch}>Search</Button>
                </div>
              </div>
              {renderSuggestionsDropdown()}
              <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-blue-500 border border-white" /> Technician</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-500 border border-white" /> Urgent Lead</span>
                {selectedTech && (
                  <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border-2 border-blue-500 bg-blue-500/10" /> {RADIUS_MILES}-mi radius</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {mapVisible && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
          <Card className="overflow-hidden border-border/60">
            <div ref={mapEl} className="h-[calc(100vh-320px)] min-h-[420px] w-full" />
          </Card>

          {isMobile ? (
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
                <SheetHeader><SheetTitle>Technician</SheetTitle></SheetHeader>
                <div className="pt-3">{SidePanel}</div>
              </SheetContent>
            </Sheet>
          ) : (
            <Card className="border-border/60">
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-3">
                  <Contact className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-semibold">Technician</span>
                </div>
                {SidePanel}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {!mapVisible && (
        <Card className="border-border/60">
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            Map is off. Toggle "Map View" on to see technicians and urgent leads on the map.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
