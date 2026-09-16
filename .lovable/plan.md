# Lead Card Cleanup

## Goal
Restructure the existing lead card into a compact, aligned single-column layout while keeping the current palette, font, permissions, and behavior.

## Changes
- Remove the profile/avatar icon and increase the customer name by two visual size steps.
- Organize the main details in this order: customer name, phone, service type, service details, address, and photos.
- Present phone, service, service details, and address as simple icon-and-text rows with subtle separators instead of boxes or tags.
- Keep the phone number as plain text, not a telephone link, and remove the visible “Contact” label.
- Add compact copy actions for phone, service type, service details, and address.
- Show photos as consistent compact `Photo 1`, `Photo 2`, and similar controls without a separate Photos heading or enclosing panel.
- Place all note types available to the signed-in role in one horizontal row; each remains independently expandable and retains its existing note indicators and permissions.
- Move the lead tag and status controls below the notes row.
- Consolidate edit and remaining actions into a clean bottom action area, preserving all role restrictions and existing workflows.
- Keep necessary operational metadata and alerts, but reduce decorative containers and align spacing, icons, labels, and controls consistently.

## Verification
- Check the card at desktop and narrow widths for text wrapping, note-row overflow, alignment, and control accessibility.
- Verify copy actions, photo controls, notes, tag/status changes, and edit actions still work.
- Confirm the app builds without errors.

## Technical notes
- Limit implementation to the lead-card presentation and its existing helper UI.
- Reuse the current semantic design tokens, Inter typography, Button controls, and existing permission/business logic.
- Preserve the hoisted note popovers so realtime updates do not reset the typing cursor.
