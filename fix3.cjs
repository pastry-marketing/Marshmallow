const fs = require('fs');
let code = fs.readFileSync('src/pages/quo-monitor/QuoDashboardPage.tsx', 'utf8');

const regex = /queryClient\.setQueryData<ConversationRow\[\]>\([\s\S]*?\["quo-dashboard-conversations"\][\s\S]*?\(old = \[\]\) =>[\s\S]*?old\.map[\s\S]*?\n\s*\);/m;
code = code.replace(regex, 'queryClient.invalidateQueries({ queryKey: ["quo-dashboard-conversations"] });');

fs.writeFileSync('src/pages/quo-monitor/QuoDashboardPage.tsx', code);
