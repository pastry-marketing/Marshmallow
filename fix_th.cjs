const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

const regex = /<th className="px-2 py-1\.5 font-semibold w-\[22%\]">Address<\/th>\s*<th className="px-2 py-1\.5 font-semibold w-\[14%\]">Area<\/th>\s*<th className="px-2 py-1\.5 font-semibold w-\[9%\] text-center">Same<\/th>\s*<th className="px-2 py-1\.5 font-semibold w-\[14%\]">Schedule<\/th>/g;

const newHeaders = `<th className="px-2 py-1.5 font-semibold w-[22%]">Address</th>
                    <th className="px-2 py-1.5 font-semibold w-[14%]">Area</th>
                    <th className="px-2 py-1.5 font-semibold w-[23%]">Schedule</th>`;

if (regex.test(code)) {
    code = code.replace(regex, newHeaders);
    fs.writeFileSync('src/pages/LeadsPage.tsx', code);
    console.log("Success");
} else {
    console.log("Regex didn't match");
}
