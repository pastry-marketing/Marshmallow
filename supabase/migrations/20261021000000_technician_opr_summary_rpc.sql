-- Migration to quickly group technicians by opr_code
-- This replaces a client-side .select() that pulled all rows.

CREATE OR REPLACE FUNCTION get_opr_codes_summary()
RETURNS TABLE (
  opr_code text,
  count bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT opr_code, COUNT(*) 
  FROM technicians 
  WHERE opr_code IS NOT NULL 
  GROUP BY opr_code;
$$;

-- Give public access (RLS still applies if it was wrapped in a security definer, 
-- but this is a simple query on a table that likely has RLS, so it runs with invoker privileges).
GRANT EXECUTE ON FUNCTION get_opr_codes_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION get_opr_codes_summary() TO service_role;

-- Add an index to speed up the count and grouping
CREATE INDEX IF NOT EXISTS idx_technicians_opr_code ON technicians (opr_code);

-- Also add an index for `is_active` sorting, which is used by the main paginated query
CREATE INDEX IF NOT EXISTS idx_technicians_is_active ON technicians (is_active);
