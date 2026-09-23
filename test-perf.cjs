const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const supabaseUrl = env.match(/VITE_SUPABASE_URL=(.*)/)[1];
const supabaseKey = env.match(/VITE_SUPABASE_ANON_KEY=(.*)/)[1];
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  console.time('totalCount');
  await supabase.from("technicians").select("id", { count: "exact", head: true });
  console.timeEnd('totalCount');

  console.time('oprCodes');
  await supabase.from("technicians").select("opr_code").not("opr_code", "is", null);
  console.timeEnd('oprCodes');

  console.time('fetchPage');
  await supabase.from("technicians").select("id").order("is_active", { ascending: false }).range(0, 99);
  console.timeEnd('fetchPage');
  
  console.time('search_technicians RPC');
  await supabase.rpc('search_technicians', { _q: 'a', _limit: 100, _offset: 0 });
  console.timeEnd('search_technicians RPC');
}
run();
