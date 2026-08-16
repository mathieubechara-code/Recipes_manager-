# Kitchen Week

A mobile-first shared recipe, weekly meal-planning, anti-repetition, and shopping-list app designed for two iPhone users. It is a static HTML/CSS/JS site suitable for GitHub Pages, with Cloud Firestore for live sync.

## Architecture choice

This build chooses **Firebase / Cloud Firestore** rather than GitHub-as-datastore because the stated goal includes true live shared updates between two people. Firestore snapshot listeners update both phones without refresh. The site itself remains static and can be hosted for free on GitHub Pages.

Defaults chosen for the open questions:

- Shared anti-repeat history (appropriate when both people usually eat the planned dinner).
- Dinner-only UI for v1. The stored schedule already includes a `meal` field, so lunch can be added later without changing the data model.
- One shared shopping list export. Either phone can generate the same weekly list.
- Vanilla HTML/CSS/JS, avoiding a build tool and keeping GitHub Pages deployment simple.
- Shared household phrase + anonymous Firebase Auth. The phrase is SHA-256 hashed in the browser and is not stored as plaintext.

## 1. Firebase setup

1. Create a Firebase project.
2. Add a **Web app** in Project Settings.
3. Copy the Firebase config object into `firebase-config.js`.
4. In **Authentication → Sign-in method**, enable **Anonymous** authentication.
5. Create a **Cloud Firestore** database.
6. In Firestore → Rules, replace the rules with the contents of `firestore.rules`, then publish.
7. Do not commit unrelated private Firebase admin credentials. The web config in `firebase-config.js` is a client configuration, not an admin secret.

The app uses Firebase JavaScript SDK modules from Google's CDN, so there is no npm/build step.

### Privacy model

This is deliberately lightweight for a two-person household. Each device signs in anonymously. A household phrase is hashed locally into an unguessable-looking household ID. Firestore rules require a device UID to create its own membership record under that household before it can read/write household data. Anyone who learns the phrase can join the household, so choose a long unique phrase and do not reuse an important password.

For stronger access control, replace anonymous/shared-secret access with two individual Firebase Authentication accounts.

## 2. GitHub Pages deployment

1. Create a GitHub repository and copy all files in this folder to the repository root.
2. Commit and push to `main`.
3. In **Settings → Pages**, choose **Deploy from a branch**.
4. Choose branch `main` and folder `/ (root)`.
5. Save. GitHub will publish the static site.

The included `.nojekyll` file keeps the repository as a plain static site.

## 3. Connect the second person

1. Open the same GitHub Pages URL on both iPhones.
2. Enter the **same household phrase** on both phones.
3. Add the site to the Home Screen if desired.
4. Changes to recipes, settings, and weekly schedule sync through Firestore in real time.

If Safari storage is cleared, the device gets a new anonymous Firebase UID. Entering the same household phrase again creates a fresh membership record and reconnects to the same household data.

## 4. Anti-repetition behavior

When **Suggest for me** is tapped for a date, the app:

1. Excludes recipes eaten on that **same day-of-week** during the previous N weeks (default 4).
2. Optionally excludes any recipe already scheduled elsewhere in the same Monday–Sunday week.
3. Randomly chooses from the remaining eligible recipes.
4. If every recipe is excluded, it reports that no recipe is eligible; manual override remains available.
5. Saves auto-picked meals with status `suggested`.

Manual recipe selection is always allowed even when a recipe would be algorithmically excluded, and manual selections are saved as `confirmed`.

Settings are shared between both users.

## 5. Shopping list format

Ingredients for all meals in the visible week are merged by normalized **ingredient name + unit**. Numeric quantities with matching units are summed. Different units remain separate lines rather than attempting unsafe unit conversion.

Example JSON export:

```json
{
  "schema": "kitchen-week.shopping.v1",
  "weekStart": "2026-08-17",
  "generatedAt": "2026-08-16T10:30:00.000Z",
  "items": [
    {
      "name": "ground beef",
      "quantity": 1000,
      "unit": "g",
      "displayQuantity": "1000 g"
    },
    {
      "name": "tomato passata",
      "quantity": 700,
      "unit": "ml",
      "displayQuantity": "700 ml"
    }
  ]
}
```

For Apple Reminders, the app exports a simpler newline text list, for example:

```text
ground beef — 1000 g
tomato passata — 700 ml
onion — 2
```

## 6. Apple Shortcut: “Kitchen Week to Reminders”

Create this Shortcut once on each iPhone. Use the exact same shortcut name shown in the app Settings (default: **Kitchen Week to Reminders**).

Recommended action sequence in Apple Shortcuts:

1. **Get Text from Shortcut Input** (or simply use `Shortcut Input` as text, depending on the current Shortcuts UI).
2. **Split Text** — separator: **New Lines**.
3. **Repeat with Each** item from the split result.
4. Inside the repeat, add **Add New Reminder**.
5. Set the reminder title to **Repeat Item**.
6. Choose the desired Reminders list, e.g. **Shopping**.
7. End Repeat.

The web app first copies the newline shopping list to the clipboard, then opens:

```text
shortcuts://run-shortcut?name=Kitchen%20Week%20to%20Reminders&input=clipboard
```

Using clipboard input avoids putting a potentially large shopping list directly into the URL. Apple Shortcuts officially supports `input=clipboard` for the `run-shortcut` URL scheme.

If iOS asks for permission the first time the Shortcut writes to Reminders, allow it.

## 7. Data shape

Firestore is organized as:

```text
households/{householdId}/members/{firebaseAnonymousUid}
households/{householdId}/recipes/{recipeId}
households/{householdId}/schedule/{YYYY-MM-DD_dinner}
households/{householdId}/settings/shared
```

Recipe document shape:

```json
{
  "name": "Pasta alla Bolognese",
  "tags": ["italian", "meat", "pasta"],
  "prepTimeMin": 45,
  "photoUrl": "https://example.com/photo.jpg",
  "ingredients": [
    { "name": "ground beef", "quantity": 500, "unit": "g" },
    { "name": "tomato passata", "quantity": 700, "unit": "ml" }
  ],
  "instructions": "..."
}
```

Schedule document shape:

```json
{
  "date": "2026-08-17",
  "meal": "dinner",
  "recipeId": "firestore-document-id",
  "status": "confirmed"
}
```

## 8. Local testing

Because the app uses ES modules, serve it over HTTP instead of double-clicking `index.html`:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Current scope / easy next extensions

- Month calendar view.
- Lunch + dinner slots.
- Ingredient unit conversions (requires explicit conversion rules).
- Image uploads using Firebase Storage rather than photo URLs.
- Individual user accounts and audit trail.
- Recipe import from URLs.
