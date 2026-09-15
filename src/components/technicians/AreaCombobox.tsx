import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, Loader2, MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

interface AreaSuggestion {
  key: string;
  value: string;
  source: "Saved area" | "U.S. place";
}

const MIN_QUERY_LENGTH = 2;

export function AreaCombobox({ id, value, onChange, placeholder }: Props) {
  const generatedId = useId();
  const inputId = id ?? `area-${generatedId}`;
  const listboxId = `${inputId}-suggestions`;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<AreaSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [contentWidth, setContentWidth] = useState<number | undefined>();

  useEffect(() => {
    const query = value.trim();
    if (query.length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const safeQuery = query.replace(/[%_]/g, " ").replace(/\s+/g, " ").trim();
      if (safeQuery.length < MIN_QUERY_LENGTH) {
        setSuggestions([]);
        setLoading(false);
        return;
      }
      const placeName = safeQuery.split(",")[0]?.trim() || safeQuery;

      const [savedResult, placesResult] = await Promise.all([
        supabase
          .from("technicians")
          .select("area")
          .ilike("area", `%${safeQuery}%`)
          .limit(6),
        supabase
          .from("us_places")
          .select("name, state_code, state_name")
          .ilike("name", `${placeName}%`)
          .order("population", { ascending: false })
          .limit(10),
      ]);

      if (cancelled) return;

      const next: AreaSuggestion[] = [];
      const seen = new Set<string>();
      const add = (suggestion: AreaSuggestion) => {
        const normalized = suggestion.value.trim().toLowerCase();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        next.push(suggestion);
      };

      for (const row of savedResult.data ?? []) {
        const area = String(row.area ?? "").trim();
        add({ key: `saved:${area}`, value: area, source: "Saved area" });
      }
      for (const row of placesResult.data ?? []) {
        const name = String(row.name ?? "").trim();
        const state = String(row.state_code ?? row.state_name ?? "").trim();
        const area = [name, state].filter(Boolean).join(", ");
        add({ key: `place:${area}`, value: area, source: "U.S. place" });
      }

      setSuggestions(next.slice(0, 12));
      setActiveIndex(0);
      setLoading(false);
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value]);

  const openSuggestions = () => {
    setContentWidth(anchorRef.current?.getBoundingClientRect().width);
    if (value.trim().length >= MIN_QUERY_LENGTH) setOpen(true);
  };

  const selectArea = (area: string) => {
    onChange(area);
    setOpen(false);
    setActiveIndex(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openSuggestions();
      setActiveIndex((current) => Math.min(current + 1, Math.max(suggestions.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      openSuggestions();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter" && open && suggestions[activeIndex]) {
      event.preventDefault();
      selectArea(suggestions[activeIndex].value);
      return;
    }
    if (event.key === "Escape") setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div ref={anchorRef} className="relative">
          <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={inputId}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              setOpen(event.target.value.trim().length >= MIN_QUERY_LENGTH);
              setActiveIndex(0);
            }}
            onClick={openSuggestions}
            onFocus={openSuggestions}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={open && suggestions[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
            className="pl-9 pr-9"
          />
          {loading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
        </div>
      </PopoverAnchor>
      <PopoverPrimitive.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={16}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="z-[70] overflow-hidden rounded-md border bg-popover p-0 text-popover-foreground shadow-md outline-none"
        style={{ width: contentWidth }}
      >
        <div id={listboxId} role="listbox" className="max-h-64 overflow-y-auto p-1">
          {suggestions.map((suggestion, index) => (
            <button
              id={`${listboxId}-${index}`}
              key={suggestion.key}
              type="button"
              role="option"
              aria-selected={activeIndex === index}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectArea(suggestion.value)}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm ${
                activeIndex === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
              }`}
            >
              <MapPin className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">{suggestion.value}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{suggestion.source}</span>
              {value.trim().toLowerCase() === suggestion.value.toLowerCase() && <Check className="h-3.5 w-3.5 shrink-0" />}
            </button>
          ))}
          {!loading && suggestions.length === 0 && (
            <p className="px-3 py-3 text-xs text-muted-foreground">No suggestions found. You can keep the area you typed.</p>
          )}
        </div>
      </PopoverPrimitive.Content>
    </Popover>
  );
}
