import { Lead } from "@/types";
import { format } from "date-fns";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ChevronRight, MapPin, Phone } from "lucide-react";
import StatusBadge from "./StatusBadge";
import { useAuth } from "@/contexts/AuthContext";
import { formatUSPhone } from "@/lib/phone";
import { openLeadFromClick } from "@/lib/lead-navigation";
import { useNavigate } from "react-router-dom";

interface LeadTableProps {
  leads: Lead[];
}

export default function LeadTable({ leads }: LeadTableProps) {
  const { role } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="rounded-xl border bg-card/50 backdrop-blur-sm shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[100px]">Job ID</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((lead) => (
              <TableRow 
                key={lead.id}
                className="group cursor-pointer hover:bg-muted/50 transition-colors"
                onClick={(event) => openLeadFromClick(event, lead.id, navigate)}
              >
                <TableCell className="font-medium text-muted-foreground">{lead.job_id}</TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{lead.customer_name}</span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                      <Phone className="h-3 w-3" />
                      {lead.customer_phone || !lead.customer_landline
                        ? formatUSPhone(lead.customer_phone || "")
                        : `${formatUSPhone(lead.customer_landline)} (Landline)`}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-start gap-1 text-sm max-w-[200px]">
                    <MapPin className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <span className="truncate">{lead.address}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={lead.status} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {format(new Date(lead.created_at), "MMM d, yyyy")}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity">
                    View <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {leads.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No leads found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
