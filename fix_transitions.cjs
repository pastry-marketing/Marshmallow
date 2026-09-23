const fs = require('fs');

// 1. TableRow
let tableCode = fs.readFileSync('src/components/ui/table.tsx', 'utf8');
tableCode = tableCode.replace(
  /"border-b transition-colors hover:bg-muted\/50 data-\[state=selected\]:bg-muted",/,
  '"border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted animate-in fade-in duration-300",'
);
fs.writeFileSync('src/components/ui/table.tsx', tableCode);

// 2. LeadCard
let leadCardCode = fs.readFileSync('src/components/leads/LeadCard.tsx', 'utf8');
leadCardCode = leadCardCode.replace(
  /<motion\.div\n\s*className="h-full relative"/,
  '<motion.div\n      initial={{ opacity: 0, y: 5 }}\n      animate={{ opacity: 1, y: 0 }}\n      transition={{ duration: 0.3 }}\n      className="h-full relative"'
);
fs.writeFileSync('src/components/leads/LeadCard.tsx', leadCardCode);
