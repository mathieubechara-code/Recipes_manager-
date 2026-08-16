import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';

import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';

import {
  getFirestore,
  collection,
  doc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

import {
  initializeAppCheck,
  ReCaptchaV3Provider
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app-check.js';

import { firebaseConfig } from './firebase-config.js';


const els = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map(el => [el.id, el])
);

const appReady =
  firebaseConfig.apiKey &&
  !firebaseConfig.apiKey.startsWith('YOUR_');

let firebaseApp;
let auth;
let db;

let householdId = localStorage.getItem('kw_household') || '';
let currentUser = null;

let recipes = [];
let schedule = [];

let settings = {
  repeatWeeks: 4,
  avoidSameWeek: true,
  shortcutName: 'Kitchen Week to Reminders'
};

let weekStart = startOfWeek(new Date());
let currentSlotDate = null;
let unsubscribers = [];


/* -------------------------------------------------------
   Helpers
------------------------------------------------------- */

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => {
    els.toast.classList.remove('show');
  }, 2200);
}


function startOfWeek(date) {
  const d = new Date(date);

  d.setHours(0, 0, 0, 0);

  const day = d.getDay();
  const delta = day === 0 ? -6 : 1 - day;

  d.setDate(d.getDate() + delta);

  return d;
}


function addDays(date, n) {
  const d = new Date(date);

  d.setDate(d.getDate() + n);

  return d;
}


function iso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');

  return `${y}-${m}-${d}`;
}


function parseIsoLocal(s) {
  const [y, m, d] = s.split('-').map(Number);

  return new Date(y, m - 1, d);
}


function sameDate(a, b) {
  return iso(a) === iso(b);
}


function fmtDay(d) {
  return d.toLocaleDateString(undefined, {
    weekday: 'short'
  });
}


function fmtMonthDay(d) {
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
}


function fmtWeekTitle(start) {
  const end = addDays(start, 6);

  return `${start.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })} – ${end.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })}`;
}


function normalizeText(s = '') {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}


function escapeHtml(s = '') {
  return s.replace(/[&<>'"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[c]));
}


function safePhoto(url = '') {
  try {
    const u = new URL(url);

    return ['http:', 'https:'].includes(u.protocol)
      ? u.href
      : '';
  } catch {
    return '';
  }
}


function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}


async function sha256(text) {
  const bytes = new TextEncoder().encode(text.trim());

  const hash = await crypto.subtle.digest(
    'SHA-256',
    bytes
  );

  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}


/* -------------------------------------------------------
   Firebase + App Check
------------------------------------------------------- */

function initFirebase() {
  if (!appReady) {
    els.connectStatus.textContent =
      'Firebase is not configured yet. See README.md → Setup.';

    return;
  }

  firebaseApp = initializeApp(firebaseConfig);

  /*
   * Firebase App Check
   *
   * The Site Key below is PUBLIC.
   * Never place the reCAPTCHA Secret Key here.
   */
  initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaV3Provider(
      '6LfC1YgtAAAAAHwn27yg9V-ItHS-kLDaOc9oXo0v'
    ),
    isTokenAutoRefreshEnabled: true
  });

  auth = getAuth(firebaseApp);
  db = getFirestore(firebaseApp);

  onAuthStateChanged(auth, async user => {
    currentUser = user;

    if (!user) {
      return;
    }

    if (householdId) {
      await attachHousehold(householdId);
    }
  });

  signInAnonymously(auth).catch(err => {
    els.connectStatus.textContent =
      `Firebase sign-in failed: ${err.message}`;
  });
}


/* -------------------------------------------------------
   Household connection
------------------------------------------------------- */

async function connectHousehold() {
  if (!appReady) {
    return toast(
      'Configure Firebase first — see README.md'
    );
  }

  const phrase =
    els.householdPhrase.value.trim();

  if (phrase.length < 8) {
    return toast(
      'Use a household phrase of at least 8 characters'
    );
  }

  if (!currentUser) {
    await signInAnonymously(auth);
  }

  householdId = (
    await sha256(`kitchen-week:${phrase}`)
  ).slice(0, 40);

  localStorage.setItem(
    'kw_household',
    householdId
  );

  await attachHousehold(householdId);

  els.householdPhrase.value = '';

  toast('Kitchen connected');
}


