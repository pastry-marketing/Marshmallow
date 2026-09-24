const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

const oldHeaders = `<th className="px-2 py-1.5 font-semibold w-[20%]">Address</th>
                    <th className="px-2 py-1.5 font-semibold w-[12%]">Area</th>
                    <th className="px-2 py-1.5 font-semibold w-[7%] text-center">Same</th>
                    <th className="px-2 py-1.5 font-semibold w-[22%]">Schedule</th>`;
const newHeaders = `<th className="px-2 py-1.5 font-semibold w-[24%]">Address</th>
                    <th className="px-2 py-1.5 font-semibold w-[12%]">Area</th>
                    <th className="px-2 py-1.5 font-semibold w-[26%]">Schedule</th>`;
code = code.replace(oldHeaders, newHeaders);

const regex = /<td className="px-2 py-2 text-center text-muted-foreground">\s*\{nearbyCount > 0 \? \(\s*<span className="inline-flex items-center gap-1 rounded-md bg-red-500\/10 px-1\.5 py-0\.5 text-\[10px\] font-semibold text-red-600 dark:text-red-400">\s*\{nearbyCount\} more\s*<\/span>\s*\) : \(\s*"[^"]+"\s*\)\}\s*<\/td>/g;

if (regex.test(code)) {
    code = code.replace(regex, "");
    fs.writeFileSync('src/pages/LeadsPage.tsx', code);
    console.log("Success");
} else {
    console.log("Regex didn't match");
}
