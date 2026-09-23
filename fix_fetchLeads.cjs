const fs = require('fs');

let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

const regex = /const fetchLeads = useCallback\(async \(isBackground = false\) => \{[\s\S]*?    \}, \[role, user\]\);/m;

const newCode = `const fetchLeads = useCallback(async (isBackground = false) => {
      if (!user || !role) return;
  
      const gen = ++leadsLoadGenRef.current;
      if (!isBackground) setLoading(true);
  
      const PAGE = 1000;
      try {
        let countQuery = supabase.from("leads").select("id", { count: "exact", head: true });
        if (role === "customer_service") countQuery = countQuery.eq("created_by", user.id);
        
        const { count, error: countError } = await countQuery;
        if (countError) throw countError;
        if (gen !== leadsLoadGenRef.current) return;

        const totalLeads = count ?? 0;
        const totalPages = Math.max(1, Math.ceil(totalLeads / PAGE));
        
        const promises = [];
        for (let page = 0; page < totalPages; page++) {
          let query = supabase
            .from("leads")
            .select(LEAD_LIST_COLUMNS)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .range(page * PAGE, page * PAGE + PAGE - 1);
          if (role === "customer_service") query = query.eq("created_by", user.id);
          promises.push(query);
        }

        const results = await Promise.all(promises);
        if (gen !== leadsLoadGenRef.current) return;
        
        const acc = new Map<string, Lead>();
        for (const { data, error } of results) {
          if (error) throw error;
          const rows = (data ?? []) as unknown as Lead[];
          for (const r of rows) if (r?.id) acc.set(r.id, r);
        }

        const full = Array.from(acc.values());
        setLeads(full);
        if (!isBackground) setLoading(false);
        // Persist the complete set so the next visit paints instantly from cache.
        void writeLeadsCache(\`\${role}:\${user.id}\`, full);
      } catch (err) {
        if (gen !== leadsLoadGenRef.current) return;
        toast.error(err instanceof Error ? err.message : "Failed to load leads");
        setLeads([]);
        if (!isBackground) setLoading(false);
      }
    }, [role, user]);`;

code = code.replace(regex, newCode);
fs.writeFileSync('src/pages/LeadsPage.tsx', code);