async function attachHousehold(id) {
  if (!currentUser || !db) {
    return;
  }

  unsubscribers.forEach(fn => fn());
  unsubscribers = [];

  const memberRef = doc(
    db,
    'households',
    id,
    'members',
    currentUser.uid
  );

  await setDoc(
    memberRef,
    {
      householdId: id,
      joinedAt: serverTimestamp()
    },
    {
      merge: true
    }
  );

  const recipeCol = collection(
    db,
    'households',
    id,
    'recipes'
  );

  const scheduleCol = collection(
    db,
    'households',
    id,
    'schedule'
  );

  const settingsRef = doc(
    db,
    'households',
    id,
    'settings',
    'shared'
  );

  unsubscribers.push(
    onSnapshot(
      recipeCol,
      snap => {
        recipes = snap.docs
          .map(d => ({
            id: d.id,
            ...d.data()
          }))
          .sort((a, b) =>
            a.name.localeCompare(b.name)
          );

        renderAll();
      },
      firestoreError
    )
  );

  unsubscribers.push(
    onSnapshot(
      scheduleCol,
      snap => {
        schedule = snap.docs.map(d => ({
          id: d.id,
          ...d.data()
        }));

        renderAll();
      },
      firestoreError
    )
  );

  unsubscribers.push(
    onSnapshot(
      settingsRef,
      snap => {
        if (snap.exists()) {
          settings = {
            ...settings,
            ...snap.data()
          };
        } else {
          setDoc(
            settingsRef,
            settings,
            {
              merge: true
            }
          );
        }

        syncSettingsForm();
        renderAll();
      },
      firestoreError
    )
  );

  els.connectPanel.hidden = true;
  els.mainApp.hidden = false;
}


function firestoreError(err) {
  console.error(err);

  toast(`Sync error: ${err.message}`);
}


/* -------------------------------------------------------
   Rendering
------------------------------------------------------- */

function renderAll() {
  if (els.mainApp.hidden) {
    return;
  }

  renderWeek();
  renderRecipes();
  renderShopping();
  renderTagFilter();
}


function scheduleFor(date) {
  return schedule.find(
    s =>
      s.date === iso(date) &&
      s.meal === 'dinner'
  );
}


function recipeById(id) {
  return recipes.find(r => r.id === id);
}


/* -------------------------------------------------------
   Week / Calendar
------------------------------------------------------- */

function renderWeek() {
  els.weekTitle.textContent =
    fmtWeekTitle(weekStart);

  els.weekGrid.innerHTML = '';

  for (let i = 0; i < 7; i++) {
    const date =
      addDays(weekStart, i);

    const slot =
      scheduleFor(date);

    const recipe =
      slot &&
      recipeById(slot.recipeId);

    const card =
      document.createElement('button');

    card.type = 'button';

    card.className =
      `day-card${
        sameDate(date, new Date())
          ? ' today'
          : ''
      }`;

    const status =
      slot?.status === 'suggested'
        ? '<span class="status-pill status-suggested">Suggested</span>'
        : slot
          ? '<span class="status-pill status-confirmed">Confirmed</span>'
          : '';

    card.innerHTML = `
      <div class="day-date">
        <div class="day-name">
          ${fmtDay(date)}
        </div>

        <div class="day-num">
          ${date.getDate()}
        </div>
      </div>

      <div>
        ${
          recipe
            ? `
              <div class="meal-name">
                ${escapeHtml(recipe.name)}
              </div>

              <div class="meal-meta">
                Dinner
                ${
                  recipe.prepTimeMin
                    ? ` · ${recipe.prepTimeMin} min`
                    : ''
                }
              </div>

              ${status}
            `
            : `
              <div class="empty-meal">
                Choose dinner
              </div>
            `
        }
      </div>

      <div aria-hidden="true">
        ›
      </div>
    `;

    card.addEventListener(
      'click',
      () => openSlot(date)
    );

    els.weekGrid.appendChild(card);
  }
}


