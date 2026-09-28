import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows } from '@/lib/supabase-paginate';

interface DuplicateCandidate {
  id: string;
  customer_name: string;
  customer_phone: string | null;
}

export function useDuplicatePhoneCheck(phone: string, excludeLeadId?: string) {
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [duplicateLeadName, setDuplicateLeadName] = useState('');
  const [checking, setChecking] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Need at least 7 digits to check
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7) {
      setIsDuplicate(false);
      setDuplicateLeadName('');
      return;
    }

    setChecking(true);
    debounceRef.current = setTimeout(async () => {
      try {
        // Narrow the query first, then normalize client-side for an exact comparison.
        const trailingDigits = digits.slice(-4);
        // Page through every candidate instead of taking a fixed slice: an
        // unordered `.limit(50)` could leave the real duplicate out of the
        // result set for a common digit ending (1111, 0000...), and the check
        // would then report no duplicate at all.
        const data = await fetchAllRows<DuplicateCandidate>((from, to) =>
          supabase
            .from('leads')
            .select('id, customer_name, customer_phone')
            .neq('status', 'cancelled')
            .ilike('customer_phone', `%${trailingDigits}%`)
            .order('id', { ascending: true })
            .range(from, to),
        );

        const match = data.find((lead: DuplicateCandidate) => {
          if (excludeLeadId && lead.id === excludeLeadId) return false;
          const leadDigits = (lead.customer_phone || '').replace(/\D/g, '');

          const getSig = (d: string) => {
            if (d.startsWith('1') && d.length >= 11) {
              return d.slice(1);
            }
            return d;
          };

          const s1 = getSig(leadDigits);
          const s2 = getSig(digits);

          if (s1 === s2) return true;
          if (s1.length >= 10 && s2.length >= 10) {
            return s1.slice(0, 10) === s2.slice(0, 10);
          }
          return false;
        });

        if (match) {
          setIsDuplicate(true);
          setDuplicateLeadName(match.customer_name);
        } else {
          setIsDuplicate(false);
          setDuplicateLeadName('');
        }
      } catch {
        // ignore errors
      }
      setChecking(false);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [phone, excludeLeadId]);

  return { isDuplicate, duplicateLeadName, checking };
}
