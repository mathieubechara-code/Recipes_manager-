# Meal Planner V1.7 Beta 8

## Shopping / Reminders
- Removed the X/remove action from Shopping Review. Use **Ignore / Use** only.
- Added shared per-week reminder-send tracking. When **Send not sent to Reminders** is tapped, the source ingredient fingerprints represented in that send are marked as sent in the shared settings document.
- Review defaults to **Not sent** and can switch to **All**. Sent rows are visibly tagged **Sent to Reminders** and shown read-only in All view.
- Newly scheduled meals appear as unsent even when older meals from the same week were already sent.
- If a previously sent meal changes recipe, people count, ingredient wording, quantity, or unit, its source fingerprint changes and it becomes unsent again.
- Exact-match app merging remains; sent and unsent source entries are never auto-merged together.
- **App merged** and **You merged** badges remain.
- Ignore remains visible and reversible; ignored rows are excluded from the Reminders handoff.

## Important behavior
The web app cannot receive a completion callback from the Apple Shortcut. “Sent to Reminders” therefore means the list was handed off when the Send button was tapped. If the Shortcut is cancelled after launch, that item may need a future manual “mark not sent” control.
