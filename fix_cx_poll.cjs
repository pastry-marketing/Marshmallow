const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadsPage.tsx', 'utf8');

const regex = /useEffect\(\(\) => \{\s*if \(urgentTableLeads\.length === 0\) \{\s*setUrgentNeedsCxReply\(\[\]\);\s*return;\s*\}\s*let isMounted = true;\s*async function checkCxReplies\(\) \{[\s\S]*?\}\s*void checkCxReplies\(\);\s*return \(\) => \{\s*isMounted = false;\s*\};\s*\}, \[urgentTableLeads\]\);/;

const newCode = `  const checkCxReplies = useCallback(async () => {
    if (urgentTableLeads.length === 0) {
      setUrgentNeedsCxReply([]);
      return;
    }

    const phoneToLeads = new Map<string, UrgentRow[]>();
    for (const lead of urgentTableLeads) {
      if (!lead.customer_phone) continue;
      const normalized = normalizePhoneE164(lead.customer_phone) || lead.customer_phone.replace(/\\D/g, "").slice(-10);
      if (!normalized) continue;
      const arr = phoneToLeads.get(normalized) || [];
      arr.push(lead);
      phoneToLeads.set(normalized, arr);
    }

    const phones = Array.from(phoneToLeads.keys());
    if (phones.length === 0) {
      setUrgentNeedsCxReply([]);
      return;
    }

    const { data, error } = await supabase
      .from("quo_conversations")
      .select("customer_number,last_customer_message_at,last_agent_message_at")
      .in("customer_number", phones);

    if (error) {
      console.error("Failed to check CX replies", error);
      return;
    }

    const needsReplyIds = new Set<string>();

    for (const row of data || []) {
      const cTime = row.last_customer_message_at ? new Date(row.last_customer_message_at).getTime() : 0;
      const aTime = row.last_agent_message_at ? new Date(row.last_agent_message_at).getTime() : 0;

      if (cTime > aTime) {
        const matchingLeads = phoneToLeads.get(row.customer_number || "") || [];
        for (const ml of matchingLeads) {
          needsReplyIds.add(ml.id);
        }
      }
    }

    setUrgentNeedsCxReply(urgentTableLeads.filter(l => needsReplyIds.has(l.id)));
  }, [urgentTableLeads]);

  useEffect(() => {
    void checkCxReplies();
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void checkCxReplies();
    };
    const id = setInterval(tick, 5000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkCxReplies();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkCxReplies]);`;

code = code.replace(regex, newCode);
fs.writeFileSync('src/pages/LeadsPage.tsx', code);
