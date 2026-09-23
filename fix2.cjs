const fs = require('fs');
let code = fs.readFileSync('src/pages/quo-monitor/QuoDashboardPage.tsx', 'utf8');
code = code.replace(/filteredConversations/g, 'conversations');
fs.writeFileSync('src/pages/quo-monitor/QuoDashboardPage.tsx', code);
