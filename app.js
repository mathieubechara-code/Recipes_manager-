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
let selectedDay = new Date();
selectedDay.setHours(0, 0, 0, 0);
let currentSlotDate = null;
let currentSlotMeal = 'dinner';
let viewedRecipeId = null;
let unsubscribers = [];
let pendingRestoreBackup = null;


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
   Recipe parser
------------------------------------------------------- */

function decodeNotesText(text = '') {
  const area = document.createElement('textarea');
  area.innerHTML = text;
  return area.value
    .replace(/&#x9;|&#9;/gi, '\t')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\*\*/g, '')
    .replace(/__+/g, '')
    .replace(/^\s*⸻\s*$/gm, '')
    .replace(/\t+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .trim();
}

function cleanRecipeLine(line = '') {
  return line
    .replace(/^\s*[•*·▪◦-]\s+/, '')
    .replace(/^\s*(\d+)\\\.\s*/, '$1. ')
    .replace(/^\s*(\d+)\ufe0f?\u20e3\s*/, '$1. ')
    .replace(/^\s*([①②③④⑤⑥⑦⑧⑨⑩])\s*/, m => ({'①':'1. ','②':'2. ','③':'3. ','④':'4. ','⑤':'5. ','⑥':'6. ','⑦':'7. ','⑧':'8. ','⑨':'9. ','⑩':'10. '}[m.trim()] || m))
    .trim();
}

function headingKind(line = '') {
  const t = normalizeText(line.replace(/[:：]$/, ''));

  // Accept headings that include serving/context notes, for example:
  // “Ingredients (for 2 salmon fillets)”, “Ingredients for 4”,
  // “Ingrédients (pour 2 personnes)”.
  if (/^(ingredients?|ingr[eé]dients?)(?:\s*\([^)]*\))?(?:\s+(?:for|pour)\b.*)?$/.test(t)) {
    return 'ingredients';
  }

  // Accept the same kind of optional note on instruction headings.
  if (/^(instructions?|preparation|préparation|method|méthode|directions?)(?:\s*\([^)]*\))?$/.test(t)) {
    return 'instructions';
  }

  if (/^(preparation|préparation)\s+(du|de la|des|of|for)\b/.test(t)) {
    return 'instruction-subheading';
  }

  return '';
}

const UNIT_PATTERNS = [
  'c\\.?\\s*à\\s*soupe', 'cuill(?:ère|ere)s?\\s+à\\s+soupe',
  'c\\.?\\s*à\\s*café', 'cuill(?:ère|ere)s?\\s+à\\s+café',
  'tablespoons?', 'tablespoons?', 'tbsp', 'tbs',
  'teaspoons?', 'tsp',
  'kilograms?', 'kgs?', 'kg', 'grams?', 'gr', 'g',
  'millilit(?:er|re)s?', 'ml', 'centilit(?:er|re)s?', 'cl', 'lit(?:er|re)s?', 'l',
  'ounces?', 'oz', 'pounds?', 'lbs?',
  'cups?', 'verres?', 'cloves?', 'gousses?', 'cubes?', 'cans?', 'boîtes?', 'boites?',
  'packages?', 'packs?', 'sachets?', 'slices?', 'tranches?', 'pinches?', 'pincées?', 'pincees?',
  'pieces?', 'morceaux?'
];

function normalizeFractionToken(token = '') {
  return token
    .replace(/½/g, '1/2')
    .replace(/¼/g, '1/4')
    .replace(/¾/g, '3/4')
    .replace(/⅓/g, '1/3')
    .replace(/⅔/g, '2/3')
    .replace(/⅛/g, '1/8')
    .replace(/⅜/g, '3/8')
    .replace(/⅝/g, '5/8')
    .replace(/⅞/g, '7/8');
}

function parseIngredientLine(rawLine, group = '') {
  let line = cleanRecipeLine(rawLine);
  line = normalizeFractionToken(line);
  if (!line) return null;

  const qtyPattern = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?)(?:\\s*[–—-]\\s*(?:\\d+\\/\\d+|\\d+(?:[.,]\\d+)?))?';
  const unitPattern = `(?:${UNIT_PATTERNS.join('|')})`;
  const re = new RegExp(`^(${qtyPattern})(?:\\s*)(${unitPattern})?(?=\\s|$)(?:\\s+(?:de\\s+|d['’]\\s*|of\\s+)|\\s+)?(.*)$`, 'i');
  const match = line.match(re);

  if (!match) {
    return { name: line, quantity: '', unit: '', group };
  }

  let quantity = match[1].replace(/\s*[–—-]\s*/g, '–').replace(',', '.').trim();
  let unit = (match[2] || '').trim();
  let name = (match[3] || '').trim();

  if (!name) {
    name = unit;
    unit = '';
  }

  // Words like "medium" are descriptors, not units, and remain in the name.
  return { name, quantity, unit, group };
}

