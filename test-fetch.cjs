const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const supabaseUrl = env.match(/VITE_SUPABASE_URL=(.*)/)[1];
const supabaseKey = env.match(/VITE_SUPABASE_ANON_KEY=(.*)/)[1];
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  console.time('Sequential Fetch');
  for (let page = 0; page < 4; page++) {
    await supabase.from("leads").select("id, status").order("id").range(page * 1000, page * 1000 + 999);
  }
  console.timeEnd('Sequential Fetch');

  console.time('Parallel Fetch');
  const promises = [];
  for (let page = 0; page < 4; page++) {
    promises.push(supabase.from("leads").select("id, status").order("id").range(page * 1000, page * 1000 + 999));
  }
  await Promise.all(promises);
  console.timeEnd('Parallel Fetch');
}
run();
