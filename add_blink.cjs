const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

const helperFunc = `function isTodayOrTomorrow(scheduleText: string | null | undefined): boolean {
  if (!scheduleText) return false;
  const lower = scheduleText.toLowerCase();
  
  if (lower.includes("today") || lower.includes("tomorrow") || lower.includes("tonight") || lower.includes("tmrw")) return true;
  
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  
  const checkDate = (d: Date) => {
    const m = d.getMonth();
    const dt = d.getDate();
    const p1 = new RegExp(\`\\\\b\${months[m]}[a-z]*\\\\s*\${dt}\\\\b\`, 'i');
    const p2 = new RegExp(\`\\\\b\${dt}(?:st|nd|rd|th)?\\\\s*\${months[m]}[a-z]*\\\\b\`, 'i');
    const p3 = new RegExp(\`\\\\b\${m + 1}/\${dt}\\\\b\`, 'i');
    return p1.test(lower) || p2.test(lower) || p3.test(lower);
  };
  
  return checkDate(today) || checkDate(tomorrow);
}

export default function LeadsPage`;

if (!code.includes("function isTodayOrTomorrow")) {
    code = code.replace(/export default function LeadsPage/, helperFunc);
}

const regexTd = /<CopyableCell\s*text=\{formatSchedule\(l\.customer_schedule_requirements\)\}\s*defaultWidth=\{false\}\s*className="text-muted-foreground"\s*truncate=\{false\}\s*\/>/g;

const newTd = `<CopyableCell 
                          text={formatSchedule(l.customer_schedule_requirements)} 
                          defaultWidth={false} 
                          className={isTodayOrTomorrow(l.customer_schedule_requirements) ? "text-red-500 font-bold animate-pulse" : "text-muted-foreground"} 
                          truncate={false} 
                        />`;

if (regexTd.test(code)) {
    code = code.replace(regexTd, newTd);
    fs.writeFileSync('src/pages/LeadsPage.tsx', code);
    console.log("Success");
} else {
    console.log("Regex didn't match");
}
