const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

const regexLoop = /const noteSummaryByLead: Record<string, \{ general: string; cs: string; processor: string \}> = \{\};\s*let noteRows: LeadNoteExportRow\[\] = \[\];\s*const chunkSize = 100;\s*for \(let i = 0; i < leadIdsToExport\.length; i \+= chunkSize\) \{[\s\S]*?\}\s*\(noteRows as LeadNoteExportRow\[\] \| null\)\?\.forEach\(\(note\) => \{[\s\S]*?\}\);/g;

const newLoop = `const noteSummaryByLead: Record<string, { general: string; cs: string; processor: string }> = {};
        const historyByLead: Record<string, string> = {};
        let noteRows: LeadNoteExportRow[] = [];
        let historyRows: any[] = [];
        const chunkSize = 100;
  
        for (let i = 0; i < leadIdsToExport.length; i += chunkSize) {
          const chunk = leadIdsToExport.slice(i, i + chunkSize);
          const [notesRes, logsRes] = await Promise.all([
            supabase
              .from("lead_notes")
              .select("lead_id, note_type, content, user_id, user_name, created_at")
              .in("lead_id", chunk)
              .order("created_at", { ascending: true }),
            supabase
              .from("activity_logs")
              .select("target_id, user_name, action, created_at, details")
              .eq("target_type", "lead")
              .in("target_id", chunk)
              .order("created_at", { ascending: true })
          ]);
  
          if (notesRes.error) {
            toast.error(\`Failed to prepare note export: \${notesRes.error.message}\`);
            setIsExporting(false);
            return;
          }
          if (notesRes.data) {
            noteRows = noteRows.concat(notesRes.data as LeadNoteExportRow[]);
          }
          if (logsRes.data) {
            historyRows = historyRows.concat(logsRes.data);
          }
        }
  
        (noteRows as LeadNoteExportRow[] | null)?.forEach((note) => {
          const key = note.note_type;
          if (!noteSummaryByLead[note.lead_id]) {
            noteSummaryByLead[note.lead_id] = { general: "", cs: "", processor: "" };
          }
          noteSummaryByLead[note.lead_id][key as keyof typeof noteSummaryByLead[string]] += \`[\${new Date(note.created_at || "").toLocaleString()}] \${note.user_name || "Unknown"}: \${note.content}\\n\\n\`;
        });

        historyRows.forEach((log) => {
          if (!historyByLead[log.target_id]) {
            historyByLead[log.target_id] = "";
          }
          
          let actionText = log.action;
          if (log.action === "status_changed" || log.action === "status_change") {
            let parsed = null;
            if (typeof log.details === "string") {
              try { parsed = JSON.parse(log.details); } catch(e) {}
            } else {
              parsed = log.details;
            }
            if (parsed && parsed.status_to) {
              actionText = \`changed status to \${parsed.status_to}\`;
            }
          } else if (log.action === "created") {
            actionText = "created the lead";
          }
          
          historyByLead[log.target_id] += \`[\${new Date(log.created_at || "").toLocaleString()}] \${log.user_name || "Unknown"} \${actionText}\\n\`;
        });`;

const regexExport = /"Customer Phone": lead\?\.customer_phone,\s*"Customer Address": lead\?\.address,\s*"Date Created": lead\?\.created_at \? new Date\(lead\.created_at\)\.toLocaleString\(\) : "",/g;
const newExport = `"Customer Phone": lead?.customer_phone,
            "Customer Landline": lead?.customer_landline || "",
            "Customer Address": lead?.address,
            "Date Created": lead?.created_at ? new Date(lead.created_at).toLocaleString() : "",
            "Direction": lead?.direction || "",
            "Number Name": lead?.number_name || "",
`;

const regexNotes = /"Processor Notes": noteSummaryByLead\[id\]\?\.processor \|\| "",/g;
const newNotes = `"Processor Notes": noteSummaryByLead[id]?.processor || "",
            "History": historyByLead[id] || "",`;

if (regexLoop.test(code)) {
    code = code.replace(regexLoop, newLoop);
    code = code.replace(regexExport, newExport);
    code = code.replace(regexNotes, newNotes);
    fs.writeFileSync('src/pages/LeadsPage.tsx', code);
    console.log("Success");
} else {
    console.log("Regex didn't match");
}