/* -------------------------------------------------------
   Recipes
------------------------------------------------------- */

function renderRecipes() {
  const q =
    normalizeText(
      els.recipeSearch.value
    );

  const tag =
    els.tagFilter.value;

  const filtered =
    recipes.filter(r => {
      const hay =
        normalizeText(
          `${r.name} ${(r.tags || []).join(' ')}`
        );

      return (
        (!q || hay.includes(q)) &&
        (!tag || (r.tags || []).includes(tag))
      );
    });

  els.recipeGrid.innerHTML = '';

  if (!filtered.length) {
    els.recipeGrid.innerHTML =
      `<div class="empty-state">${
        recipes.length
          ? 'No recipes match those filters.'
          : 'Your recipe box is empty. Add the first recipe.'
      }</div>`;

    return;
  }

  filtered.forEach(r => {
    const card =
      document.createElement('article');

    card.className =
      'recipe-card';

    const photo =
      safePhoto(r.photoUrl || '');

    card.innerHTML = `
      ${
        photo
          ? `
            <img
              class="recipe-photo"
              src="${escapeHtml(photo)}"
              alt=""
              loading="lazy"
            >
          `
          : ''
      }

      <div class="recipe-body">
        <h3>
          ${escapeHtml(r.name)}
        </h3>

        <div class="tags">
          ${(r.tags || [])
            .map(
              t =>
                `<span class="tag">${escapeHtml(t)}</span>`
            )
            .join('')}
        </div>

        <p class="muted small">
          ${(r.ingredients || []).length}
          ingredients
          ${
            r.prepTimeMin
              ? ` · ${r.prepTimeMin} min`
              : ''
          }
        </p>

        <div class="recipe-card-footer">
          <span class="muted small">
            ${escapeHtml(
              (r.instructions || '').slice(
                0,
                80
              )
            )}
            ${
              (r.instructions || '').length > 80
                ? '…'
                : ''
            }
          </span>

          <button class="secondary">
            Edit
          </button>
        </div>
      </div>
    `;

    card
      .querySelector('button')
      .addEventListener(
        'click',
        () => openRecipe(r)
      );

    els.recipeGrid.appendChild(card);
  });
}


function renderTagFilter() {
  const current =
    els.tagFilter.value;

  const tags =
    [...new Set(
      recipes.flatMap(
        r => r.tags || []
      )
    )].sort();

  els.tagFilter.innerHTML =
    `<option value="">All tags</option>` +
    tags
      .map(
        t =>
          `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`
      )
      .join('');

  if (tags.includes(current)) {
    els.tagFilter.value =
      current;
  }
}


/* -------------------------------------------------------
   Shopping list
------------------------------------------------------- */

function getWeekSlots(
  includeSuggested = true
) {
  const start =
    iso(weekStart);

  const end =
    iso(addDays(weekStart, 6));

  return schedule.filter(
    s =>
      s.date >= start &&
      s.date <= end &&
      s.meal === 'dinner' &&
      (
        includeSuggested ||
        s.status === 'confirmed'
      )
  );
}


function mergedShoppingItems() {
  const map = new Map();

  for (const slot of getWeekSlots(true)) {
    const recipe =
      recipeById(slot.recipeId);

    if (!recipe) {
      continue;
    }

    for (
      const ing of recipe.ingredients || []
    ) {
      const name =
        normalizeText(ing.name);

      if (!name) {
        continue;
      }

      const unit =
        normalizeText(
          ing.unit || ''
        );

      const key =
        `${name}|${unit}`;

      const qtyNum =
        Number(ing.quantity);

      if (!map.has(key)) {
        map.set(key, {
          name: ing.name.trim(),
          unit:
            ing.unit?.trim() || '',
          quantity:
            Number.isFinite(qtyNum)
              ? 0
              : null,
          quantities: []
        });
      }

      const item =
        map.get(key);

      if (
        item.quantity !== null &&
        Number.isFinite(qtyNum)
      ) {
        item.quantity += qtyNum;
      } else if (
        ing.quantity !== '' &&
        ing.quantity != null
      ) {
        item.quantity = null;

        item.quantities.push(
          String(ing.quantity)
        );
      }
    }
  }

  return [...map.values()]
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name)
    );
}