function inferRecipeTags(title = '', text = '') {
  const hay = normalizeText(`${title} ${text}`);
  const tags = new Set(['imported']);
  const rules = [
    ['chicken', /\b(chicken|poulet)\b/],
    ['beef', /\b(beef|boeuf|bœuf)\b/],
    ['pork', /\b(pork|porc)\b/],
    ['fish', /\b(fish|salmon|saumon|thon|tuna)\b/],
    ['pasta', /\b(pasta|pâtes|pates|spaghetti|linguine|penne)\b/],
    ['rice', /\b(rice|riz)\b/],
    ['vegetarian', /\b(vegetarian|végétarien|vegetarien)\b/]
  ];
  rules.forEach(([tag, re]) => { if (re.test(hay)) tags.add(tag); });
  return [...tags];
}

function parseRecipeText(rawText) {
  const text = decodeNotesText(rawText);
  const rawLines = text.split('\n');
  const lines = rawLines.map((raw, index) => ({
    raw,
    clean: cleanRecipeLine(raw),
    bullet: /^\s*[•*·▪◦-]\s+/.test(raw),
    index
  })).filter(x => x.clean);

  if (!lines.length) throw new Error('Paste a recipe first.');

  let title = '';
  let section = 'title';
  let ingredientGroup = '';
  const ingredients = [];
  const instructionLines = [];

  for (let i = 0; i < lines.length; i++) {
    const item = lines[i];
    const kind = headingKind(item.clean);

    if (kind === 'ingredients') {
      section = 'ingredients';
      ingredientGroup = '';
      continue;
    }
    if (kind === 'instructions') {
      section = 'instructions';
      continue;
    }
    if (kind === 'instruction-subheading' && section === 'ingredients') {
      section = 'instructions';
      instructionLines.push(item.clean);
      continue;
    }

    if (section === 'title') {
      if (!title) title = item.clean.replace(/^\p{Extended_Pictographic}+\s*/u, '').trim();
      continue;
    }

    if (section === 'ingredients') {
      const next = lines[i + 1];
      const looksLikeGroup = !item.bullet && next?.bullet && !/^(\d|1\/|[½¼¾⅓⅔⅛⅜⅝⅞])/.test(item.clean);
      if (looksLikeGroup) {
        ingredientGroup = item.clean.replace(/[:：]$/, '').trim();
        continue;
      }
      const parsed = parseIngredientLine(item.raw, ingredientGroup);
      if (parsed) ingredients.push(parsed);
      continue;
    }

    if (section === 'instructions') {
      if (kind === 'instruction-subheading') {
        instructionLines.push(item.clean);
        continue;
      }
      const normalized = item.bullet && !/^\d+\.\s/.test(item.clean) ? `• ${item.clean}` : item.clean;
      instructionLines.push(normalized);
    }
  }

  // If headings were absent, use the first non-empty line as title and preserve the rest as instructions.
  if (!ingredients.length && !instructionLines.length) {
    title = lines[0].clean.replace(/^\p{Extended_Pictographic}+\s*/u, '').trim();
    instructionLines.push(...lines.slice(1).map(x => x.clean));
  }

  return {
    name: title || 'Imported recipe',
    tags: inferRecipeTags(title, text),
    prepTimeMin: 0,
    photoUrl: '',
    ingredients,
    instructions: instructionLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  };
}

function openImportRecipe() {
  els.importRecipeText.value = '';
  els.importRecipeDialog.showModal();
}

function parseAndReviewRecipe() {
  try {
    const parsed = parseRecipeText(els.importRecipeText.value);
    els.importRecipeDialog.close();
    openRecipe(parsed);
    toast(`Parsed ${parsed.ingredients.length} ingredients — review before saving`);
  } catch (err) {
    toast(err.message || 'Could not parse recipe');
  }
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
    return toast('Configure Firebase first — see README.md');
  }

  const phrase = els.householdPhrase.value.trim();

  if (phrase.length < 8) {
    return toast('Use a household phrase of at least 8 characters');
  }

  try {
    els.connectStatus.textContent = 'Connecting…';

    if (!currentUser) {
      const credential = await signInAnonymously(auth);
      currentUser = credential.user;
    }

    householdId = (
      await sha256(`kitchen-week:${phrase}`)
    ).slice(0, 40);

    await attachHousehold(householdId);

    localStorage.setItem('kw_household', householdId);
    els.householdPhrase.value = '';
    els.connectStatus.textContent = '';

    toast('Kitchen connected');
  } catch (err) {
    console.error('Kitchen connection failed:', err);
    els.connectStatus.textContent = `Connection failed: ${err.message || err}`;
    toast('Could not connect');
  }
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

  renderToday();
  renderWeek();
  renderRecipes();
  renderShopping();
  renderTagFilter();
}


