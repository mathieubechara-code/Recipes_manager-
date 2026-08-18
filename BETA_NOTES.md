# Meal Planner V1.7 Beta 9

## Shopping Review undo

- Adds a compact **Undo** control beside **Reset** in Shopping Review.
- Undo reverses the last review-list change: ingredient rename, quantity edit, Ignore/Use, manual merge, or Reset.
- Keeps up to 30 undo steps for the currently open review.
- Undo history intentionally resets when the review is reopened or the Not sent / All view changes. Autosaved draft behavior is unchanged.
- Reset still returns the review to the list generated from the current meal plan and can itself be undone while the review remains open.

Cache version: `1700b9`.