function formatQty(item) {
  if (item.quantity !== null) {
    const n =
      Number.isInteger(item.quantity)
        ? item.quantity
        : Math.round(
            item.quantity * 100
          ) / 100;

    return `${n}${
      item.unit
        ? ` ${item.unit}`
        : ''
    }`;
  }

  return `${
    item.quantities.join(' + ')
  }${
    item.unit
      ? ` ${item.unit}`
      : ''
  }`.trim();
}


function shoppingText() {
  return mergedShoppingItems()
    .map(
      i =>
        `${i.name}${
          formatQty(i)
            ? ` — ${formatQty(i)}`
            : ''
        }`
    )
    .join('\n');
}


function shoppingPayload() {
  return {
    schema:
      'kitchen-week.shopping.v1',

    weekStart:
      iso(weekStart),

    generatedAt:
      new Date().toISOString(),

    items:
      mergedShoppingItems().map(i => ({
        name: i.name,
        quantity: i.quantity,
        unit: i.unit,
        displayQuantity:
          formatQty(i)
      }))
  };
}


function renderShopping() {
  const items =
    mergedShoppingItems();

  els.shoppingList.innerHTML =
    items.length
      ? items
          .map(
            i => `
              <div class="shopping-item">
                <span>
                  ${escapeHtml(i.name)}
                </span>

                <span class="shopping-qty">
                  ${escapeHtml(formatQty(i))}
                </span>
              </div>
            `
          )
          .join('')
      : `
        <div class="empty-state">
          Schedule meals this week to build a shopping list.
        </div>
      `;

  els.shoppingJson.textContent =
    JSON.stringify(
      shoppingPayload(),
      null,
      2
    );
}


/* -------------------------------------------------------
   Recipe editor
------------------------------------------------------- */

function addIngredientRow(
  ing = {
    name: '',
    quantity: '',
    unit: ''
  }
) {
  const row =
    document.createElement('div');

  row.className =
    'ingredient-row';

  row.innerHTML = `
    <input
      class="ing-name"
      placeholder="ingredient"
      value="${escapeHtml(String(ing.name || ''))}"
    >

    <input
      class="ing-qty"
      inputmode="decimal"
      placeholder="qty"
      value="${escapeHtml(String(ing.quantity ?? ''))}"
    >

    <input
      class="ing-unit"
      placeholder="unit"
      value="${escapeHtml(String(ing.unit || ''))}"
    >

    <button
      type="button"
      aria-label="Remove ingredient"
    >
      ×
    </button>
  `;

  row
    .querySelector('button')
    .addEventListener(
      'click',
      () => row.remove()
    );

  els.ingredientRows.appendChild(row);
}


function openRecipe(
  recipe = null
) {
  els.recipeDialogTitle.textContent =
    recipe
      ? 'Edit recipe'
      : 'Add recipe';

  els.recipeId.value =
    recipe?.id || '';

  els.recipeName.value =
    recipe?.name || '';

  els.prepTime.value =
    recipe?.prepTimeMin ?? '';

  els.photoUrl.value =
    recipe?.photoUrl || '';

  els.recipeTags.value =
    (recipe?.tags || []).join(', ');

  els.instructions.value =
    recipe?.instructions || '';

  els.ingredientRows.innerHTML =
    '';

  (
    recipe?.ingredients?.length
      ? recipe.ingredients
      : [{}]
  ).forEach(addIngredientRow);

  els.deleteRecipe.hidden =
    !recipe;

  els.recipeDialog.showModal();
}