function scheduleFor(date, meal = 'dinner') {
  return schedule.find(
    s => s.date === iso(date) && s.meal === meal
  );
}

function recipeById(id) {
  return recipes.find(r => r.id === id);
}

function recipeMealType(recipe) {
  return ['lunch', 'dinner', 'both'].includes(recipe?.mealType) ? recipe.mealType : 'both';
}

function recipeMealTypeLabel(recipe) {
  const type = recipeMealType(recipe);
  if (type === 'lunch') return 'Lunch';
  if (type === 'dinner') return 'Dinner';
  return 'Lunch & Dinner';
}

function recipeSupportsMeal(recipe, meal) {
  const type = recipeMealType(recipe);
  return type === 'both' || type === meal;
}

function mealLabel(meal) {
  return meal === 'lunch' ? 'Lunch' : 'Dinner';
}


function slotIsLocked(slot) {
  return slot?.locked === true;
}

async function setMealLocked(date, meal, locked) {
  const slot = scheduleFor(date, meal);
  if (!slot) return;
  await setDoc(
    doc(db, 'households', householdId, 'schedule', slot.id || `${iso(date)}_${meal}`),
    { locked, updatedAt: serverTimestamp() },
    { merge: true }
  );
  toast(locked ? `${mealLabel(meal)} locked` : `${mealLabel(meal)} unlocked`);
}

function eligibleRecipesFor(date, meal, currentRecipeId = '') {
  const virtualSchedule = schedule.filter(s => !(s.date === iso(date) && s.meal === meal));
  return recipes.filter(r =>
    r.id !== currentRecipeId &&
    recipeSupportsMeal(r, meal) &&
    !exclusionReasonAgainst(r, date, virtualSchedule, meal)
  );
}

