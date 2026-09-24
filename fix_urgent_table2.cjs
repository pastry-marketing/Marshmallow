const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

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