async function saveRecipe(ev) {
  ev.preventDefault();

  const id =
    els.recipeId.value;

  const ingredients =
    [
      ...els.ingredientRows.querySelectorAll(
        '.ingredient-row'
      )
    ]
      .map(row => {
        const raw =
          row
            .querySelector('.ing-qty')
            .value
            .trim();

        const parsed =
          Number(
            raw.replace(',', '.')
          );

        return {
          name:
            row
              .querySelector('.ing-name')
              .value
              .trim(),

          quantity:
            raw === ''
              ? ''
              : Number.isFinite(parsed)
                ? parsed
                : raw,

          unit:
            row
              .querySelector('.ing-unit')
              .value
              .trim()
        };
      })
      .filter(i => i.name);

  const data = {
    name:
      els.recipeName.value.trim(),

    tags:
      els.recipeTags.value
        .split(',')
        .map(normalizeText)
        .filter(Boolean),

    prepTimeMin:
      Number(els.prepTime.value) || 0,

    photoUrl:
      els.photoUrl.value.trim(),

    ingredients,

    instructions:
      els.instructions.value.trim(),

    updatedAt:
      serverTimestamp()
  };

  if (!data.name) {
    return;
  }

  if (id) {
    await updateDoc(
      doc(
        db,
        'households',
        householdId,
        'recipes',
        id
      ),
      data
    );
  } else {
    await addDoc(
      collection(
        db,
        'households',
        householdId,
        'recipes'
      ),
      {
        ...data,
        createdAt:
          serverTimestamp()
      }
    );
  }

  els.recipeDialog.close();

  toast('Recipe saved');
}


async function deleteCurrentRecipe() {
  const id =
    els.recipeId.value;

  if (!id) {
    return;
  }

  if (
    !confirm(
      'Delete this recipe? Scheduled slots using it will become empty-looking until reassigned.'
    )
  ) {
    return;
  }

  await deleteDoc(
    doc(
      db,
      'households',
      householdId,
      'recipes',
      id
    )
  );

  els.recipeDialog.close();

  toast('Recipe deleted');
}


/* -------------------------------------------------------
   Meal scheduling
------------------------------------------------------- */

function openSlot(date) {
  currentSlotDate =
    date;

  els.slotTitle.textContent =
    date.toLocaleDateString(
      undefined,
      {
        weekday: 'long',
        month: 'long',
        day: 'numeric'
      }
    );

  els.slotSearch.value = '';
  els.suggestionReason.textContent = '';

  renderSlotRecipes();

  els.slotDialog.showModal();
}


function exclusionReason(
  recipe,
  date
) {
  const dateIso =
    iso(date);

  const targetDow =
    date.getDay();

  const cutoff =
    addDays(
      date,
      -(settings.repeatWeeks || 0) * 7
    );

  const repeatedSameDow =
    schedule.some(s => {
      if (
        s.recipeId !== recipe.id ||
        s.date === dateIso
      ) {
        return false;
      }

      const d =
        parseIsoLocal(s.date);

      return (
        d.getDay() === targetDow &&
        d < date &&
        d >= cutoff
      );
    });

  if (repeatedSameDow) {
    return `Used on this weekday in the last ${settings.repeatWeeks} weeks`;
  }

  if (settings.avoidSameWeek) {
    const ws =
      startOfWeek(date);

    const we =
      addDays(ws, 6);

    const inWeek =
      schedule.some(
        s =>
          s.recipeId === recipe.id &&
          s.date !== dateIso &&
          s.date >= iso(ws) &&
          s.date <= iso(we)
      );

    if (inWeek) {
      return 'Already scheduled this week';
    }
  }

  return '';
}


