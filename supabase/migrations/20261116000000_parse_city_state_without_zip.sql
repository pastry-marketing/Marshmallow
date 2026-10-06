-- City/state-only intake and shorthand labels such as "Area Dallas, TX" are
-- still useful locations even when the address has no ZIP. Resolve the state
-- suffix independently of ZIP, and remove the intake marker from the city.

CREATE OR REPLACE FUNCTION public.parse_lead_location(
  _address text,
  _city text,
  _state text,
  _zip text
)
RETURNS TABLE (city text, state text, zip_code text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  WITH stripped AS (
    SELECT btrim(coalesce(_address, '')) AS address
  ),
  cleaned AS (
    SELECT btrim(regexp_replace(
      regexp_replace(address, '\s*,?\s*(USA|U\.S\.A\.|United States|US)\s*[,.]?\s*$', '', 'i'),
      '[\s,.]+$', ''
    )) AS address
      FROM stripped
  ),
  parsed AS (
    SELECT c.address,
      nullif((regexp_match(c.address, '([0-9]{5})(?:[- ][0-9]{4})?\s*[,.]*$'))[1], '') AS parsed_zip,
      COALESCE(
        CASE
          WHEN upper(nullif((regexp_match(c.address, '(?:\m|,)\s*([A-Za-z]{2})[\s,.]*[0-9]{5}(?:[- ][0-9]{4})?\s*[,.]*$'))[1], ''))
               IN ('AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
                   'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
                   'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
                   'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
                   'WI','WY','DC')
          THEN upper(nullif((regexp_match(c.address, '(?:\m|,)\s*([A-Za-z]{2})[\s,.]*[0-9]{5}(?:[- ][0-9]{4})?\s*[,.]*$'))[1], ''))
        END,
        public.us_state_code(nullif((regexp_match(
          c.address,
          '[ ,]+([A-Za-z][A-Za-z .]*?)[\s,.]+[0-9]{5}(?:[- ][0-9]{4})?\s*[,.]*$'
        ))[1], '')),
        public.us_state_code(nullif((regexp_match(
          c.address,
          '[,\s]+([A-Za-z]{2}|[A-Za-z]+(?:\s+[A-Za-z]+){0,3})[,.]*$'
        ))[1], ''))
      ) AS parsed_state,
      public.lead_address_city(c.address) AS parsed_city
    FROM cleaned c
  )
  SELECT
    COALESCE(
      NULLIF(btrim(regexp_replace(coalesce(_city, ''), '[,.]+$', '')), ''),
      NULLIF(btrim(regexp_replace(coalesce(p.parsed_city, ''), '^(area)\s+', '', 'i')), '')
    ),
    COALESCE(public.us_state_code(_state), p.parsed_state),
    CASE WHEN btrim(coalesce(_zip, '')) ~ '^[0-9]{5}(-[0-9]{4})?$'
         THEN btrim(_zip) ELSE p.parsed_zip END
  FROM parsed p;
$fn$;

DO $$
DECLARE
  v_spread record;
BEGIN
  SELECT * INTO v_spread FROM public.compute_all_lead_coverage();
  RAISE NOTICE 'City/state-only coverage refreshed: % checked, % good, % normal, % bad, % unlocated.',
    v_spread.checked, v_spread.good, v_spread.normal, v_spread.bad, v_spread.unlocated;
END $$;
