const fs = require('fs');
let code = fs.readFileSync('src/pages/TechniciansPage.tsx', 'utf8');

// Change default page size
code = code.replace(/const DEFAULT_PAGE_SIZE: PageSizeOption = 200;/, 'const DEFAULT_PAGE_SIZE: PageSizeOption = 100;');

// Update codesSummaryQuery
const regex = /queryFn:\s*async\s*\(\)\s*=>\s*\{\s*try\s*\{\s*let\s*q\s*=\s*supabase\.from[\s\S]*?totalWithCode:\s*0\s*\};\s*\}\s*\},/m;

const newQueryFn = `queryFn: async () => {
        try {
          const { data, error } = await supabase.rpc("get_opr_codes_summary");
          if (error || !data) return { codes: [], totalWithCode: 0 };
          
          let totalWithCode = 0;
          let codes = data.map(r => {
             const c = Number(r.count);
             totalWithCode += c;
             return { code: r.opr_code, count: c };
          });
          
          if (visibility.mode === "own") {
             codes = codes.filter(c => c.code === visibility.oprCode);
             totalWithCode = codes.reduce((sum, c) => sum + c.count, 0);
          }
          
          codes.sort((a, b) => a.code.localeCompare(b.code));
          return { codes, totalWithCode };
        } catch (err) {
          console.error(err);
          return { codes: [], totalWithCode: 0 };
        }
      },`;

code = code.replace(regex, newQueryFn);

fs.writeFileSync('src/pages/TechniciansPage.tsx', code);
