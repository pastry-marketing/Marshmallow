const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

const regex = /<th className="px-2 py-1\.5 font-semibold w-\[20%\]">Address<\/th>\s*<th className="px-2 py-1\.5 font-semibold w-\[12%\]">Area<\/th>\s*<th className="px-2 py-1\.5 font-semibold w-\[7%\] text-center">Same<\/th>\s*<th className="px-2 py-1\.5 font-semibold w-\[22%\]">Schedule<\/th>/g;

const newHeaders = `<th className="px-2 py-1.5 font-semibold w-[24%]">Address</th>
                    <th className="px-2 py-1.5 font-semibold w-[14%]">Area</th>
                    <th className="px-2 py-1.5 font-semibold w-[23%]">Schedule</th>`;

if (regex.test(code)) {
    code = code.replace(regex, newHeaders);
    fs.writeFileSync('src/pages/LeadsPage.tsx', code);
    console.log("Success");
} else {
    console.log("Regex didn't match");
}
