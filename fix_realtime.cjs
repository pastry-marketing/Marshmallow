const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

const regex = /if \(\(payload\.eventType === "INSERT" \|\| payload\.eventType === "UPDATE"\) && newRow\?\.status === "urgent_job"\) \{\s*refreshUrgentRef\.current\?\.\(\);\s*\}/;

const newCode = `if (
              newRow?.status === "urgent_job" || 
              oldRow?.status === "urgent_job"
            ) {
              refreshUrgentRef.current?.();
            }`;

code = code.replace(regex, newCode);
fs.writeFileSync('src/pages/LeadsPage.tsx', code);
