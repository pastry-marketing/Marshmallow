import type { MouseEvent } from "react";
import type { NavigateFunction } from "react-router-dom";

export function openLeadFromClick(
  event: MouseEvent<HTMLElement>,
  leadId: string,
  navigate: NavigateFunction,
) {
  const leadUrl = `/leads/${leadId}`;

  if (event.ctrlKey || event.metaKey) {
    window.open(leadUrl, "_blank", "noopener,noreferrer");
    return;
  }

  navigate(leadUrl);
}
