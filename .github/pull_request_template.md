<!--
  Marshmallow release process: docs/RELEASE_PROCESS.md
  Developer fills in everything above the "Tester" section. Do not merge your own PR.
-->

## What changed & why
<!-- Plain-language summary. What problem does this solve? -->


## How to test it (for the Tester)
<!-- Exact steps on the PREVIEW env, the roles to test as, and what "correct" looks like. -->
- Role(s) to test as:
- Steps:
- Expected result:

## Scope / risk
- Area touched:
- Does it change roles / permissions / RLS?  ☐ No  ☐ Yes → five-layer check done (see CLAUDE.md)
- Rollback plan:  revert this PR and re-Publish

## Developer checklist (Stage 1 exit criteria)
- [ ] `npm run lint` clean
- [ ] `npm test` passing
- [ ] `npm run build` clean
- [ ] Five-layer verification done (if any role/permission/feature change)
- [ ] This PR explains the change and how to test it

---

## Tester sign-off (do NOT merge until this is checked)
- [ ] Feature works as described, on the target role(s), **on preview**
- [ ] A role that should not see it, doesn't
- [ ] No regression on the main lead flow
- [ ] RLS/SQL harness run and all `PASS` (if permissions changed)
- [ ] No new console errors; fresh build loaded
- [ ] **Approved — tested on preview** _(Tester name + date)_:

---

## Admin release (Admin only)
- [ ] Tester sign-off reviewed
- [ ] Merged to `main`
- [ ] **Published** in Lovable
- [ ] `CHANGELOG.md` updated