function renderSlotRecipes() {
  const q =
    normalizeText(
      els.slotSearch.value
    );

  const items =
    recipes.filter(
      r =>
        !q ||
        normalizeText(
          `${r.name} ${(r.tags || []).join(' ')}`
        ).includes(q)
    );

  els.slotRecipeList.innerHTML =
    items.length
      ? ''
      : `
        <div class="empty-state">
          No recipes found.
        </div>
      `;

  items.forEach(r => {
    const reason =
      exclusionReason(
        r,
        currentSlotDate
      );

    const btn =
      document.createElement(
        'button'
      );

    btn.type =
      'button';

    btn.className =
      `slot-option${
        reason
          ? ' disabled'
          : ''
      }`;

    btn.innerHTML = `
      <span>
        <div class="slot-option-title">
          ${escapeHtml(r.name)}
        </div>

        <div class="slot-option-meta">
          ${
            reason
              ? escapeHtml(reason)
              : `${r.prepTimeMin || 0} min · eligible`
          }
        </div>
      </span>

      <span>
        Choose
      </span>
    `;

    /*
     * Manual override is always allowed,
     * even if algorithmically excluded.
     */
    btn.addEventListener(
      'click',
      () =>
        assignMeal(
          r.id,
          'confirmed'
        )
    );

    els.slotRecipeList.appendChild(
      btn
    );
  });
}


async function assignMeal(
  recipeId,
  status
) {
  const slotId =
    `${iso(currentSlotDate)}_dinner`;

  await setDoc(
    doc(
      db,
      'households',
      householdId,
      'schedule',
      slotId
    ),
    {
      date:
        iso(currentSlotDate),

      meal:
        'dinner',

      recipeId,

      status,

      updatedAt:
        serverTimestamp()
    },
    {
      merge: true
    }
  );

  els.slotDialog.close();

  toast(
    status === 'suggested'
      ? 'Suggestion added'
      : 'Dinner confirmed'
  );
}


async function suggestMeal() {
  if (!recipes.length) {
    return toast(
      'Add a recipe first'
    );
  }

  const eligible =
    recipes.filter(
      r =>
        !exclusionReason(
          r,
          currentSlotDate
        )
    );

  if (!eligible.length) {
    els.suggestionReason.textContent =
      'No recipes are eligible under the current anti-repeat settings. Choose one manually to override, or reduce the repeat window in Settings.';

    return toast(
      'No eligible recipes — manual override is still available'
    );
  }

  const picked =
    eligible[
      Math.floor(
        Math.random() *
        eligible.length
      )
    ];

  await assignMeal(
    picked.id,
    'suggested'
  );
}


async function removeMeal() {
  const slotId =
    `${iso(currentSlotDate)}_dinner`;

  await deleteDoc(
    doc(
      db,
      'households',
      householdId,
      'schedule',
      slotId
    )
  ).catch(() => {});

  els.slotDialog.close();

  toast('Meal removed');
}


/* -------------------------------------------------------
   Settings
------------------------------------------------------- */

function syncSettingsForm() {
  els.repeatWeeks.value =
    settings.repeatWeeks ?? 4;

  els.avoidSameWeek.checked =
    settings.avoidSameWeek !== false;

  els.shortcutName.value =
    settings.shortcutName ||
    'Kitchen Week to Reminders';
}


async function saveSettings(ev) {
  ev.preventDefault();

  settings = {
    repeatWeeks:
      Math.max(
        0,
        Number(
          els.repeatWeeks.value
        ) || 0
      ),

    avoidSameWeek:
      els.avoidSameWeek.checked,

    shortcutName:
      els.shortcutName.value.trim() ||
      'Kitchen Week to Reminders'
  };

  await setDoc(
    doc(
      db,
      'households',
      householdId,
      'settings',
      'shared'
    ),
    settings,
    {
      merge: true
    }
  );

  els.settingsDialog.close();

  toast('Settings saved');
}


/* -------------------------------------------------------
   Apple Shortcut / Shopping export
------------------------------------------------------- */

async function copyShopping() {
  const text =
    shoppingText();

  if (!text) {
    return toast(
      'Shopping list is empty'
    );
  }

  await navigator.clipboard.writeText(
    text
  );

  toast(
    'Shopping list copied'
  );
}


