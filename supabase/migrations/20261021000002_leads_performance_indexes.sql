-- Add indexes to dramatically speed up Leads queries

-- Used by `fetchLeads` sorting and Quo Dashboard sorting
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON public.leads (created_at DESC);

-- Used by `LeadsPage` search filtering
CREATE INDEX IF NOT EXISTS idx_leads_status ON public.leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_job_id ON public.leads (job_id);
CREATE INDEX IF NOT EXISTS idx_leads_customer_phone ON public.leads (customer_phone);

-- Used by Customer Service queries
CREATE INDEX IF NOT EXISTS idx_leads_created_by ON public.leads (created_by);