async function regenerateMeal(date, meal) {
  const slot = scheduleFor(date, meal);
  if (slotIsLocked(slot)) return toast('Unlock this meal before regenerating it');
  const eligible = eligibleRecipesFor(date, meal, slot?.recipeId || '');
  if (!eligible.length) return toast(`No other eligible ${mealLabel(meal).toLowerCase()} recipe`);
  const picked = eligible[Math.floor(Math.random() * eligible.length)];
  const slotId = `${iso(date)}_${meal}`;
  await setDoc(
    doc(db, 'households', householdId, 'schedule', slotId),
    {
      date: iso(date),
      meal,
      recipeId: picked.id,
      status: 'suggested',
      locked: false,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
  toast(`${mealLabel(meal)} regenerated`);
}

async function regenerateUnlockedWeek() {
  const start = iso(weekStart);
  const end = iso(addDays(weekStart, 6));
  const targets = schedule.filter(s =>
    s.date >= start &&
    s.date <= end &&
    (s.meal === 'lunch' || s.meal === 'dinner') &&
    !slotIsLocked(s)
  );
  if (!targets.length) return toast('No unlocked scheduled meals to regenerate');
  if (!confirm(`Regenerate ${targets.length} unlocked meal${targets.length === 1 ? '' : 's'} in this week? Locked meals will stay unchanged.`)) return;

  let changed = 0;
  for (const slot of targets) {
    const date = parseIsoLocal(slot.date);
    const eligible = eligibleRecipesFor(date, slot.meal, slot.recipeId);
    if (!eligible.length) continue;
    const picked = eligible[Math.floor(Math.random() * eligible.length)];
    await setDoc(
      doc(db, 'households', householdId, 'schedule', slot.id || `${slot.date}_${slot.meal}`),
      {
        date: slot.date,
        meal: slot.meal,
        recipeId: picked.id,
        status: 'suggested',
        locked: false,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );
    changed++;
  }
  toast(changed ? `Regenerated ${changed} meal${changed === 1 ? '' : 's'}` : 'No eligible replacements found');
}

/* -------------------------------------------------------
   Today / Day view
------------------------------------------------------- */

function renderTodayMeal(date, meal) {
  const slot = scheduleFor(date, meal);
  const recipe = slot && recipeById(slot.recipeId);
  const card = document.createElement('article');
  card.className = `card today-meal-card${slot ? ' has-meal' : ''}`;

  const status = slot?.status === 'suggested'
    ? '<span class="status-pill status-suggested">Suggested</span>'
    : slot ? '<span class="status-pill status-confirmed">Confirmed</span>' : '';

  card.innerHTML = `
    <div class="today-meal-topline">
      <span class="today-meal-label">${mealLabel(meal)}</span>
      ${status}
    </div>
    ${recipe
      ? `<button type="button" class="today-recipe-link"><span class="today-recipe-name">${escapeHtml(recipe.name)}</span><span class="muted small">${recipe.prepTimeMin ? `${recipe.prepTimeMin} min` : 'View recipe'}</span></button>
         <div class="button-row today-meal-actions"><button type="button" class="secondary today-lock-meal">${slotIsLocked(slot) ? '🔒 Locked' : '🔓 Lock'}</button><button type="button" class="secondary today-regenerate-meal" ${slotIsLocked(slot) ? 'disabled' : ''}>↻ Regenerate</button><button type="button" class="secondary today-change-meal">Change</button><button type="button" class="secondary today-remove-meal">Remove</button></div>`
      : `<div class="empty-state today-empty">No ${mealLabel(meal).toLowerCase()} scheduled.</div><button type="button" class="primary today-add-meal">Choose ${mealLabel(meal).toLowerCase()}</button>`}
  `;

  if (recipe) {
    card.querySelector('.today-recipe-link').addEventListener('click', () => openRecipeView(recipe));
    card.querySelector('.today-change-meal').addEventListener('click', () => openSlot(date, meal));
    card.querySelector('.today-lock-meal').addEventListener('click', () => setMealLocked(date, meal, !slotIsLocked(slot)));
    card.querySelector('.today-regenerate-meal').addEventListener('click', () => regenerateMeal(date, meal));
    card.querySelector('.today-remove-meal').addEventListener('click', async () => {
      const slotId = `${iso(date)}_${meal}`;
      await deleteDoc(doc(db, 'households', householdId, 'schedule', slotId)).catch(() => {});
      toast(`${mealLabel(meal)} removed`);
    });
  } else {
    card.querySelector('.today-add-meal').addEventListener('click', () => openSlot(date, meal));
  }

  return card;
}

function renderToday() {
  if (!els.todayMeals) return;
  const isToday = sameDate(selectedDay, new Date());
  els.todayTitle.textContent = isToday ? 'Today' : selectedDay.toLocaleDateString(undefined, { weekday: 'long' });
  els.todayDate.textContent = selectedDay.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  els.todayMeals.innerHTML = '';
  els.todayMeals.appendChild(renderTodayMeal(selectedDay, 'lunch'));
  els.todayMeals.appendChild(renderTodayMeal(selectedDay, 'dinner'));
}

/* -------------------------------------------------------
   Week / Calendar
------------------------------------------------------- */

function renderMealSlot(date, meal) {
  const slot = scheduleFor(date, meal);
  const recipe = slot && recipeById(slot.recipeId);
  const wrap = document.createElement('div');
  wrap.className = `meal-slot${slot ? ' has-meal' : ''}`;

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'meal-slot-main';
  const status = slot?.status === 'suggested'
    ? '<span class="status-pill status-suggested">Suggested</span>'
    : slot ? '<span class="status-pill status-confirmed">Confirmed</span>' : '';
  main.innerHTML = `
    <span class="meal-slot-label">${mealLabel(meal)}</span>
    ${recipe
      ? `<span class="meal-name">${escapeHtml(recipe.name)}</span><span class="meal-meta">${recipe.prepTimeMin ? `${recipe.prepTimeMin} min` : ''}</span>${status}`
      : '<span class="empty-meal">Choose meal</span>'}
  `;
  main.addEventListener('click', () => {
    if (recipe) openRecipeView(recipe);
    else openSlot(date, meal);
  });
  wrap.appendChild(main);

  if (recipe) {
    const actions = document.createElement('div');
    actions.className = 'meal-slot-actions';

    const lock = document.createElement('button');
    lock.type = 'button';
    lock.className = `meal-slot-control${slotIsLocked(slot) ? ' is-locked' : ''}`;
    lock.textContent = slotIsLocked(slot) ? '🔒' : '🔓';
    lock.title = slotIsLocked(slot) ? 'Unlock meal' : 'Lock meal';
    lock.setAttribute('aria-label', lock.title);
    lock.addEventListener('click', () => setMealLocked(date, meal, !slotIsLocked(slot)));

    const regen = document.createElement('button');
    regen.type = 'button';
    regen.className = 'meal-slot-control';
    regen.textContent = '↻';
    regen.title = 'Regenerate this meal';
    regen.setAttribute('aria-label', regen.title);
    regen.disabled = slotIsLocked(slot);
    regen.addEventListener('click', () => regenerateMeal(date, meal));

    const change = document.createElement('button');
    change.type = 'button';
    change.className = 'meal-slot-change';
    change.textContent = 'Change';
    change.addEventListener('click', () => openSlot(date, meal));

    actions.append(lock, regen, change);
    wrap.appendChild(actions);
  }
  return wrap;
}

function renderWeek() {
  els.weekTitle.textContent = fmtWeekTitle(weekStart);
  els.weekGrid.innerHTML = '';

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const card = document.createElement('article');
    card.className = `day-card${sameDate(date, new Date()) ? ' today' : ''}`;
    card.innerHTML = `
      <div class="day-date">
        <div class="day-name">${fmtDay(date)}</div>
        <div class="day-num">${date.getDate()}</div>
      </div>
      <div class="day-meals"></div>
    `;
    const meals = card.querySelector('.day-meals');
    meals.appendChild(renderMealSlot(date, 'lunch'));
    meals.appendChild(renderMealSlot(date, 'dinner'));
    els.weekGrid.appendChild(card);
  }
}

async function clearVisibleWeek() {
  const start = iso(weekStart);
  const end = iso(addDays(weekStart, 6));
  const visible = schedule.filter(s => s.date >= start && s.date <= end);
  if (!visible.length) return toast('This week is already empty');
  const title = fmtWeekTitle(weekStart);
  if (!confirm(`Remove all ${visible.length} scheduled meal${visible.length === 1 ? '' : 's'} for ${title}?`)) return;
  await Promise.all(visible.map(s => deleteDoc(doc(db, 'households', householdId, 'schedule', s.id))));
  toast(`Cleared ${visible.length} meal${visible.length === 1 ? '' : 's'} from this week`);
}

/* -------------------------------------------------------
   Recipes
------------------------------------------------------- */

function renderRecipes() {
  const q = normalizeText(els.recipeSearch.value);
  const tag = els.tagFilter.value;
  const filtered = recipes.filter(r => {
    const hay = normalizeText(`${r.name} ${(r.tags || []).join(' ')}`);
    return (!q || hay.includes(q)) && (!tag || (r.tags || []).includes(tag));
  });

  els.recipeGrid.innerHTML = '';
  if (!filtered.length) {
    els.recipeGrid.innerHTML = `<div class="empty-state">${recipes.length ? 'No recipes match those filters.' : 'Your recipe box is empty. Add the first recipe.'}</div>`;
    return;
  }

  filtered.forEach(r => {
    const card = document.createElement('article');
    card.className = 'recipe-card clickable-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `View ${r.name}`);
    const photo = safePhoto(r.photoUrl || '');
    card.innerHTML = `${photo ? `<img class="recipe-photo" src="${escapeHtml(photo)}" alt="" loading="lazy">` : ''}
      <div class="recipe-body"><h3>${escapeHtml(r.name)}</h3>
      <div class="tags"><span class="tag meal-type-tag">${escapeHtml(recipeMealTypeLabel(r))}</span>${(r.tags||[]).map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
      <p class="muted small">${(r.ingredients||[]).length} ingredients${r.prepTimeMin ? ` · ${r.prepTimeMin} min` : ''}</p>
      <div class="recipe-card-footer"><span class="muted small">${escapeHtml((r.instructions||'').slice(0,80))}${(r.instructions||'').length>80?'…':''}</span><button class="secondary edit-card-button">Edit</button></div></div>`;
    card.addEventListener('click', () => openRecipeView(r));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRecipeView(r); } });
    card.querySelector('.edit-card-button').addEventListener('click', e => { e.stopPropagation(); openRecipe(r); });
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
      ['lunch', 'dinner'].includes(s.meal) &&
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
    unit: '',
    group: ''
  }
) {
  const row = document.createElement('div');
  row.className = 'ingredient-row';
  row.dataset.group = ing.group || '';

  if (ing.group) {
    const groupLabel = document.createElement('div');
    groupLabel.className = 'ingredient-group-label';
    groupLabel.textContent = ing.group;
    row.appendChild(groupLabel);
  }

  const fields = document.createElement('div');
  fields.className = 'ingredient-fields';
  fields.innerHTML = `
    <input
      class="ing-name"
      placeholder="ingredient"
      value="${escapeHtml(String(ing.name || ''))}"
    >

    <input
      class="ing-qty"
      inputmode="text"
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

  fields.querySelector('button').addEventListener('click', () => row.remove());
  row.appendChild(fields);
  els.ingredientRows.appendChild(row);
}

function formatIngredientForView(ing) {
  const qty = ing.quantity === '' || ing.quantity == null ? '' : String(ing.quantity);
  return [qty, ing.unit || '', ing.name || ''].filter(Boolean).join(' ').trim();
}

function openRecipeView(recipe) {
  if (!recipe) return;
  viewedRecipeId = recipe.id;
  els.recipeViewName.textContent = recipe.name || 'Recipe';
  const photo = safePhoto(recipe.photoUrl || '');
  if (photo) {
    els.recipeViewPhoto.src = photo;
    els.recipeViewPhoto.hidden = false;
  } else {
    els.recipeViewPhoto.removeAttribute('src');
    els.recipeViewPhoto.hidden = true;
  }
  els.recipeViewMeta.textContent = recipe.prepTimeMin ? `${recipe.prepTimeMin} min prep` : '';
  els.recipeViewTags.innerHTML = `<span class="tag meal-type-tag">${escapeHtml(recipeMealTypeLabel(recipe))}</span>` + (recipe.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');

  const groups = new Map();
  for (const ing of recipe.ingredients || []) {
    const group = ing.group || '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(ing);
  }
  if (!groups.size) {
    els.recipeViewIngredients.innerHTML = '<p class="muted">No ingredients saved.</p>';
  } else {
    els.recipeViewIngredients.innerHTML = [...groups.entries()].map(([group, items]) => `
      ${group ? `<h4>${escapeHtml(group)}</h4>` : ''}
      <ul>${items.map(ing => `<li>${escapeHtml(formatIngredientForView(ing))}</li>`).join('')}</ul>
    `).join('');
  }
  const instructions = (recipe.instructions || '').trim();
  els.recipeViewInstructions.textContent = instructions || 'No instructions saved.';
  els.recipeViewDialog.showModal();
}

function editViewedRecipe() {
  const recipe = recipeById(viewedRecipeId);
  if (!recipe) return;
  els.recipeViewDialog.close();
  openRecipe(recipe);
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

  els.recipeMealType.value = recipeMealType(recipe);

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
              .trim(),

          group: row.dataset.group || ''
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

    mealType: ['lunch', 'dinner', 'both'].includes(els.recipeMealType.value)
      ? els.recipeMealType.value
      : 'both',

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

function openSlot(date, meal = 'dinner') {
  currentSlotDate = date;
  currentSlotMeal = meal;
  els.slotMealLabel.textContent = mealLabel(meal);
  els.slotTitle.textContent = date.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
  els.slotSearch.value = '';
  els.suggestionReason.textContent = '';
  els.removeMeal.hidden = !scheduleFor(date, meal);
  renderSlotRecipes();
  els.slotDialog.showModal();
}

function exclusionReasonAgainst(recipe, date, scheduleState, meal = currentSlotMeal) {
  const dateIso = iso(date);
  const targetDow = date.getDay();
  const cutoff = addDays(date, -(settings.repeatWeeks || 0) * 7);
  const repeatedSameDow = scheduleState.some(s => {
    if (s.recipeId !== recipe.id) return false;
    if (s.date === dateIso && s.meal === meal) return false;
    const d = parseIsoLocal(s.date);
    return d.getDay() === targetDow && d < date && d >= cutoff;
  });
  if (repeatedSameDow) return `Used on this weekday in the last ${settings.repeatWeeks} weeks`;
  if (settings.avoidSameWeek) {
    const ws = startOfWeek(date), we = addDays(ws, 6);
    const inWeek = scheduleState.some(s =>
      s.recipeId === recipe.id &&
      !(s.date === dateIso && s.meal === meal) &&
      s.date >= iso(ws) && s.date <= iso(we)
    );
    if (inWeek) return 'Already scheduled this week';
  }
  return '';
}

function exclusionReason(recipe, date) {
  return exclusionReasonAgainst(recipe, date, schedule, currentSlotMeal);
}

function renderSlotRecipes() {
  const q = normalizeText(els.slotSearch.value);
  const items = recipes.filter(r => !q || normalizeText(`${r.name} ${(r.tags||[]).join(' ')}`).includes(q));
  els.slotRecipeList.innerHTML = items.length ? '' : '<div class="empty-state">No recipes found.</div>';
  items.forEach(r => {
    const reason = exclusionReason(r, currentSlotDate);
    const mealMismatch = !recipeSupportsMeal(r, currentSlotMeal);
    const note = mealMismatch
      ? `${recipeMealTypeLabel(r)} recipe · manual override`
      : reason || `${r.prepTimeMin||0} min · eligible`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `slot-option${(reason || mealMismatch) ? ' disabled' : ''}`;
    btn.innerHTML = `<span><div class="slot-option-title">${escapeHtml(r.name)}</div><div class="slot-option-meta">${escapeHtml(note)}</div></span><span>Choose</span>`;
    // Manual selection is always allowed, even if meal suitability or anti-repeat rules would exclude it from suggestions.
    btn.addEventListener('click', () => assignMeal(r.id, 'confirmed'));
    els.slotRecipeList.appendChild(btn);
  });
}

async function assignMeal(recipeId, status) {
  const dateIso = iso(currentSlotDate);
  const slotId = `${dateIso}_${currentSlotMeal}`;
  await setDoc(doc(db,'households',householdId,'schedule',slotId), {
    date: dateIso,
    meal: currentSlotMeal,
    recipeId,
    status,
    locked: false,
    updatedAt: serverTimestamp()
  }, {merge:true});
  els.slotDialog.close();
  toast(status === 'suggested' ? `${mealLabel(currentSlotMeal)} suggestion added` : `${mealLabel(currentSlotMeal)} confirmed`);
}

async function suggestMeal() {
  if (!recipes.length) return toast('Add a recipe first');
  const eligible = recipes.filter(r => recipeSupportsMeal(r, currentSlotMeal) && !exclusionReason(r,currentSlotDate));
  if (!eligible.length) {
    els.suggestionReason.textContent = 'No recipes are eligible under the current anti-repeat settings. Choose one manually to override, or reduce the repeat window in Settings.';
    return toast('No eligible recipes — manual override is still available');
  }
  const picked = eligible[Math.floor(Math.random()*eligible.length)];
  await assignMeal(picked.id,'suggested');
}

async function removeMeal() {
  const slotId = `${iso(currentSlotDate)}_${currentSlotMeal}`;
  await deleteDoc(doc(db,'households',householdId,'schedule',slotId)).catch(()=>{});
  els.slotDialog.close();
  toast(`${mealLabel(currentSlotMeal)} removed`);
}

/* -------------------------------------------------------
   Week planner
------------------------------------------------------- */

function selectedPlannerMeals() {
  const scope = els.weekPlanScope.value || 'full';
  if (scope === 'lunch') return ['lunch'];
  if (scope === 'dinner') return ['dinner'];
  return ['lunch', 'dinner'];
}

function dayHasEmptySelectedMeal(date) {
  const meals = selectedPlannerMeals();
  return meals.some(meal => !scheduleFor(date, meal));
}

function renderWeekPlanDays() {
  els.weekPlanDays.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const lunch = scheduleFor(date, 'lunch');
    const dinner = scheduleFor(date, 'dinner');
    const lunchRecipe = lunch && recipeById(lunch.recipeId);
    const dinnerRecipe = dinner && recipeById(dinner.recipeId);
    const label = document.createElement('label');
    label.className = 'week-plan-day';
    label.innerHTML = `
      <input type="checkbox" data-date="${iso(date)}" checked>
      <span>
        <strong>${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</strong>
        <small>Lunch: ${lunchRecipe ? escapeHtml(lunchRecipe.name) : 'Empty'} · Dinner: ${dinnerRecipe ? escapeHtml(dinnerRecipe.name) : 'Empty'}</small>
      </span>
    `;
    els.weekPlanDays.appendChild(label);
  }
}

function openWeekPlanner() {
  els.weekPlanScope.value = 'full';
  renderWeekPlanDays();
  els.replaceExistingWeekMeals.checked = false;
  els.weekPlanReason.textContent = '';
  els.weekPlanDialog.showModal();
}

function setWeekPlannerSelection(mode) {
  [...els.weekPlanDays.querySelectorAll('input[type="checkbox"]')].forEach(cb => {
    if (mode === 'all') cb.checked = true;
    if (mode === 'clear') cb.checked = false;
    if (mode === 'empty') cb.checked = dayHasEmptySelectedMeal(parseIsoLocal(cb.dataset.date));
  });
}

async function suggestWeekDays() {
  if (!recipes.length) return toast('Add a recipe first');
  const selected = [...els.weekPlanDays.querySelectorAll('input[type="checkbox"]:checked')]
    .map(cb => parseIsoLocal(cb.dataset.date)).sort((a,b)=>a-b);
  if (!selected.length) return toast('Select at least one day');
  const meals = selectedPlannerMeals();
  if (!meals.length) return toast('Choose Lunch week, Dinner week, or Full week');

  const replaceExisting = els.replaceExistingWeekMeals.checked;
  const workingSchedule = schedule.map(s => ({...s}));
  let added = 0, skipped = 0;

  for (const date of selected) {
    const dateIso = iso(date);
    for (const meal of meals) {
      const current = workingSchedule.find(s => s.date === dateIso && s.meal === meal);
      if (current && !replaceExisting) { skipped++; continue; }
      const scheduleForEligibility = workingSchedule.filter(s => !(s.date === dateIso && s.meal === meal));
      const eligible = recipes.filter(r => recipeSupportsMeal(r, meal) && !exclusionReasonAgainst(r, date, scheduleForEligibility, meal));
      if (!eligible.length) { skipped++; continue; }
      const picked = eligible[Math.floor(Math.random() * eligible.length)];
      const slotId = `${dateIso}_${meal}`;
      const nextSlot = { date: dateIso, meal, recipeId: picked.id, status: 'suggested' };
      await setDoc(doc(db,'households',householdId,'schedule',slotId), {...nextSlot, updatedAt:serverTimestamp()}, {merge:true});
      const idx = workingSchedule.findIndex(s => s.date === dateIso && s.meal === meal);
      if (idx >= 0) workingSchedule[idx] = {...workingSchedule[idx], ...nextSlot}; else workingSchedule.push(nextSlot);
      added++;
    }
  }
  els.weekPlanDialog.close();
  toast(`Suggested ${added} meal${added === 1 ? '' : 's'}${skipped ? ` · skipped ${skipped}` : ''}`);
}

/* -------------------------------------------------------
   Recipe backup / restore
------------------------------------------------------- */

function recipeBackupPayload() {
  return {
    schema: 'kitchen-week.recipes.v1',
    exportedAt: new Date().toISOString(),
    recipeCount: recipes.length,
    recipes: recipes.map(({ id, ...data }) => ({ id, ...data }))
  };
}

function downloadRecipeBackup() {
  const payload = recipeBackupPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kitchen-week-recipes-${iso(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`Backed up ${recipes.length} recipes`);
}

function chooseRestoreFile() {
  els.restoreRecipeFile.value = '';
  els.restoreRecipeFile.click();
}

async function readRestoreFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.schema !== 'kitchen-week.recipes.v1' || !Array.isArray(data.recipes)) {
      throw new Error('This is not a Kitchen Week recipe backup.');
    }
    pendingRestoreBackup = data;
    els.restoreSummary.textContent = `${data.recipes.length} recipes found in backup${data.exportedAt ? ` from ${new Date(data.exportedAt).toLocaleString()}` : ''}.`;
    els.restoreDialog.showModal();
  } catch (err) {
    pendingRestoreBackup = null;
    toast(err.message || 'Could not read backup file');
  }
}

function firestoreSafeRecipe(recipe) {
  const clean = { ...recipe };
  clean.mealType = ['lunch', 'dinner', 'both'].includes(clean.mealType) ? clean.mealType : 'both';
  delete clean.id;
  // Firestore export timestamps become plain objects in JSON; replacing them avoids type errors.
  clean.restoredAt = serverTimestamp();
  delete clean.createdAt;
  delete clean.updatedAt;
  return clean;
}

async function restoreRecipesFromBackup() {
  if (!pendingRestoreBackup) return;
  const mode = document.querySelector('input[name="restoreMode"]:checked')?.value || 'merge';
  if (mode === 'replace') {
    const ok = confirm('Replace all current recipes with this backup? Your meal schedule will not be deleted.');
    if (!ok) return;
    await Promise.all(recipes.map(r => deleteDoc(doc(db, 'households', householdId, 'recipes', r.id))));
  }

  let restored = 0;
  for (const recipe of pendingRestoreBackup.recipes) {
    const id = recipe.id || uuid();
    await setDoc(doc(db, 'households', householdId, 'recipes', id), firestoreSafeRecipe(recipe), { merge: mode === 'merge' });
    restored++;
  }
  pendingRestoreBackup = null;
  els.restoreDialog.close();
  toast(`Restored ${restored} recipes`);
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

  els.howToUseButton.addEventListener('click', () => els.howToUseDialog.showModal());
  els.regenerateUnlockedButton.addEventListener('click', regenerateUnlockedWeek);

  els.prevDay.addEventListener('click', () => {
    selectedDay = addDays(selectedDay, -1);
    renderToday();
  });

  els.nextDay.addEventListener('click', () => {
    selectedDay = addDays(selectedDay, 1);
    renderToday();
  });

  els.todayDay.addEventListener('click', () => {
    selectedDay = new Date();
    selectedDay.setHours(0, 0, 0, 0);
    renderToday();
  });

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

  els.importRecipeButton.addEventListener('click', openImportRecipe);
  els.parseRecipeButton.addEventListener('click', parseAndReviewRecipe);
  els.planWeekButton.addEventListener('click', openWeekPlanner);
  els.clearVisibleWeekButton.addEventListener('click', clearVisibleWeek);
  els.editViewedRecipe.addEventListener('click', editViewedRecipe);
  els.weekPlanScope.addEventListener('change', renderWeekPlanDays);
  els.selectAllWeekDays.addEventListener('click', () => setWeekPlannerSelection('all'));
  els.selectEmptyWeekDays.addEventListener('click', () => setWeekPlannerSelection('empty'));
  els.clearWeekDays.addEventListener('click', () => setWeekPlannerSelection('clear'));
  els.suggestSelectedDays.addEventListener('click', suggestWeekDays);
  els.downloadRecipeBackup.addEventListener('click', downloadRecipeBackup);
  els.restoreRecipeBackup.addEventListener('click', chooseRestoreFile);
  els.restoreRecipeFile.addEventListener('change', readRestoreFile);
  els.confirmRestoreRecipes.addEventListener('click', restoreRecipesFromBackup);

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
