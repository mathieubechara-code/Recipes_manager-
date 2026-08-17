# Meal Planner V1.7 Beta 6

## Shopping behavior
- Removed all automatic/fuzzy ingredient-name merging.
- Shopping now keeps one generated row per scheduled recipe ingredient.
- Only explicit user-selected **Merge selected** combines rows.
- Alphabetical sorting remains for review, but rows no longer re-sort while the user is typing. A renamed row re-sorts after the edit field is committed/blurred.
- Automatic similar-name highlighting was removed.
- Manual merge still combines compatible quantities because the user explicitly requested that merge.

## Preserved
- Review autosave/resume, Ignore/Use, Reset to generated list, and manual merge.
- V1.7 planner modes and consecutive dinner-repeat option.
- Firebase/App Check configuration unchanged.
