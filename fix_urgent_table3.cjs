const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

const regex = /<td className="px-2 py-2 text-center text-muted-foreground">\s*\{nearbyCount > 0 \? \(\s*<span className="inline-flex items-center gap-1 rounded-md bg-red-500\/10 px-1\.5 py-0\.5 text-\[10px\] font-semibold text-red-600 dark:text-red-400">\s*\{nearbyCount\} more\s*<\/span>\s*\) : \(\s*"[^"]+"\s*\)\}\s*<\/td>\s*<CopyableCell text=\{formatSchedule\(l\.customer_schedule_requirements\)\} defaultWidth=\{false\} className="text-muted-foreground" truncate=\{false\} \/>/g;

const newTd = `<CopyableCell 
                          text={formatSchedule(l.customer_schedule_requirements)} 
                          defaultWidth={false} 
                          className={isTodayOrTomorrow(l.customer_schedule_requirements) ? "text-red-500 font-bold animate-pulse" : "text-muted-foreground"} 
                          truncate={false} 
                        />`;

if (regex.test(code)) {
    code = code.replace(regex, newTd);
    fs.writeFileSync('src/pages/LeadsPage.tsx', code);
    console.log("Success");
} else {
    console.log("Regex didn't match");
}
