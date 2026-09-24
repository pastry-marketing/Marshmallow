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

code = code.replace(/export default function LeadsPage/, helperFunc);

const oldHeaders = `<th className="px-2 py-1.5 font-semibold w-[20%]">Address</th>
                    <th className="px-2 py-1.5 font-semibold w-[12%]">Area</th>
                    <th className="px-2 py-1.5 font-semibold w-[7%] text-center">Same</th>
                    <th className="px-2 py-1.5 font-semibold w-[22%]">Schedule</th>`;
const newHeaders = `<th className="px-2 py-1.5 font-semibold w-[24%]">Address</th>
                    <th className="px-2 py-1.5 font-semibold w-[12%]">Area</th>
                    <th className="px-2 py-1.5 font-semibold w-[25%]">Schedule</th>`;
code = code.replace(oldHeaders, newHeaders);

const oldTd = `<td className="px-2 py-2 text-center text-muted-foreground">
                          {nearbyCount > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400">
                              {nearbyCount} more
                            </span>
                          ) : (
                            "?""
                          )}
                        </td>
                        <CopyableCell text={formatSchedule(l.customer_schedule_requirements)} defaultWidth={false} className="text-muted-foreground" truncate={false} />`;
                        
const newTd = `<CopyableCell 
                          text={formatSchedule(l.customer_schedule_requirements)} 
                          defaultWidth={false} 
                          className={isTodayOrTomorrow(l.customer_schedule_requirements) ? "text-red-500 font-bold animate-pulse" : "text-muted-foreground"} 
                          truncate={false} 
                        />`;
code = code.replace(oldTd, newTd);

fs.writeFileSync('src/pages/LeadsPage.tsx', code);
