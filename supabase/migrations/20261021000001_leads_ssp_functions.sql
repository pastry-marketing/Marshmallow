-- Migration to support Server-Side Pagination on LeadsPage

-- 1. Get status counts for the tabs
CREATE OR REPLACE FUNCTION get_lead_status_counts()
RETURNS TABLE (
  status text,
  count bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT status, COUNT(*) 
  FROM leads 
  GROUP BY status;
$$;

-- 2. Get the CX Awaiting Response Leads (Urgent Leads that have a recent customer message without agent reply)
CREATE OR REPLACE FUNCTION get_cx_awaiting_urgent_leads()
RETURNS SETOF leads
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH urgent_leads AS (
    SELECT l.*, 
           -- Strip everything except digits from customer_phone and take last 10
           RIGHT(REGEXP_REPLACE(l.customer_phone, '\D', '', 'g'), 10) as normalized_phone
    FROM leads l
    WHERE l.status IN ('urgent_job', 're_check', 'warranty_claim', 'urgent_parts', 'check_parts_status', 'reschedule', 'customer_not_responding', 'parts_received')
      AND l.cs_tag IS NULL
      AND l.customer_phone IS NOT NULL
  )
  SELECT ul.*
  FROM urgent_leads ul
  JOIN quo_conversations c ON 
       (RIGHT(REGEXP_REPLACE(c.customer_number, '\D', '', 'g'), 10) = ul.normalized_phone)
  WHERE c.last_customer_message_at IS NOT NULL
    AND (c.last_agent_message_at IS NULL OR c.last_customer_message_at > c.last_agent_message_at);
END;
$$;

GRANT EXECUTE ON FUNCTION get_lead_status_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION get_lead_status_counts() TO service_role;
GRANT EXECUTE ON FUNCTION get_cx_awaiting_urgent_leads() TO authenticated;
GRANT EXECUTE ON FUNCTION get_cx_awaiting_urgent_leads() TO service_role;
