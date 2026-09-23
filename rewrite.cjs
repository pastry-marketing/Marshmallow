const fs = require('fs');
let code = fs.readFileSync('src/pages/quo-monitor/QuoDashboardPage.tsx', 'utf8');

// 1. Remove fetchAllRows import
code = code.replace(/import \{ fetchAllRows \} from "@\/lib\/supabase-paginate";\r?\n/, '');

// 2. Replace useQuery and real-time subscription and filteredConversations block
const queryRegex = /const \{\s*data: rawConversations = \[\],\s*isLoading,\s*isRefetching,\s*refetch,\s*\} = useQuery<ConversationRow\[\]>\(\{[\s\S]*?\/\/ Analytics Computation/m;

if (!queryRegex.test(code)) {
    console.error("Could not find insertion points!");
    process.exit(1);
}

const newCode = `  const {
    data: queryData = { data: [], count: 0 },
    isLoading,
    isRefetching,
    refetch,
  } = useQuery({
    queryKey: [
      "quo-dashboard-conversations",
      currentPage,
      search,
      selectedStatus,
      selectedNumberIds,
      datePreset,
      startDate,
      endDate,
      numberNameFilter,
      customerFilter,
      timeSort,
      showHiddenNumbers,
      phoneNumbers.length,
      hiddenNumberIds.size
    ],
    queryFn: async () => {
      try {
        let query = supabase
          .from("quo_conversations")
          .select("id, quo_conversation_id, customer_name, customer_number, number_id, last_message_preview, last_message_time, last_message_at, created_at, status, current_status", { count: "exact" });

        // 1. Search Filter
        if (search.trim()) {
          const q = \`%\${search.trim()}%\`;
          query = query.or(\`customer_name.ilike.\${q},customer_number.ilike.\${q},last_message_preview.ilike.\${q}\`);
        }

        // 1b. Customer Filter
        if (customerFilter.trim()) {
          const cq = \`%\${customerFilter.trim()}%\`;
          const digits = customerFilter.replace(/\\D/g, "");
          if (digits) {
            query = query.or(\`customer_name.ilike.\${cq},customer_number.ilike.%\${digits}%\`);
          } else {
             query = query.or(\`customer_name.ilike.\${cq},customer_number.ilike.\${cq}\`);
          }
        }

        // 2. Status Filter
        if (selectedStatus !== "all") {
          if (selectedStatus === "unresponded") {
            query = query.or("status.eq.needs_reply,current_status.eq.needs_reply");
          } else {
            query = query.or(\`status.eq.\${selectedStatus},current_status.eq.\${selectedStatus}\`);
          }
        }

        // 3. Numbers Filter
        let filteredPhones = phoneNumbers.filter(p => !isTechLineNumber(p.number || p.display_number || p.name));

        if (!showHiddenNumbers) {
          filteredPhones = filteredPhones.filter(p => !hiddenNumberIds.has(p.id));
        }
        if (selectedNumberIds.length > 0) {
          const selectedSet = new Set(selectedNumberIds);
          filteredPhones = filteredPhones.filter(p => selectedSet.has(p.id));
        }
        if (numberNameFilter.trim()) {
          const lowerF = numberNameFilter.toLowerCase().trim();
          filteredPhones = filteredPhones.filter(p => {
             const name = resolveQuoNumberDisplay(p, numberDisplayMap).name.toLowerCase();
             return name.includes(lowerF);
          });
        }

        const matchingIds = filteredPhones.map(p => p.id);
        if (matchingIds.length > 0) {
          query = query.in("number_id", matchingIds);
        } else {
          return { data: [], count: 0 };
        }

        // 4. Date Filter
        if (datePreset !== "all") {
           let s = null;
           let e = null;
           
           if (datePreset === "today") {
             const todayNYStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
             s = getEasternDateBounds(todayNYStr, "start");
             e = getEasternDateBounds(todayNYStr, "end");
           } else if (datePreset === "yesterday") {
             const y = new Date(); y.setDate(y.getDate() - 1);
             const yNY = y.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
             s = getEasternDateBounds(yNY, "start");
             e = getEasternDateBounds(yNY, "end");
           } else if (datePreset === "last7") {
             const d7 = new Date(); d7.setDate(d7.getDate() - 7);
             const d7Str = d7.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
             s = getEasternDateBounds(d7Str, "start");
           } else if (datePreset === "custom") {
             if (startDate) s = getEasternDateBounds(startDate, "start");
             if (endDate) e = getEasternDateBounds(endDate, "end");
           }

           if (s) query = query.gte("created_at", s.toISOString());
           if (e) query = query.lte("created_at", e.toISOString());
        }

        const from = (currentPage - 1) * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;
        query = query.range(from, to);
        
        query = query.order("created_at", { ascending: timeSort === "asc" });
        query = query.order("id", { ascending: false });

        const { data, count, error } = await query;
        if (error) throw error;

        return { data: data, count: count || 0 };
      } catch (error) {
        console.error("Conversation fetch failed:", error);
        return { data: [], count: 0 };
      }
    },
    refetchInterval: 60000,
  });

  const rawConversations = queryData.data;
  const totalCount = queryData.count;

  useEffect(() => {
    const channel = supabase
      .channel("quo-dashboard-conversations-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "quo_conversations" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["quo-dashboard-conversations"] });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const conversations = useMemo(() => {
    const numbersById = new Map(phoneNumbers.map((number) => [number.id, number]));
    return rawConversations.map((conversation) => ({
      ...conversation,
      quo_phone_numbers: conversation.number_id
        ? numbersById.get(conversation.number_id) ?? null
        : null,
    }));
  }, [phoneNumbers, rawConversations]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;
  const paginatedConversations = conversations;

  // Analytics Computation`;

code = code.replace(queryRegex, newCode);

// Fix total count references in the JSX footer
code = code.replace(/filteredConversations\.length/g, "totalCount");
code = code.replace(/conversations\.length/g, "totalCount");

fs.writeFileSync('src/pages/quo-monitor/QuoDashboardPage.tsx', code);
console.log("Successfully rewrote QuoDashboardPage.tsx");
