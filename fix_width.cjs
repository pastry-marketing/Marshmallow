const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');
code = code.replace('<th className="px-2 py-1.5 font-semibold w-[26%]">Schedule</th>', '<th className="px-2 py-1.5 font-semibold w-[25%]">Schedule</th>');
fs.writeFileSync('src/pages/LeadsPage.tsx', code);
