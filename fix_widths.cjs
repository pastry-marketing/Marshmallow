const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

// Urgent leads table headers
code = code.replace(
  /<th className="px-2 py-1\.5 font-semibold w-\[9%\] text-center">Same<\/th>/,
  '<th className="px-2 py-1.5 font-semibold w-[7%] text-center">Same</th>'
);
code = code.replace(
  /<th className="px-2 py-1\.5 font-semibold w-\[14%\]">Schedule<\/th>/,
  '<th className="px-2 py-1.5 font-semibold w-[22%]">Schedule</th>'
);
code = code.replace(
  /<th className="px-2 py-1\.5 font-semibold text-right w-\[12%\]">Date created<\/th>/,
  '<th className="px-2 py-1.5 font-semibold text-right w-[10%]">Date created</th>'
);
code = code.replace(
  /<th className="px-2 py-1\.5 font-semibold w-\[22%\]">Address<\/th>/,
  '<th className="px-2 py-1.5 font-semibold w-[20%]">Address</th>'
);
code = code.replace(
  /<th className="px-2 py-1\.5 font-semibold w-\[14%\]">Area<\/th>/,
  '<th className="px-2 py-1.5 font-semibold w-[12%]">Area</th>'
);


fs.writeFileSync('src/pages/LeadsPage.tsx', code);
