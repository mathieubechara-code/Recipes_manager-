# Apple Shortcut setup

Shortcut name: **Kitchen Week to Reminders**

Create the following actions in order:

1. Accept **Text** as Shortcut Input.
2. Split `Shortcut Input` by **New Lines**.
3. Repeat with each item in the split list.
4. Add a new Reminder whose title is `Repeat Item` to your chosen shopping list.
5. End Repeat.

The web app copies lines such as:

```text
ground beef — 1000 g
tomato passata — 700 ml
onion — 2
```

Then it launches the Shortcut using clipboard input:

```text
shortcuts://run-shortcut?name=Kitchen%20Week%20to%20Reminders&input=clipboard
```

You can change the Shortcut name in the app's Settings as long as the name matches exactly on the iPhone.
