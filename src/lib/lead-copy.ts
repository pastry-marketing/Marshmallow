import type { Lead } from "@/types";
import { toast } from "sonner";
import { expandStateAbbreviation } from "./utils";

export const copyTextToClipboard = async (text: string, htmlText?: string) => {
  if (navigator?.clipboard?.write) {
    const data: Record<string, Blob> = {
      "text/plain": new Blob([text], { type: "text/plain" }),
    };
    if (htmlText) {
      data["text/html"] = new Blob([htmlText], { type: "text/html" });
    }
    try {
      const item = new ClipboardItem(data);
      await navigator.clipboard.write([item]);
      return;
    } catch (err) {
      console.error("Clipboard write failed, trying fallback:", err);
    }
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
};

const formatTime = (time?: string | null) => {
  if (!time) return "";
  const [hourRaw, minuteRaw = "00"] = time.split(":");
  const hourNum = Number(hourRaw);
  if (Number.isNaN(hourNum)) return time;
  const ampm = hourNum >= 12 ? "PM" : "AM";
  const hour = hourNum % 12 || 12;
  return `${hour}:${minuteRaw.padStart(2, "0")} ${ampm}`;
};

export const formatLeadSchedule = (lead: Pick<Lead, "scheduled_date" | "scheduled_time_start" | "scheduled_time_end">) => {
  if (!lead.scheduled_date) return "Not scheduled";

  const date = new Date(`${lead.scheduled_date}T12:00:00`);
  const dateText = Number.isNaN(date.getTime()) ? lead.scheduled_date : date.toLocaleDateString();
  const start = formatTime(lead.scheduled_time_start);
  const end = formatTime(lead.scheduled_time_end);

  if (start && end) return `${dateText}, ${start} - ${end}`;
  if (start) return `${dateText}, ${start}`;
  return dateText;
};

export const buildCompleteLeadCopyText = (lead: Lead) => {
  const lines = [
    ["Service Details", lead.service_details || lead.service_type || ""],
    ["Address", expandStateAbbreviation(lead.address) || [lead.city, lead.state, lead.zip_code].filter(Boolean).join(", ")],
    ["Schedule Requirement", lead.customer_schedule_requirements || formatLeadSchedule(lead)],
    ["Quote", lead.quote || ""],
  ];

  return lines
    .filter(([, value]) => String(value || "").trim())
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
};

const convertToPngBlob = (url: string): Promise<Blob> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas context is null"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas conversion to Blob failed"));
      }, "image/png");
    };
    img.onerror = (e) => reject(e);
    img.src = url;
  });
};

export const copyImageToClipboard = async (url: string) => {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    
    let pngBlob = blob;
    if (blob.type !== "image/png") {
      pngBlob = await convertToPngBlob(url);
    }

    if (navigator?.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "image/png": pngBlob,
        }),
      ]);
      toast.success("Image copied to clipboard");
    } else {
      toast.error("Clipboard API not supported in this browser");
    }
  } catch (err) {
    console.error("Failed to copy image:", err);
    toast.error("Failed to copy image due to browser or network restrictions");
  }
};

export const copyImagesToClipboard = async (urls: string[]) => {
  try {
    if (!navigator?.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("Clipboard API not supported in this browser");
    }

    const blobs = await Promise.all(urls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to download image (${response.status})`);
      const blob = await response.blob();
      return blob.type === "image/png" ? blob : convertToPngBlob(url);
    }));
    const clipboardItems = blobs.map((blob) => new ClipboardItem({ "image/png": blob }));
    await navigator.clipboard.write(clipboardItems);
    toast.success(`${urls.length} photos copied to clipboard`);
  } catch (err) {
    console.error("Failed to copy photos:", err);
    toast.error("Failed to copy photos due to browser or network restrictions");
  }
};

