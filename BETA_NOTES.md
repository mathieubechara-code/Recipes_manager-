# Meal Planner 1.7 Beta 1

Stabilization beta built from the V1.6 / cache 1630 baseline.

## Audit fixes
- Prevents a non-core UI wiring failure from blocking Firebase startup/login.
- Adds visible startup diagnostics instead of a dead Connect button.
- Wraps automatic household reconnect errors and returns to the Connect screen cleanly.
- Removes legacy recipe-photo rendering from recipe cards; stored legacy photoUrl data is left untouched.
- Cleans remaining visible Kitchen Week wording to Meal Planner, while preserving internal Firestore/localStorage/schema identifiers for backward compatibility.
- Keeps the existing Apple Shortcut default name `Kitchen Week to Reminders` so current iPhones do not break.
- Shopping review now separates Ingredient and Quantity, supports manual editing, Ignore/Use, Remove, and manual multi-row merge.

## Compatibility
No Firestore migration is required. Do not replace `firebase-config.js` or `firestore.rules`. Existing household hashes, recipe documents, schedule documents, backups, and App Check remain compatible.


## Beta 2 changes

- Added three weekly generation patterns: daily variety, 2-day batches (A A / B B / C C / D), and 3-meal 2/2/3 batching.
- Added optional dinner-repeat mode. Dinner repetition may relax dinner anti-repeat constraints, but repeated dinners are kept in consecutive blocks; a single eligible dinner can fill the week.
- Locked meals are always preserved by the weekly planner.
- Shopping Review now has a floating Merge control and compact icon-only remove action.
- Shopping Review drafts auto-save locally per household/week and also have an explicit Save draft button.
- Reopening Review resumes the saved draft and reconciles it with the current week's generated ingredients: new ingredients are added, removed schedule ingredients disappear, ignored/manual naming is preserved, and quantities refresh unless the user manually edited the quantity.
- Sending the reviewed list to Reminders clears that week's saved draft.


## Beta 3 — Shopping Review sorting
- Shopping Review is automatically sorted A–Z by ingredient name.
- Ignored rows are kept after active rows.
- Renaming or merging an item automatically re-sorts the list.
- Adjacent ingredient names that look similar (for example Oil / Olive oil) receive a subtle visual highlight so the user can decide whether to merge them.