async function runShortcut() {
  const text =
    shoppingText();

  if (!text) {
    return toast(
      'Shopping list is empty'
    );
  }

  await navigator.clipboard.writeText(
    text
  );

  const url =
    `shortcuts://run-shortcut?name=${
      encodeURIComponent(
        settings.shortcutName ||
        'Kitchen Week to Reminders'
      )
    }&input=clipboard`;

  window.location.href =
    url;
}


/* -------------------------------------------------------
   Disconnect
------------------------------------------------------- */

function disconnect() {
  localStorage.removeItem(
    'kw_household'
  );

  householdId = '';

  unsubscribers.forEach(
    fn => fn()
  );

  unsubscribers = [];

  recipes = [];
  schedule = [];

  els.settingsDialog.close();
  els.mainApp.hidden = true;
  els.connectPanel.hidden = false;

  toast(
    'Disconnected from household'
  );
}


/* -------------------------------------------------------
   UI events
------------------------------------------------------- */

function wireUi() {
  els.connectButton.addEventListener(
    'click',
    connectHousehold
  );

  els.householdPhrase.addEventListener(
    'keydown',
    e => {
      if (e.key === 'Enter') {
        connectHousehold();
      }
    }
  );

  document
    .querySelectorAll('.tab')
    .forEach(btn =>
      btn.addEventListener(
        'click',
        () => {
          document
            .querySelectorAll('.tab')
            .forEach(b =>
              b.classList.toggle(
                'active',
                b === btn
              )
            );

          document
            .querySelectorAll('.tab-panel')
            .forEach(p =>
              p.classList.remove('active')
            );

          document
            .getElementById(
              `${btn.dataset.tab}Tab`
            )
            .classList.add('active');

          if (
            btn.dataset.tab ===
            'shopping'
          ) {
            renderShopping();
          }
        }
      )
    );

  document
    .querySelectorAll('.close-dialog')
    .forEach(btn =>
      btn.addEventListener(
        'click',
        () =>
          btn
            .closest('dialog')
            .close()
      )
    );

  els.prevWeek.addEventListener(
    'click',
    () => {
      weekStart =
        addDays(
          weekStart,
          -7
        );

      renderAll();
    }
  );

  els.nextWeek.addEventListener(
    'click',
    () => {
      weekStart =
        addDays(
          weekStart,
          7
        );

      renderAll();
    }
  );

  els.todayWeek.addEventListener(
    'click',
    () => {
      weekStart =
        startOfWeek(
          new Date()
        );

      renderAll();
    }
  );

  els.addRecipeButton.addEventListener(
    'click',
    () => openRecipe()
  );

  els.addIngredient.addEventListener(
    'click',
    () =>
      addIngredientRow()
  );

  els.recipeForm.addEventListener(
    'submit',
    saveRecipe
  );

  els.deleteRecipe.addEventListener(
    'click',
    deleteCurrentRecipe
  );

  els.recipeSearch.addEventListener(
    'input',
    renderRecipes
  );

  els.tagFilter.addEventListener(
    'change',
    renderRecipes
  );

  els.slotSearch.addEventListener(
    'input',
    renderSlotRecipes
  );

  els.suggestMeal.addEventListener(
    'click',
    suggestMeal
  );

  els.removeMeal.addEventListener(
    'click',
    removeMeal
  );

  els.settingsButton.addEventListener(
    'click',
    () => {
      syncSettingsForm();

      els.settingsDialog.showModal();
    }
  );

  els.settingsForm.addEventListener(
    'submit',
    saveSettings
  );

  els.disconnectButton.addEventListener(
    'click',
    disconnect
  );

  els.copyShopping.addEventListener(
    'click',
    copyShopping
  );

  els.runShortcut.addEventListener(
    'click',
    runShortcut
  );
}


/* -------------------------------------------------------
   Start app
------------------------------------------------------- */

wireUi();
initFirebase();
