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
