const fs = require('fs');

let code = fs.readFileSync('src/pages/SchedulePage.tsx', 'utf8');

// Replace standard tr with animated tr
code = code.replace(
  /<tr key=\{lead.id\} className="group border-b/g,
  '<tr key={lead.id} className="group border-b animate-in fade-in duration-300'
);

fs.writeFileSync('src/pages/SchedulePage.tsx', code);
