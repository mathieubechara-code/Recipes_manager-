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

const APP_BUILD = '1.7.0-beta.2';


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
  shortcutName: 'Kitchen Week to Reminders',
  defaultPeople: 2
};

let weekStart = startOfWeek(new Date());
let selectedDay = new Date();
selectedDay.setHours(0, 0, 0, 0);
let currentSlotDate = null;
let currentSlotMeal = 'dinner';
let viewedRecipeId = null;
let unsubscribers = [];
let recipeReaderCurrentStep = 0;
let recipeReaderScrollTicking = false;
let recipeReaderManualScrollUntil = 0;

let pendingRestoreBackup = null;
let shoppingReviewSource = [];
let shoppingReviewRemovedKeys = new Set(); // legacy drafts only; no X/remove action in Beta 8
let shoppingReviewAutosaveTimer = null;
let shoppingReviewSortTimer = null;
let shoppingReviewMode = 'unsent';
let recipeEditorServings = 2;
let slotPeopleSaveTimer = null;


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


function inferRecipeServings(text = '') {
  const clean = decodeNotesText(text);
  const patterns = [
    /serves?\s*(\d{1,2})/i,
    /for\s*(\d{1,2})\s*(?:people|persons?|servings?)/i,
    /(?:pour|pour\s+le)\s*(\d{1,2})\s*(?:personnes?|pers\.?)/i,
    /\((\d{1,2})\s*(?:personnes?|people|servings?)\)/i
  ];
  for (const re of patterns) {
    const m = clean.match(re);
    if (m) return Math.max(1, Number(m[1]) || 2);
  }
  return 2;
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
    servings: inferRecipeServings(text),
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
      try {
        await attachHousehold(householdId);
      } catch (err) {
        console.error('Automatic household reconnect failed:', err);
        els.connectStatus.textContent = `Reconnect failed: ${err.message || err}`;
        els.mainApp.hidden = true;
        els.connectPanel.hidden = false;
      }
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

    toast('Meal Planner connected');
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


function lockIconSvg(locked, compact = false) {
  const sizeClass = compact ? 'lock-svg lock-svg-compact' : 'lock-svg';
  if (locked) {
    return `<svg class="${sizeClass}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path class="lock-shackle" d="M7 10V7.4C7 4.4 9.2 2.2 12 2.2s5 2.2 5 5.2V10" />
      <rect class="lock-body" x="5" y="9" width="14" height="11.5" rx="2.5" />
      <circle class="lock-keyhole" cx="12" cy="14.4" r="1.35" />
      <path class="lock-keyhole" d="M12 15.6v2" />
    </svg>`;
  }
  return `<svg class="${sizeClass}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path class="lock-shackle lock-shackle-open" d="M8.3 10V7.8C8.3 4.8 10.5 2.5 13.3 2.5c2.2 0 4 1.3 4.7 3.2" />
    <path class="lock-open-gap" d="M18.1 5.7l2.2-2.1" />
    <rect class="lock-body" x="5" y="9" width="14" height="11.5" rx="2.5" />
    <circle class="lock-keyhole" cx="12" cy="14.4" r="1.35" />
    <path class="lock-keyhole" d="M12 15.6v2" />
  </svg>`;
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
      people: slotPeopleCount(slot, picked),
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
        people: slotPeopleCount(slot, picked),
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

function statusMarkup(slot) {
  if (!slot) return '';
  return slot.status === 'suggested'
    ? '<span class="status-pill status-suggested">App suggested</span>'
    : '<span class="status-pill status-confirmed">You confirmed</span>';
}

function renderTodayMeal(date, meal) {
  const slot = scheduleFor(date, meal);
  const recipe = slot && recipeById(slot.recipeId);
  const card = document.createElement('article');
  card.className = `card today-meal-card meal-${meal}${slot ? ' has-meal' : ''}${slotIsLocked(slot) ? ' is-locked' : ''}`;

  card.innerHTML = `
    <div class="today-meal-topline">
      <div class="today-meal-kind">
        <span class="today-meal-icon" aria-hidden="true">${meal === 'lunch' ? '☀' : '☾'}</span>
        <span class="today-meal-label">${mealLabel(meal)}</span>
      </div>
      ${statusMarkup(slot)}
    </div>
    ${recipe
      ? `<button type="button" class="today-recipe-link" aria-label="View ${escapeHtml(recipe.name)} recipe">
           <span class="today-recipe-name">${escapeHtml(recipe.name)}</span>
           <span class="recipe-tap-hint">Tap to view recipe <span aria-hidden="true">›</span></span>
         </button>
         <div class="today-meal-meta">For ${slotPeopleCount(slot, recipe)} ${slotPeopleCount(slot, recipe) === 1 ? 'person' : 'people'}${slotIsLocked(slot) ? ' · 🔒 Locked' : ''}</div>
         <div class="today-meal-divider" aria-hidden="true"></div>
         <div class="today-meal-actions" role="group" aria-label="${mealLabel(meal)} actions">
           <button type="button" class="meal-action today-lock-meal ${slotIsLocked(slot) ? 'is-active' : ''}" title="${slotIsLocked(slot) ? 'Unlock meal' : 'Lock meal'}"><span class="meal-lock-icon">${lockIconSvg(slotIsLocked(slot))}</span><span>${slotIsLocked(slot) ? 'Locked' : 'Lock'}</span></button>
           <button type="button" class="meal-action today-regenerate-meal" ${slotIsLocked(slot) ? 'disabled' : ''} title="Regenerate this meal"><span aria-hidden="true">↻</span><span>Regenerate</span></button>
           <button type="button" class="meal-action today-change-meal" title="Choose a different recipe"><span aria-hidden="true">⇄</span><span>Change</span></button>
           <button type="button" class="meal-action danger-action today-remove-meal" title="Remove this meal"><span aria-hidden="true">⌫</span><span>Remove</span></button>
         </div>`
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
  wrap.className = `meal-slot${slot ? ' has-meal' : ''}${slotIsLocked(slot) ? ' is-locked' : ''}`;

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'meal-slot-main';
  main.innerHTML = `
    <span class="meal-slot-header"><span class="meal-slot-label">${mealLabel(meal)}</span>${statusMarkup(slot)}</span>
    ${recipe
      ? `<span class="meal-name">${escapeHtml(recipe.name)}</span>
         <span class="meal-view-hint">Tap to view recipe <span aria-hidden="true">›</span></span>
         <span class="meal-meta">${recipe.prepTimeMin ? `${formatDurationMinutes(recipe.prepTimeMin)} · ` : ''}${slotPeopleCount(slot, recipe)} ${slotPeopleCount(slot, recipe) === 1 ? 'person' : 'people'}${slotIsLocked(slot) ? ' · 🔒 Locked' : ''}</span>`
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
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', `${mealLabel(meal)} actions`);

    const lock = document.createElement('button');
    lock.type = 'button';
    lock.className = `meal-slot-control${slotIsLocked(slot) ? ' is-locked' : ''}`;
    lock.innerHTML = lockIconSvg(slotIsLocked(slot), true);
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
    change.className = 'meal-slot-control';
    change.textContent = '⇄';
    change.title = 'Change meal';
    change.setAttribute('aria-label', change.title);
    change.addEventListener('click', () => openSlot(date, meal));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'meal-slot-control meal-slot-remove';
    remove.textContent = '⌫';
    remove.title = 'Remove meal';
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', async () => {
      const slotId = `${iso(date)}_${meal}`;
      await deleteDoc(doc(db, 'households', householdId, 'schedule', slotId)).catch(() => {});
      toast(`${mealLabel(meal)} removed`);
    });

    actions.append(lock, regen, change, remove);
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

  // The filter ceiling follows the longest recipe instead of being hard-capped at 30 min.
  // Keep at least a 60-minute range so the control is useful even with a small collection.
  if (els.recipeTimeFilter) {
    const previousMax = Math.max(1, Number(els.recipeTimeFilter.max) || 60);
    const previousValue = Math.max(1, Number(els.recipeTimeFilter.value) || previousMax);
    const wasShowingAll = previousValue >= previousMax;
    const longestRecipe = recipes.reduce((max, recipe) => {
      const minutes = Math.max(1, Math.round(Number(recipe.prepTimeMin) || 15));
      return Math.max(max, minutes);
    }, 60);

    els.recipeTimeFilter.max = String(longestRecipe);
    if (wasShowingAll || previousValue > longestRecipe) {
      els.recipeTimeFilter.value = String(longestRecipe);
    }
    if (els.recipeTimeFilterValue) {
      els.recipeTimeFilterValue.textContent = formatDurationMinutes(els.recipeTimeFilter.value);
    }
  }

  const maxTime = Number(els.recipeTimeFilter?.value || Number.POSITIVE_INFINITY);
  const filtered = recipes.filter(r => {
    const hay = normalizeText(`${r.name} ${(r.tags || []).join(' ')}`);
    const recipeTime = Math.max(1, Math.round(Number(r.prepTimeMin) || 15));
    return (!q || hay.includes(q))
      && (!tag || (r.tags || []).includes(tag))
      && recipeTime <= maxTime;
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
    card.innerHTML = `<div class="recipe-body"><h3>${escapeHtml(r.name)}</h3>
      <div class="tags recipe-card-tags"><span class="tag meal-type-tag">${escapeHtml(recipeMealTypeLabel(r))}</span><span class="tag recipe-time-tag" aria-label="Preparation time">⏱ ${formatDurationMinutes(Number(r.prepTimeMin) || 15)}</span>${(r.tags||[]).map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
      <p class="muted small">${(r.ingredients||[]).length} ingredients · Serves ${recipeServingCount(r)}</p>
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


function normalizeUnitForShopping(unit = '') {
  const u = normalizeText(unit).replace(/\./g, '');
  const map = {
    g: ['g','gram','grams','gramme','grammes'],
    kg: ['kg','kilogram','kilograms','kilogramme','kilogrammes'],
    ml: ['ml','milliliter','milliliters','millilitre','millilitres'],
    cl: ['cl','centiliter','centiliters','centilitre','centilitres'],
    l: ['l','liter','liters','litre','litres'],
    oz: ['oz','ounce','ounces'],
    lb: ['lb','lbs','pound','pounds'],
    tsp: ['tsp','teaspoon','teaspoons','c à café','c a café','cuillère à café','cuilleres à café'],
    tbsp: ['tbsp','tablespoon','tablespoons','c à soupe','c a soupe','cuillère à soupe','cuilleres à soupe'],
    cup: ['cup','cups'],
    clove: ['clove','cloves','gousse','gousses'],
    cube: ['cube','cubes'],
    can: ['can','cans','tin','tins','boîte','boîtes','boite','boites'],
    slice: ['slice','slices','tranche','tranches'],
    pack: ['pack','packs','package','packages','sachet','sachets'],
    pinch: ['pinch','pinches','pincée','pincées','pincee','pincees'],
    piece: ['piece','pieces','pc','pcs','morceau','morceaux']
  };
  for (const [canonical, aliases] of Object.entries(map)) {
    if (aliases.includes(u)) return canonical;
  }
  return u;
}

function shoppingBaseUnit(unit = '') {
  const u = normalizeUnitForShopping(unit);
  if (u === 'kg') return { unit: 'g', factor: 1000 };
  if (u === 'lb') return { unit: 'g', factor: 453.59237 };
  if (u === 'oz') return { unit: 'g', factor: 28.349523125 };
  if (u === 'l') return { unit: 'ml', factor: 1000 };
  if (u === 'cl') return { unit: 'ml', factor: 10 };
  if (u === 'tbsp') return { unit: 'tsp', factor: 3 };
  return { unit: u, factor: 1 };
}

function displayShoppingIngredientName(name = '') {
  // Shopping keeps the recipe ingredient wording exactly as the user entered it.
  // No aliasing, fuzzy matching, generic-to-specific conversion, or automatic
  // ingredient-name merging is performed. Manual merge in Review is the only
  // way different ingredient rows are combined.
  return String(name ?? '').trim();
}

function fractionNumber(text) {
  if (typeof text === 'number' && Number.isFinite(text)) return text;
  let t = String(text ?? '').trim().replace(',', '.');
  const unicode = { '¼': .25, '½': .5, '¾': .75, '⅓': 1/3, '⅔': 2/3, '⅛': .125, '⅜': .375, '⅝': .625, '⅞': .875 };
  if (unicode[t] != null) return unicode[t];
  const mixedUnicode = t.match(/^(\d+)\s*([¼½¾⅓⅔⅛⅜⅝⅞])$/);
  if (mixedUnicode) return Number(mixedUnicode[1]) + unicode[mixedUnicode[2]];
  const frac = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac && Number(frac[2])) return Number(frac[1]) / Number(frac[2]);
  const mixed = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed && Number(mixed[3])) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function scaledQuantity(raw, multiplier, unitFactor = 1) {
  if (raw === '' || raw == null) return { number: null, min: null, max: null, text: '' };
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const value = raw * multiplier * unitFactor;
    return { number: value, min: value, max: value, text: '' };
  }
  const t = String(raw).trim();
  const range = t.match(/^(.+?)\s*[–—-]\s*(.+)$/);
  if (range) {
    const a = fractionNumber(range[1]), b = fractionNumber(range[2]);
    if (a != null && b != null) {
      const min = Math.min(a, b) * multiplier * unitFactor;
      const max = Math.max(a, b) * multiplier * unitFactor;
      return { number: null, min, max, text: '' };
    }
  }
  const n = fractionNumber(t);
  if (n != null) {
    const value = n * multiplier * unitFactor;
    return { number: value, min: value, max: value, text: '' };
  }
  return { number: null, min: null, max: null, text: t };
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return '';
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function slotPeopleCount(slot, recipe) {
  const v = Number(slot?.people);
  if (Number.isFinite(v) && v > 0) return v;
  const d = Number(settings.defaultPeople);
  if (Number.isFinite(d) && d > 0) return d;
  const r = Number(recipe?.servings);
  return Number.isFinite(r) && r > 0 ? r : 2;
}

function formatDurationMinutes(value) {
  const minutes = Math.max(0, Math.round(Number(value) || 0));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}:${String(remainder).padStart(2, '0')}`;
}

function recipeServingCount(recipe) {
  const n = Number(recipe?.servings);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

function shoppingEntryKey(slot, recipe, ingredientIndex) {
  const slotKey = slot?.id || `${slot?.date || 'date'}_${slot?.meal || 'meal'}`;
  return `${slotKey}|${recipe?.id || 'recipe'}|${ingredientIndex}`;
}

function shoppingSentWeekMap() {
  return settings?.shoppingSentHistory?.[iso(weekStart)] || {};
}

function shoppingSourceSignature(entry) {
  return JSON.stringify({
    recipeId: entry.recipeId,
    slotId: entry.slotId,
    people: entry.people,
    ingredientIndex: entry.ingredientIndex,
    name: normalizeText(entry.name),
    unit: normalizeText(entry.unit),
    quantity: entry.sourceQuantity
  });
}

function rawShoppingEntries() {
  const entries = [];
  for (const slot of getWeekSlots(true)) {
    const recipe = recipeById(slot.recipeId);
    if (!recipe) continue;
    const people = slotPeopleCount(slot, recipe);
    const multiplier = people / recipeServingCount(recipe);

    (recipe.ingredients || []).forEach((ing, ingredientIndex) => {
      const name = displayShoppingIngredientName(ing.name || '');
      if (!name) return;
      const unit = normalizeUnitForShopping(ing.unit || '');
      const sourceKey = shoppingEntryKey(slot, recipe, ingredientIndex);
      const scaled = scaledQuantity(ing.quantity, multiplier, 1);
      const sourceComponent = {
        unit,
        minQuantity: scaled.min ?? 0,
        maxQuantity: scaled.max ?? 0,
        hasNumericQuantity: scaled.min != null && scaled.max != null,
        textQuantities: scaled.text ? [scaled.text] : []
      };
      const sourceQuantity = formatShoppingComponent(sourceComponent);
      const sourceLine = `${name}${sourceQuantity ? ` — ${sourceQuantity}` : ''}`;
      const entry = {
        key: sourceKey,
        slotId: slot?.id || `${slot?.date || 'date'}_${slot?.meal || 'meal'}`,
        recipeId: recipe.id,
        ingredientIndex,
        people,
        name,
        unit,
        component: sourceComponent,
        sourceQuantity,
        sourceLine
      };
      entry.signature = shoppingSourceSignature(entry);
      entries.push(entry);
    });
  }
  return entries;
}

function isShoppingEntrySent(entry) {
  return shoppingSentWeekMap()?.[entry.key] === entry.signature;
}

function mergedShoppingItems(options = {}) {
  // Exact-match only. Sent and unsent entries are never auto-merged together,
  // which keeps reminder-history quantities unambiguous.
  const mode = options.sentMode || 'all'; // all | unsent | sent
  const separateSentState = !!options.separateSentState;
  const groups = new Map();

  for (const entry of rawShoppingEntries()) {
    const sent = isShoppingEntrySent(entry);
    if (mode === 'unsent' && sent) continue;
    if (mode === 'sent' && !sent) continue;

    const normalizedName = normalizeText(entry.name);
    const normalizedUnit = normalizeText(entry.unit);
    const groupKey = `exact:${normalizedName}|${normalizedUnit}${separateSentState ? `|${sent ? 'sent' : 'unsent'}` : ''}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        key: groupKey,
        sourceKeys: [],
        sourceSignatures: {},
        name: entry.name,
        sources: 0,
        sourceRecipeIds: new Set(),
        components: [],
        sourceLines: [],
        sentCount: 0,
        unsentCount: 0
      });
    }

    const item = groups.get(groupKey);
    item.sourceKeys.push(entry.key);
    item.sourceSignatures[entry.key] = entry.signature;
    item.sources += 1;
    item.sourceRecipeIds.add(entry.recipeId);
    item.sourceLines.push(entry.sourceLine);
    if (sent) item.sentCount += 1; else item.unsentCount += 1;

    let component = item.components.find(c => c.unit === entry.unit);
    if (!component) {
      component = {
        unit: entry.unit,
        minQuantity: 0,
        maxQuantity: 0,
        hasNumericQuantity: false,
        textQuantities: []
      };
      item.components.push(component);
    }
    if (entry.component.hasNumericQuantity) {
      component.hasNumericQuantity = true;
      component.minQuantity += entry.component.minQuantity;
      component.maxQuantity += entry.component.maxQuantity;
    }
    if (entry.component.textQuantities?.length) {
      component.textQuantities.push(...entry.component.textQuantities);
    }
  }

  return [...groups.values()]
    .map(item => ({
      ...item,
      sourceRecipeCount: item.sourceRecipeIds.size,
      sourceRecipeIds: [...item.sourceRecipeIds],
      mergedBy: item.sources > 1 ? 'app' : '',
      sourceLines: item.sourceLines,
      sentStatus: item.sentCount > 0 && item.unsentCount === 0 ? 'sent' : (item.unsentCount > 0 && item.sentCount === 0 ? 'unsent' : 'mixed')
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

function formatShoppingComponent(component) {
  const pieces = [];
  if (component.hasNumericQuantity) {
    let min = component.minQuantity;
    let max = component.maxQuantity;
    let unit = component.unit || '';
    if (unit === 'g' && min >= 1000 && max >= 1000) { min /= 1000; max /= 1000; unit = 'kg'; }
    if (unit === 'ml' && min >= 1000 && max >= 1000) { min /= 1000; max /= 1000; unit = 'L'; }
    const quantityText = Math.abs(max - min) < 1e-9
      ? formatNumber(min)
      : `${formatNumber(min)}–${formatNumber(max)}`;
    pieces.push(`${quantityText}${unit ? ` ${unit}` : ''}`);
  }
  if (component.textQuantities?.length) {
    const unique = [...new Set(component.textQuantities)];
    pieces.push(`${unique.join(' + ')}${component.unit ? ` ${component.unit}` : ''}`.trim());
  }
  return pieces.join(' + ');
}

function formatQty(item) {
  return (item.components || [])
    .map(formatShoppingComponent)
    .filter(Boolean)
    .join(' + ');
}

function shoppingLine(item) {
  const qty = formatQty(item);
  return `${item.name}${qty ? ` — ${qty}` : ''}`;
}

function shoppingText() {
  return mergedShoppingItems().map(shoppingLine).join('\n');
}

function shoppingPayload() {
  return {
    schema: 'meal-planner.shopping.v4',
    weekStart: iso(weekStart),
    generatedAt: new Date().toISOString(),
    items: mergedShoppingItems().map(i => ({
      name: i.name,
      displayQuantity: formatQty(i),
      components: i.components.map(c => ({
        unit: c.unit,
        minQuantity: c.hasNumericQuantity ? c.minQuantity : null,
        maxQuantity: c.hasNumericQuantity ? c.maxQuantity : null,
        textQuantities: c.textQuantities
      }))
    }))
  };
}

function renderShopping() {
  const items = mergedShoppingItems();
  els.shoppingList.innerHTML = items.length
    ? items.map(i => `<div class="shopping-item"><span><strong>${escapeHtml(i.name)}</strong></span><span class="shopping-qty">${escapeHtml(formatQty(i))}</span></div>`).join('')
    : '<div class="empty-state">Schedule meals this week to build a shopping list.</div>';
  els.shoppingJson.textContent = JSON.stringify(shoppingPayload(), null, 2);
}

function shoppingDraftStorageKey() {
  return `mp_shopping_review:${householdId || 'local'}:${iso(weekStart)}`;
}

function shoppingReviewKey(item) {
  return item?.key || `ingredient:${normalizeText(item?.name || '')}:${Math.random().toString(36).slice(2)}`;
}

function currentShoppingReviewSource(mode = shoppingReviewMode) {
  const sentMode = mode === 'all' ? 'all' : 'unsent';
  return mergedShoppingItems({ sentMode, separateSentState: mode === 'all' }).map(item => ({
    key: shoppingReviewKey(item),
    sourceKeys: item.sourceKeys || [shoppingReviewKey(item)],
    sourceSignatures: item.sourceSignatures || {},
    name: item.name,
    quantity: formatQty(item),
    mergedBy: item.mergedBy || '',
    sourceLines: item.sourceLines || [],
    sentStatus: item.sentStatus || 'unsent'
  }));
}

function loadShoppingReviewDraft() {
  try {
    const raw = localStorage.getItem(shoppingDraftStorageKey());
    if (!raw) return null;
    const draft = JSON.parse(raw);
    return draft?.weekStart === iso(weekStart) && Array.isArray(draft.rows) ? draft : null;
  } catch (err) {
    console.warn('Could not read shopping draft:', err);
    return null;
  }
}

function serializeShoppingReviewDraft() {
  const rows = [...els.shoppingReviewList.querySelectorAll('.shopping-review-row')].map(row => ({
    sourceKeys: JSON.parse(row.dataset.sourceKeys || '[]'),
    sourceSignatures: JSON.parse(row.dataset.sourceSignatures || '{}'),
    sentStatus: row.dataset.sentStatus || 'unsent',
    name: row.querySelector('.shopping-review-name')?.value.trim() || '',
    quantity: row.querySelector('.shopping-review-qty')?.value.trim() || '',
    originalName: row.dataset.originalName || '',
    originalQuantity: row.dataset.originalQuantity || '',
    nameEdited: row.dataset.nameEdited === 'true',
    quantityEdited: row.dataset.quantityEdited === 'true',
    ignored: row.classList.contains('is-ignored'),
    mergedBy: row.dataset.mergedBy || '',
    sourceLines: JSON.parse(row.dataset.sourceLines || '[]')
  }));
  return {
    schema: 'meal-planner.shopping-review.v1',
    weekStart: iso(weekStart),
    savedAt: new Date().toISOString(),
    rows,
    removedSourceKeys: []
  };
}

function saveShoppingReviewDraft(showToast = false) {
  if (!els.shoppingReviewList) return;
  try {
    const draft = serializeShoppingReviewDraft();
    localStorage.setItem(shoppingDraftStorageKey(), JSON.stringify(draft));
    if (els.shoppingDraftStatus) els.shoppingDraftStatus.textContent = `Saved ${new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;
    if (showToast) toast('Shopping review saved');
  } catch (err) {
    console.error('Could not save shopping review:', err);
    if (showToast) toast('Could not save shopping review');
  }
}

function scheduleShoppingReviewAutosave() {
  clearTimeout(shoppingReviewAutosaveTimer);
  shoppingReviewAutosaveTimer = setTimeout(() => saveShoppingReviewDraft(false), 300);
}

function clearShoppingReviewDraft() {
  localStorage.removeItem(shoppingDraftStorageKey());
  shoppingReviewRemovedKeys = new Set();
  if (els.shoppingDraftStatus) els.shoppingDraftStatus.textContent = 'No saved draft';
}

function reconcileShoppingReviewDraft(source, draft) {
  const sourceMap = new Map();
  source.forEach(item => {
    sourceMap.set(item.key, item);
    (item.sourceKeys || []).forEach(key => sourceMap.set(key, item));
  });
  const consumed = new Set();
  shoppingReviewRemovedKeys = new Set((draft?.removedSourceKeys || []).filter(key => sourceMap.has(key)));
  const rows = [];

  for (const saved of draft?.rows || []) {
    const sourceKeys = (saved.sourceKeys || []).filter(key => sourceMap.has(key));
    if (!sourceKeys.length) continue;
    sourceKeys.forEach(key => consumed.add(key));
    const currentItems = [...new Set(sourceKeys.map(key => sourceMap.get(key)).filter(Boolean))];
    const currentQuantity = mergeReviewQuantities(currentItems.map(item => item.quantity));
    const fallbackName = currentItems[0]?.name || saved.name || '';
    const mergedBy = saved.mergedBy === 'user'
      ? 'user'
      : (currentItems.some(item => item.mergedBy === 'app') ? 'app' : '');
    const sourceLines = saved.mergedBy === 'user'
      ? (saved.sourceLines || [])
      : currentItems.flatMap(item => item.sourceLines || []);
    const sourceSignatures = Object.assign({}, ...currentItems.map(item => item.sourceSignatures || {}));
    const sentStatus = currentItems.every(item => item.sentStatus === 'sent') ? 'sent' : 'unsent';
    rows.push({
      sourceKeys,
      sourceSignatures,
      sentStatus,
      name: saved.nameEdited || sourceKeys.length > 1 ? saved.name : fallbackName,
      quantity: saved.quantityEdited ? saved.quantity : currentQuantity,
      originalName: fallbackName,
      originalQuantity: currentQuantity,
      nameEdited: !!saved.nameEdited || saved.mergedBy === 'user',
      quantityEdited: !!saved.quantityEdited,
      ignored: !!saved.ignored,
      mergedBy,
      sourceLines
    });
  }

  for (const item of source) {
    const itemSourceKeys = item.sourceKeys || [item.key];
    if (itemSourceKeys.every(key => consumed.has(key))) continue;
    rows.push({
      sourceKeys: item.sourceKeys || [item.key],
      sourceSignatures: item.sourceSignatures || {},
      sentStatus: item.sentStatus || 'unsent',
      name: item.name,
      quantity: item.quantity,
      originalName: item.name,
      originalQuantity: item.quantity,
      nameEdited: false,
      quantityEdited: false,
      ignored: false,
      mergedBy: item.mergedBy || '',
      sourceLines: item.sourceLines || []
    });
  }
  return rows;
}

function sortShoppingReviewRows() {
  if (!els.shoppingReviewList) return;
  const rows = [...els.shoppingReviewList.querySelectorAll('.shopping-review-row')];
  rows.sort((a, b) => {
    const aIgnored = a.classList.contains('is-ignored');
    const bIgnored = b.classList.contains('is-ignored');
    if (aIgnored !== bIgnored) return aIgnored ? 1 : -1;
    const aName = a.querySelector('.shopping-review-name')?.value.trim() || '';
    const bName = b.querySelector('.shopping-review-name')?.value.trim() || '';
    return aName.localeCompare(bName, undefined, { sensitivity: 'base', numeric: true });
  });
  rows.forEach(row => els.shoppingReviewList.appendChild(row));
}

function renderShoppingReviewForMode(mode = shoppingReviewMode, options = {}) {
  shoppingReviewMode = mode === 'all' ? 'all' : 'unsent';
  shoppingReviewSource = currentShoppingReviewSource(shoppingReviewMode);
  const draft = loadShoppingReviewDraft();
  const rows = reconcileShoppingReviewDraft(shoppingReviewSource, draft);
  els.shoppingReviewList.innerHTML = '';
  rows.forEach(item => addShoppingReviewRow(item));
  sortShoppingReviewRows();
  if (els.shoppingReviewMode) els.shoppingReviewMode.value = shoppingReviewMode;
  if (els.shoppingDraftStatus) {
    const unsentCount = rawShoppingEntries().filter(entry => !isShoppingEntrySent(entry)).length;
    els.shoppingDraftStatus.textContent = draft
      ? `Autosaved · ${unsentCount} source item${unsentCount === 1 ? '' : 's'} not sent`
      : `${unsentCount} source item${unsentCount === 1 ? '' : 's'} not sent · autosaves`;
  }
  updateShoppingMergeToolbar();
  if (!options.keepOpen && !els.shoppingReviewDialog.open) els.shoppingReviewDialog.showModal();
}

function openShoppingReview() {
  shoppingReviewMode = 'unsent';
  if (!rawShoppingEntries().length) return toast('Shopping list is empty');
  renderShoppingReviewForMode('unsent');
  const draft = loadShoppingReviewDraft();
  if (draft) toast('Saved shopping review resumed');
}

function addShoppingReviewRow(item, options = {}) {
  const parsed = typeof item === 'string' ? parseShoppingReviewLine(item) : item;
  const row = document.createElement('div');
  row.className = 'shopping-review-row';
  const sourceKeys = options.sourceKeys || parsed.sourceKeys || [];
  row.dataset.sourceKeys = JSON.stringify(sourceKeys);
  row.dataset.sourceSignatures = JSON.stringify(options.sourceSignatures ?? parsed.sourceSignatures ?? {});
  row.dataset.sentStatus = options.sentStatus ?? parsed.sentStatus ?? 'unsent';
  row.dataset.originalName = options.originalName ?? parsed.originalName ?? parsed.name ?? '';
  row.dataset.originalQuantity = options.originalQuantity ?? parsed.originalQuantity ?? parsed.quantity ?? '';
  row.dataset.nameEdited = String(options.nameEdited ?? parsed.nameEdited ?? false);
  row.dataset.quantityEdited = String(options.quantityEdited ?? parsed.quantityEdited ?? false);
  row.dataset.mergedBy = options.mergedBy ?? parsed.mergedBy ?? '';
  row.dataset.sourceLines = JSON.stringify(options.sourceLines ?? parsed.sourceLines ?? []);
  const mergeBadge = row.dataset.mergedBy === 'app'
    ? '<span class="shopping-merge-badge app-merged">App merged</span>'
    : row.dataset.mergedBy === 'user'
      ? '<span class="shopping-merge-badge user-merged">You merged</span>'
      : '';
  const sentBadge = row.dataset.sentStatus === 'sent'
    ? '<span class="shopping-sent-badge">Sent to Reminders</span>'
    : '<span class="shopping-unsent-badge">Not sent</span>';
  const sourceLines = JSON.parse(row.dataset.sourceLines || '[]');
  const sourceDetail = row.dataset.mergedBy && sourceLines.length > 1
    ? `<details class="shopping-merge-detail"><summary>${sourceLines.length} original entries</summary><div>${sourceLines.map(line => `<span>${escapeHtml(line)}</span>`).join('')}</div></details>`
    : '';
  row.innerHTML = `
    <label class="shopping-review-select">
      <input class="shopping-review-checkbox" type="checkbox" aria-label="Select shopping item for merge">
    </label>
    <div class="shopping-review-content">
      <div class="shopping-review-fields">
        <input class="shopping-review-name" value="${escapeHtml(parsed.name || '')}" aria-label="Ingredient" placeholder="Ingredient">
        <input class="shopping-review-qty" value="${escapeHtml(parsed.quantity || '')}" aria-label="Quantity" placeholder="Quantity">
      </div>
      <div class="shopping-review-meta">${sentBadge}${mergeBadge}${sourceDetail}</div>
    </div>
    <button type="button" class="shopping-review-ignore" aria-pressed="false">Ignore</button>`;

  const checkbox = row.querySelector('.shopping-review-checkbox');
  const ignore = row.querySelector('.shopping-review-ignore');
  const nameInput = row.querySelector('.shopping-review-name');
  const qtyInput = row.querySelector('.shopping-review-qty');
  const rowIsSent = row.dataset.sentStatus === 'sent';
  row.classList.toggle('is-sent', rowIsSent);
  if (rowIsSent) {
    checkbox.disabled = true;
    nameInput.readOnly = true;
    qtyInput.readOnly = true;
    ignore.disabled = true;
    ignore.textContent = 'Sent';
  }
  checkbox.checked = !!options.selected;
  checkbox.addEventListener('change', updateShoppingMergeToolbar);

  nameInput.addEventListener('input', () => {
    row.dataset.nameEdited = String(nameInput.value.trim() !== row.dataset.originalName);
    scheduleShoppingReviewAutosave();
  });
  // Do not move the row while the user is typing. Re-sort only after the
  // ingredient field loses focus / the edit is committed.
  nameInput.addEventListener('change', sortShoppingReviewRows);
  qtyInput.addEventListener('input', () => {
    row.dataset.quantityEdited = String(qtyInput.value.trim() !== row.dataset.originalQuantity);
    scheduleShoppingReviewAutosave();
  });

  const setIgnored = ignored => {
    if (rowIsSent) return;
    row.classList.toggle('is-ignored', ignored);
    ignore.textContent = ignored ? 'Use' : 'Ignore';
    ignore.setAttribute('aria-pressed', String(ignored));
    checkbox.checked = false;
    checkbox.disabled = ignored;
    updateShoppingMergeToolbar();
    scheduleShoppingReviewAutosave();
    sortShoppingReviewRows();
  };
  ignore.addEventListener('click', () => setIgnored(!row.classList.contains('is-ignored')));

  els.shoppingReviewList.appendChild(row);
  if (!rowIsSent) setIgnored(!!(options.ignored ?? parsed.ignored));
}

function resetShoppingReviewToGenerated() {
  if (!els.shoppingReviewList) return;
  const confirmed = confirm('Reset this review to the shopping list generated from the current meal plan? Your manual edits, ignores and merges for this review will be cleared.');
  if (!confirmed) return;

  localStorage.removeItem(shoppingDraftStorageKey());
  shoppingReviewRemovedKeys = new Set();
  shoppingReviewSource = currentShoppingReviewSource();
  els.shoppingReviewList.innerHTML = '';
  shoppingReviewSource.forEach(item => addShoppingReviewRow(item));
  sortShoppingReviewRows();
  updateShoppingMergeToolbar();
  if (els.shoppingDraftStatus) els.shoppingDraftStatus.textContent = 'Reset to current generated list · autosave active';
  toast('Shopping review reset');
}

function selectedShoppingReviewRows() {
  return [...els.shoppingReviewList.querySelectorAll('.shopping-review-row')]
    .filter(row => !row.classList.contains('is-ignored'))
    .filter(row => row.dataset.sentStatus !== 'sent')
    .filter(row => row.querySelector('.shopping-review-checkbox')?.checked);
}

function updateShoppingMergeToolbar() {
  if (!els.mergeSelectedShopping) return;
  const count = selectedShoppingReviewRows().length;
  const floating = els.mergeSelectedShopping.closest('.shopping-review-floating');
  els.mergeSelectedShopping.disabled = count < 2;
  els.mergeSelectedShopping.textContent = count < 2 ? 'Merge selected' : `Merge selected (${count})`;
  floating?.classList.toggle('is-visible', count >= 2);
  if (els.shoppingMergeSelectionCount) {
    els.shoppingMergeSelectionCount.textContent = count < 2 ? '' : `${count} selected`;
  }
}

function parseShoppingReviewLine(line = '') {
  const [namePart, ...qtyParts] = String(line).split(/\s+—\s+/);
  return {
    sourceKeys: [],
    name: (namePart || '').trim(),
    quantity: qtyParts.join(' — ').trim()
  };
}

function parseReviewQuantityTerm(term = '') {
  const t = String(term).trim();
  const m = t.match(/^(.+?)\s+([A-Za-zÀ-ÿ.]+(?:\s+[A-Za-zÀ-ÿ.]+)*)$/);
  if (!m) return null;
  const rawQty = m[1].trim();
  const normalizedUnit = normalizeUnitForShopping(m[2].trim());
  const base = shoppingBaseUnit(normalizedUnit);
  const scaled = scaledQuantity(rawQty, 1, base.factor);
  if (scaled.min == null || scaled.max == null) return null;
  return { unit: base.unit, min: scaled.min, max: scaled.max };
}

function mergeReviewQuantities(quantityStrings = []) {
  const totals = new Map();
  const leftovers = [];
  for (const quantityString of quantityStrings) {
    if (!quantityString) continue;
    const terms = quantityString.split(/\s+\+\s+/).map(v => v.trim()).filter(Boolean);
    for (const term of terms) {
      const parsed = parseReviewQuantityTerm(term);
      if (!parsed) {
        leftovers.push(term);
        continue;
      }
      const current = totals.get(parsed.unit) || { unit: parsed.unit, min: 0, max: 0 };
      current.min += parsed.min;
      current.max += parsed.max;
      totals.set(parsed.unit, current);
    }
  }
  const merged = [...totals.values()].map(item => {
    const qty = Math.abs(item.max - item.min) < 1e-9
      ? formatNumber(item.min)
      : `${formatNumber(item.min)}–${formatNumber(item.max)}`;
    return `${qty}${item.unit ? ` ${item.unit}` : ''}`;
  });
  return [...merged, ...leftovers].join(' + ');
}

function mergeSelectedShoppingRows() {
  const rows = selectedShoppingReviewRows();
  if (rows.length < 2) return;
  const parsed = rows.map(row => ({
    name: row.querySelector('.shopping-review-name')?.value.trim() || '',
    quantity: row.querySelector('.shopping-review-qty')?.value.trim() || '',
    sourceKeys: JSON.parse(row.dataset.sourceKeys || '[]'),
    sourceSignatures: JSON.parse(row.dataset.sourceSignatures || '{}'),
    sentStatus: row.dataset.sentStatus || 'unsent',
    sourceLines: JSON.parse(row.dataset.sourceLines || '[]')
  }));
  const suggestedName = parsed[0]?.name || 'Merged item';
  const customName = prompt('Name the merged shopping item:', suggestedName);
  if (customName == null) return;
  const name = customName.trim();
  if (!name) return toast('Enter a name for the merged item');

  const mergedQuantity = mergeReviewQuantities(parsed.map(item => item.quantity));
  const firstRow = rows[0];
  const sourceKeys = [...new Set(parsed.flatMap(item => item.sourceKeys))];
  const sourceSignatures = Object.assign({}, ...parsed.map(item => item.sourceSignatures || {}));
  firstRow.dataset.sourceKeys = JSON.stringify(sourceKeys);
  firstRow.dataset.sourceSignatures = JSON.stringify(sourceSignatures);
  firstRow.dataset.sentStatus = 'unsent';
  firstRow.dataset.originalName = name;
  firstRow.dataset.originalQuantity = mergedQuantity;
  firstRow.dataset.nameEdited = 'true';
  firstRow.dataset.quantityEdited = 'false';
  firstRow.dataset.mergedBy = 'user';
  const mergedSourceLines = parsed.flatMap(item => item.sourceLines?.length ? item.sourceLines : [`${item.name}${item.quantity ? ` — ${item.quantity}` : ''}`]);
  firstRow.dataset.sourceLines = JSON.stringify(mergedSourceLines);
  firstRow.querySelector('.shopping-review-name').value = name;
  firstRow.querySelector('.shopping-review-qty').value = mergedQuantity;
  const meta = firstRow.querySelector('.shopping-review-meta');
  if (meta) {
    meta.innerHTML = `<span class="shopping-merge-badge user-merged">You merged</span><details class="shopping-merge-detail"><summary>${mergedSourceLines.length} original entries</summary><div>${mergedSourceLines.map(line => `<span>${escapeHtml(line)}</span>`).join('')}</div></details>`;
  }
  firstRow.querySelector('.shopping-review-checkbox').checked = false;
  rows.slice(1).forEach(row => row.remove());
  updateShoppingMergeToolbar();
  sortShoppingReviewRows();
  saveShoppingReviewDraft(false);
  toast(`Merged ${rows.length} items as ${name}`);
}

function reviewedShoppingText() {
  return [...els.shoppingReviewList.querySelectorAll('.shopping-review-row')]
    .filter(row => !row.classList.contains('is-ignored'))
    .filter(row => row.dataset.sentStatus !== 'sent')
    .map(row => {
      const name = row.querySelector('.shopping-review-name')?.value.trim() || '';
      const quantity = row.querySelector('.shopping-review-qty')?.value.trim() || '';
      return name ? `${name}${quantity ? ` — ${quantity}` : ''}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

async function copyReviewedShopping() {
  const text = reviewedShoppingText();
  if (!text) return toast('Shopping list is empty');
  await navigator.clipboard.writeText(text);
  saveShoppingReviewDraft(false);
  toast('Reviewed shopping list copied');
}

async function markReviewedShoppingAsSent() {
  const rows = [...els.shoppingReviewList.querySelectorAll('.shopping-review-row')]
    .filter(row => !row.classList.contains('is-ignored'))
    .filter(row => row.dataset.sentStatus !== 'sent');
  if (!rows.length) return 0;

  const history = { ...(settings.shoppingSentHistory || {}) };
  const weekKey = iso(weekStart);
  const weekMap = { ...(history[weekKey] || {}) };
  let count = 0;
  for (const row of rows) {
    const signatures = JSON.parse(row.dataset.sourceSignatures || '{}');
    for (const [key, signature] of Object.entries(signatures)) {
      if (!key || !signature) continue;
      weekMap[key] = signature;
      count += 1;
    }
  }
  history[weekKey] = weekMap;

  // Keep shared reminder history bounded. Eight recent week keys is ample for
  // avoiding accidental duplicate sends while preventing unbounded growth.
  const weekKeys = Object.keys(history).sort();
  while (weekKeys.length > 8) delete history[weekKeys.shift()];

  settings = { ...settings, shoppingSentHistory: history };
  await setDoc(
    doc(db, 'households', householdId, 'settings', 'shared'),
    { shoppingSentHistory: history, shoppingSentUpdatedAt: serverTimestamp() },
    { merge: true }
  );
  return count;
}

async function sendReviewedShopping() {
  const text = reviewedShoppingText();
  if (!text) return toast('No unsent shopping items');
  await navigator.clipboard.writeText(text);
  await markReviewedShoppingAsSent();
  saveShoppingReviewDraft(false);
  els.shoppingReviewDialog.close();
  const url = `shortcuts://run-shortcut?name=${encodeURIComponent(settings.shortcutName || 'Kitchen Week to Reminders')}&input=clipboard`;
  window.location.href = url;
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

function normalizeInstructionText(text = '') {
  return text
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t]+/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/&#x9;/gi, ' ')
    .trim();
}

function parseInstructionSteps(text = '') {
  const clean = normalizeInstructionText(text);
  if (!clean) return [];

  const lines = clean.split('\n').map(line => line.trim()).filter(Boolean);
  const steps = [];
  let current = null;

  const numbered = /^(?:step\s*)?(\d{1,2})\s*[\.\)\-:]\s*(.+)$/i;
  const escapedNumbered = /^(\d{1,2})\\\.\s*(.+)$/;
  const emojiNumber = /^(\d{1,2})?[\u0030-\u0039]?\ufe0f?\u20e3\s*(.*)$/;
  const bullet = /^[•*\-–—]\s*(.+)$/;

  function pushCurrent() {
    if (!current) return;
    const textValue = current.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (textValue) steps.push({ text: textValue });
    current = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/^#+\s*/, '').trim();
    let match = line.match(escapedNumbered) || line.match(numbered);

    if (!match) {
      const emojiMatch = line.match(emojiNumber);
      if (emojiMatch && /\u20e3/.test(line)) {
        match = [line, emojiMatch[1] || '', emojiMatch[2] || ''];
      }
    }

    if (match) {
      pushCurrent();
      current = { parts: [match[2] || match[1] || line] };
      continue;
    }

    const bulletMatch = line.match(bullet);
    if (bulletMatch) {
      if (!current) current = { parts: [] };
      current.parts.push(bulletMatch[1]);
      continue;
    }

    // Short standalone headings such as "Prepare the sauce" are kept with the
    // next instruction instead of becoming visually detached.
    if (current) {
      current.parts.push(line);
    } else {
      current = { parts: [line] };
    }
  }
  pushCurrent();

  // If a recipe was saved as one large paragraph, split obvious sentence groups
  // so the cooking view still has usable chronological steps.
  if (steps.length === 1 && steps[0].text.length > 260) {
    const chunks = steps[0].text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
    return chunks.map(s => s.trim()).filter(Boolean).map(text => ({ text }));
  }

  return steps;
}

function setRecipeReaderSection(section) {
  const isSteps = section === 'steps';
  els.recipeIngredientsTab.classList.toggle('active', !isSteps);
  els.recipeStepsTab.classList.toggle('active', isSteps);
  els.recipeIngredientsPanel.classList.toggle('active', !isSteps);
  els.recipeStepsPanel.classList.toggle('active', isSteps);

  if (isSteps) {
    requestAnimationFrame(() => updateRecipeCurrentStep(true));
  }
}

function setRecipeCurrentStep(index, { scroll = false } = {}) {
  const items = [...els.recipeViewInstructions.querySelectorAll('.recipe-step')];
  if (!items.length) {
    els.recipeStepProgressText.textContent = 'No steps';
    return;
  }

  recipeReaderCurrentStep = Math.max(0, Math.min(index, items.length - 1));
  items.forEach((item, i) => {
    item.classList.toggle('is-current', i === recipeReaderCurrentStep);
    item.classList.toggle('is-complete', i < recipeReaderCurrentStep);
    const number = item.querySelector('.recipe-step-number');
    if (number) number.textContent = i < recipeReaderCurrentStep ? '✓' : String(i + 1);
  });
  els.recipeStepProgressText.textContent = `Step ${recipeReaderCurrentStep + 1} of ${items.length}`;

  if (scroll) {
    const target = items[recipeReaderCurrentStep];
    const reader = els.recipeReaderScroll;
    const readerRect = reader.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    // Position the selected step just below the sticky recipe tabs/progress bar.
    // Scrolling the dialog container directly is more reliable on iPhone Safari
    // than Element.scrollIntoView() inside a <dialog>.
    const readingOffset = 112;
    const destination = Math.max(0, reader.scrollTop + (targetRect.top - readerRect.top) - readingOffset);

    recipeReaderManualScrollUntil = performance.now() + 700;
    reader.scrollTo({ top: destination, behavior: 'smooth' });
  }
}

function updateRecipeCurrentStep(force = false) {
  const stepsPanelActive = els.recipeStepsPanel.classList.contains('active');
  if (!stepsPanelActive && !force) return;
  const items = [...els.recipeViewInstructions.querySelectorAll('.recipe-step')];
  if (!items.length) return;

  const readerRect = els.recipeReaderScroll.getBoundingClientRect();
  const targetY = readerRect.top + Math.min(readerRect.height * 0.34, 190);
  let bestIndex = 0;
  let bestDistance = Infinity;

  items.forEach((item, i) => {
    const rect = item.getBoundingClientRect();
    const anchorY = rect.top + Math.min(rect.height * 0.28, 40);
    const distance = Math.abs(anchorY - targetY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  });

  setRecipeCurrentStep(bestIndex);
}

function onRecipeReaderScroll() {
  if (performance.now() < recipeReaderManualScrollUntil) return;
  if (recipeReaderScrollTicking) return;
  recipeReaderScrollTicking = true;
  requestAnimationFrame(() => {
    recipeReaderScrollTicking = false;
    updateRecipeCurrentStep();
  });
}

function openRecipeView(recipe) {
  if (!recipe) return;
  viewedRecipeId = recipe.id;
  els.recipeViewName.textContent = recipe.name || 'Recipe';
  els.recipeViewMeta.textContent = `${recipe.prepTimeMin ? `${formatDurationMinutes(recipe.prepTimeMin)} · ` : ''}Serves ${recipeServingCount(recipe)}`;
  els.recipeViewTags.innerHTML = `<span class="tag meal-type-tag">${escapeHtml(recipeMealTypeLabel(recipe))}</span>` + (recipe.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');

  const groups = new Map();
  for (const ing of recipe.ingredients || []) {
    const group = ing.group || '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(ing);
  }

  const ingredientCount = (recipe.ingredients || []).length;
  els.recipeIngredientCount.textContent = ingredientCount ? `${ingredientCount} item${ingredientCount === 1 ? '' : 's'}` : '';
  if (!groups.size) {
    els.recipeViewIngredients.innerHTML = '<p class="muted">No ingredients saved.</p>';
  } else {
    els.recipeViewIngredients.innerHTML = [...groups.entries()].map(([group, items]) => `
      <section class="recipe-ingredient-group">
        ${group ? `<h4>${escapeHtml(group)}</h4>` : ''}
        <ul>${items.map(ing => `<li><span class="ingredient-dot" aria-hidden="true"></span><span>${escapeHtml(formatIngredientForView(ing))}</span></li>`).join('')}</ul>
      </section>
    `).join('');
  }

  const steps = parseInstructionSteps(recipe.instructions || '');
  els.recipeStepCount.textContent = steps.length ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : '';
  if (!steps.length) {
    els.recipeViewInstructions.innerHTML = '<p class="muted">No instructions saved.</p>';
    els.recipeStepProgressText.textContent = 'No steps';
  } else {
    els.recipeViewInstructions.innerHTML = steps.map((step, i) => `
      <article class="recipe-step${i === 0 ? ' is-current' : ''}" data-step-index="${i}" tabindex="0" role="button" aria-label="Step ${i + 1}">
        <div class="recipe-step-rail">
          <span class="recipe-step-number">${i + 1}</span>
          <span class="recipe-step-line" aria-hidden="true"></span>
        </div>
        <div class="recipe-step-body">
          <div class="recipe-step-current-label">Current step</div>
          <p>${escapeHtml(step.text)}</p>
        </div>
      </article>
    `).join('');
    [...els.recipeViewInstructions.querySelectorAll('.recipe-step')].forEach((item, i) => {
      item.addEventListener('click', () => setRecipeCurrentStep(i, { scroll: true }));
      item.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setRecipeCurrentStep(i, { scroll: true });
        }
      });
    });
    setRecipeCurrentStep(0);
  }

  setRecipeReaderSection('ingredients');
  els.recipeReaderScroll.scrollTop = 0;
  els.recipeViewDialog.showModal();
}

function editViewedRecipe() {
  const recipe = recipeById(viewedRecipeId);
  if (!recipe) return;
  els.recipeViewDialog.close();
  openRecipe(recipe);
}

function closeViewedRecipe() {
  els.recipeViewDialog.style.transform = '';
  els.recipeViewDialog.style.transition = '';
  els.recipeViewDialog.close();
}

function enableRecipePullToClose() {
  const scroller = els.recipeReaderScroll;
  const dialog = els.recipeViewDialog;
  if (!scroller || !dialog || scroller.dataset.pullCloseReady === 'true') return;
  scroller.dataset.pullCloseReady = 'true';

  let startY = 0;
  let dragY = 0;
  let pulling = false;

  scroller.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || scroller.scrollTop > 1) return;
    startY = e.touches[0].clientY;
    dragY = 0;
    pulling = true;
    dialog.style.transition = 'none';
  }, { passive: true });

  scroller.addEventListener('touchmove', e => {
    if (!pulling || e.touches.length !== 1) return;
    const delta = e.touches[0].clientY - startY;
    if (delta <= 0 || scroller.scrollTop > 1) {
      dragY = 0;
      dialog.style.transform = '';
      return;
    }
    dragY = Math.min(delta * 0.55, 150);
    dialog.style.transform = `translateY(${dragY}px)`;
    if (delta > 8) e.preventDefault();
  }, { passive: false });

  const finishPull = () => {
    if (!pulling) return;
    pulling = false;
    dialog.style.transition = 'transform 180ms ease';
    if (dragY >= 58) {
      dialog.style.transform = 'translateY(120%)';
      setTimeout(() => {
        if (dialog.open) dialog.close();
        dialog.style.transform = '';
        dialog.style.transition = '';
      }, 170);
    } else {
      dialog.style.transform = '';
      setTimeout(() => { dialog.style.transition = ''; }, 190);
    }
    dragY = 0;
  };

  scroller.addEventListener('touchend', finishPull, { passive: true });
  scroller.addEventListener('touchcancel', finishPull, { passive: true });
  dialog.addEventListener('close', () => {
    dialog.style.transform = '';
    dialog.style.transition = '';
    pulling = false;
    dragY = 0;
  });
}

function scaleRecipeEditorQuantity(raw, ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 1e-9) return String(raw ?? '');
  if (raw === '' || raw == null) return '';
  const text = String(raw).trim();
  const range = text.match(/^(.+?)\s*[–—-]\s*(.+)$/);
  if (range) {
    const a = fractionNumber(range[1]);
    const b = fractionNumber(range[2]);
    if (a != null && b != null) return `${formatNumber(a * ratio)}–${formatNumber(b * ratio)}`;
  }
  const n = fractionNumber(text);
  if (n != null) return formatNumber(n * ratio);
  // Non-numeric quantities such as "to taste" are intentionally unchanged.
  return text;
}

function updateRecipeServingsAndQuantities() {
  const nextServings = Number(els.recipeServings.value);
  if (!Number.isFinite(nextServings) || nextServings < 1) return;
  const previousServings = Number(recipeEditorServings) || nextServings;
  if (Math.abs(nextServings - previousServings) < 1e-9) return;
  const ratio = nextServings / previousServings;

  els.ingredientRows.querySelectorAll('.ingredient-row').forEach(row => {
    const qty = row.querySelector('.ing-qty');
    if (!qty) return;
    qty.value = scaleRecipeEditorQuantity(qty.value, ratio);
    qty.classList.add('qty-scaled-flash');
    setTimeout(() => qty.classList.remove('qty-scaled-flash'), 420);
  });
  recipeEditorServings = nextServings;
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

  const recipePrepTime = Math.max(1, Math.round(Number(recipe?.prepTimeMin) || 15));
  els.prepTime.value = String(recipePrepTime);
  els.prepTimeValue.textContent = formatDurationMinutes(recipePrepTime);

  els.recipeServings.value = recipeServingCount(recipe);
  recipeEditorServings = recipeServingCount(recipe);


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
      Math.max(1, Math.round(Number(els.prepTime.value) || 15)),

    servings:
      Math.max(1, Number(els.recipeServings.value) || 2),


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
  const existingSlot = scheduleFor(date, meal);
  els.slotPeople.value = slotPeopleCount(existingSlot, existingSlot ? recipeById(existingSlot.recipeId) : null);
  updateSlotPeoplePreview();
  els.removeMeal.hidden = !existingSlot;
  renderSlotRecipes();
  els.slotDialog.showModal();
}

function updateSlotPeoplePreview() {
  const people = Math.max(1, Number(els.slotPeople.value) || Number(settings.defaultPeople) || 2);
  const existingSlot = scheduleFor(currentSlotDate, currentSlotMeal);
  const recipe = existingSlot ? recipeById(existingSlot.recipeId) : null;
  if (!recipe) {
    els.slotScalePreview.textContent = 'Choose a recipe and shopping quantities will scale automatically.';
    return;
  }
  const serves = recipeServingCount(recipe);
  const multiplier = people / serves;
  els.slotScalePreview.textContent = `Recipe serves ${serves} · cooking for ${people} · shopping ×${formatNumber(multiplier)}`;
}

function updateCurrentSlotPeople() {
  const people = Number(els.slotPeople.value);
  if (!Number.isFinite(people) || people < 1 || !currentSlotDate) {
    updateSlotPeoplePreview();
    return;
  }

  updateSlotPeoplePreview();
  const existingSlot = scheduleFor(currentSlotDate, currentSlotMeal);
  if (!existingSlot) return; // The value will be used when a new recipe is chosen.

  const cleanPeople = Math.max(1, Math.round(people));
  existingSlot.people = cleanPeople;
  // Re-render immediately so Today/Week/Shopping react without waiting for Firestore.
  renderAll();

  clearTimeout(slotPeopleSaveTimer);
  slotPeopleSaveTimer = setTimeout(async () => {
    const slotId = `${iso(currentSlotDate)}_${currentSlotMeal}`;
    try {
      await setDoc(doc(db, 'households', householdId, 'schedule', slotId), {
        people: cleanPeople,
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (err) {
      console.error('Could not update people count:', err);
      toast(`Could not update people: ${err.message || err}`);
    }
  }, 250);
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
      : reason || `Serves ${recipeServingCount(r)} · ${r.prepTimeMin||0} min · eligible`;
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
    people: Math.max(1, Number(els.slotPeople.value) || Number(settings.defaultPeople) || 2),
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

function plannerPattern() {
  return els.weekPlanPattern?.value || 'daily';
}

function dinnerRepeatsAllowed() {
  return !!els.allowDinnerRepeats?.checked;
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
  if (els.weekPlanPattern) els.weekPlanPattern.value = 'daily';
  if (els.allowDinnerRepeats) els.allowDinnerRepeats.checked = false;
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

function shuffleArray(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function splitConsecutiveDates(dates) {
  if (!dates.length) return [];
  const groups = [[dates[0]]];
  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1];
    const current = dates[i];
    if (Math.round((current - prev) / 86400000) === 1) groups[groups.length - 1].push(current);
    else groups.push([current]);
  }
  return groups;
}

function patternBlocks(length, mode) {
  if (length <= 0) return [];
  if (mode === 'pairs') {
    const result = [];
    let left = length;
    while (left > 0) {
      const size = Math.min(2, left);
      result.push(size);
      left -= size;
    }
    return result;
  }
  if (mode === '223') {
    const seed = shuffleArray([2, 2, 3]);
    const result = [];
    let left = length;
    for (const requested of seed) {
      if (!left) break;
      const size = Math.min(requested, left);
      result.push(size);
      left -= size;
    }
    while (left > 0) {
      const size = Math.min(2, left);
      result.push(size);
      left -= size;
    }
    return result;
  }
  return Array.from({ length }, () => 1);
}

function balancedRepeatBlocks(dayCount, recipeCount) {
  if (dayCount <= 0 || recipeCount <= 0) return [];
  const base = Math.floor(dayCount / recipeCount);
  let remainder = dayCount % recipeCount;
  return Array.from({length: recipeCount}, () => base + (remainder-- > 0 ? 1 : 0)).filter(Boolean);
}

function collapseBlocksToCount(blocks, count) {
  if (count <= 0) return [];
  if (count >= blocks.length) return [...blocks];
  const total = blocks.reduce((sum, n) => sum + n, 0);
  const balanced = balancedRepeatBlocks(total, count);
  // Keep every recipe in one contiguous run. The exact pair/2-2-3 pattern is
  // preserved when enough distinct dinners exist; when the dinner pool is
  // smaller, adjacent blocks collapse instead of scattering a repeated recipe.
  return balanced;
}

function plannerCandidateAllowed(recipe, dates, meal, scheduleState) {
  if (!recipeSupportsMeal(recipe, meal)) return false;
  const blockDates = new Set(dates.map(iso));
  for (const date of dates) {
    const targetDow = date.getDay();
    const cutoff = addDays(date, -(settings.repeatWeeks || 0) * 7);
    const historicalRepeat = scheduleState.some(slot => {
      if (slot.recipeId !== recipe.id || slot.meal !== meal) return false;
      if (blockDates.has(slot.date)) return false;
      const d = parseIsoLocal(slot.date);
      return d.getDay() === targetDow && d < date && d >= cutoff;
    });
    if (historicalRepeat) return false;
  }
  if (settings.avoidSameWeek) {
    const weekStartIso = iso(startOfWeek(dates[0]));
    const weekEndIso = iso(addDays(startOfWeek(dates[0]), 6));
    const sameWeek = scheduleState.some(slot =>
      slot.recipeId === recipe.id &&
      slot.meal === meal &&
      !blockDates.has(slot.date) &&
      slot.date >= weekStartIso && slot.date <= weekEndIso
    );
    if (sameWeek) return false;
  }
  return true;
}

function choosePlannerRecipe(eligible, previousRecipeId = '') {
  if (!eligible.length) return null;
  const alternatives = eligible.filter(r => r.id !== previousRecipeId);
  const pool = alternatives.length ? alternatives : eligible;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function suggestWeekDays() {
  if (!recipes.length) return toast('Add a recipe first');
  const selected = [...els.weekPlanDays.querySelectorAll('input[type="checkbox"]:checked')]
    .map(cb => parseIsoLocal(cb.dataset.date)).sort((a,b)=>a-b);
  if (!selected.length) return toast('Select at least one day');
  const meals = selectedPlannerMeals();
  if (!meals.length) return toast('Choose Lunch week, Dinner week, or Full week');

  const replaceExisting = els.replaceExistingWeekMeals.checked;
  const pattern = plannerPattern();
  const allowDinnerRepeat = dinnerRepeatsAllowed();
  let workingSchedule = schedule.map(s => ({...s}));
  let added = 0, skipped = 0, lockedSkipped = 0;

  for (const meal of meals) {
    const targets = selected.filter(date => {
      const current = workingSchedule.find(s => s.date === iso(date) && s.meal === meal);
      if (slotIsLocked(current)) { lockedSkipped++; return false; }
      if (current && !replaceExisting) { skipped++; return false; }
      return true;
    });
    if (!targets.length) continue;

    const targetKeys = new Set(targets.map(date => `${iso(date)}_${meal}`));
    workingSchedule = workingSchedule.filter(slot => !targetKeys.has(`${slot.date}_${slot.meal}`));

    for (const segment of splitConsecutiveDates(targets)) {
      let blocks = patternBlocks(segment.length, pattern);
      let fixedRecipes = null;

      if (meal === 'dinner' && allowDinnerRepeat) {
        const dinnerPool = shuffleArray(recipes.filter(r => recipeSupportsMeal(r, 'dinner')));
        if (!dinnerPool.length) { skipped += segment.length; continue; }
        const recipeCount = Math.min(blocks.length, dinnerPool.length);
        blocks = collapseBlocksToCount(blocks, recipeCount);
        fixedRecipes = dinnerPool.slice(0, recipeCount);
      }

      let cursor = 0;
      let previousRecipeId = '';
      for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
        const blockDates = segment.slice(cursor, cursor + blocks[blockIndex]);
        cursor += blocks[blockIndex];
        if (!blockDates.length) continue;

        let picked = fixedRecipes?.[blockIndex] || null;
        if (!picked) {
          const relaxDinnerRules = meal === 'dinner' && allowDinnerRepeat;
          const eligible = relaxDinnerRules
            ? recipes.filter(r => recipeSupportsMeal(r, meal))
            : recipes.filter(r => plannerCandidateAllowed(r, blockDates, meal, workingSchedule));
          picked = choosePlannerRecipe(eligible, previousRecipeId);
        }
        if (!picked) { skipped += blockDates.length; continue; }
        previousRecipeId = picked.id;

        for (const date of blockDates) {
          const dateIso = iso(date);
          const slotId = `${dateIso}_${meal}`;
          const nextSlot = {
            date: dateIso,
            meal,
            recipeId: picked.id,
            status: 'suggested',
            locked: false,
            people: Math.max(1, Number(settings.defaultPeople) || 2)
          };
          await setDoc(doc(db,'households',householdId,'schedule',slotId), {...nextSlot, updatedAt:serverTimestamp()}, {merge:true});
          workingSchedule.push(nextSlot);
          added++;
        }
      }
    }
  }
  els.weekPlanDialog.close();
  const notes = [];
  if (skipped) notes.push(`skipped ${skipped}`);
  if (lockedSkipped) notes.push(`kept ${lockedSkipped} locked`);
  toast(`Suggested ${added} meal${added === 1 ? '' : 's'}${notes.length ? ` · ${notes.join(' · ')}` : ''}`);
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
  a.download = `meal-planner-recipes-${iso(new Date())}.json`;
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
      throw new Error('This is not a Meal Planner recipe backup.');
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
  clean.servings = Math.max(1, Number(clean.servings) || 2);
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

  els.defaultPeople.value = Math.max(1, Number(settings.defaultPeople) || 2);

  els.shortcutName.value =
    settings.shortcutName ||
    'Kitchen Week to Reminders';
}


async function saveSettings(ev) {
  ev.preventDefault();

  settings = {
    ...settings,
    repeatWeeks:
      Math.max(
        0,
        Number(
          els.repeatWeeks.value
        ) || 0
      ),

    avoidSameWeek:
      els.avoidSameWeek.checked,

    defaultPeople:
      Math.max(1, Number(els.defaultPeople.value) || 2),

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


function runShortcut() { openShoppingReview(); }


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

  els.howToUseButton?.addEventListener('click', () => els.howToUseDialog.showModal());
  els.regenerateUnlockedButton?.addEventListener('click', regenerateUnlockedWeek);
  els.recipeIngredientsTab?.addEventListener('click', () => setRecipeReaderSection('ingredients'));
  els.recipeStepsTab?.addEventListener('click', () => setRecipeReaderSection('steps'));
  els.recipeReaderScroll?.addEventListener('scroll', onRecipeReaderScroll, { passive: true });

  els.prevDay.addEventListener('click', () => {
    selectedDay = addDays(selectedDay, -1);
    renderToday();
  });

  els.nextDay.addEventListener('click', () => {
    selectedDay = addDays(selectedDay, 1);
    renderToday();
  });

  // The date input sits transparently over the visual date button.
  // This is intentional: iOS Safari only opens its native calendar reliably
  // when the user taps the <input type="date"> directly.
  els.todayDatePicker.addEventListener('pointerdown', () => {
    els.todayDatePicker.value = iso(selectedDay);
  });

  els.todayDatePicker.addEventListener('focus', () => {
    els.todayDatePicker.value = iso(selectedDay);
  });

  els.todayDatePicker.addEventListener('change', () => {
    if (!els.todayDatePicker.value) return;
    selectedDay = parseIsoLocal(els.todayDatePicker.value);
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
  els.closeViewedRecipe?.addEventListener('click', closeViewedRecipe);
  els.editViewedRecipe?.addEventListener('click', editViewedRecipe);
  if (els.recipeViewDialog && els.recipeReaderScroll) enableRecipePullToClose();
  els.weekPlanScope?.addEventListener('change', renderWeekPlanDays);
  els.weekPlanPattern?.addEventListener('change', () => {
    if (els.weekPlanReason) els.weekPlanReason.textContent = '';
  });
  els.selectAllWeekDays?.addEventListener('click', () => setWeekPlannerSelection('all'));
  els.selectEmptyWeekDays?.addEventListener('click', () => setWeekPlannerSelection('empty'));
  els.clearWeekDays?.addEventListener('click', () => setWeekPlannerSelection('clear'));
  els.suggestSelectedDays?.addEventListener('click', suggestWeekDays);
  els.downloadRecipeBackup?.addEventListener('click', downloadRecipeBackup);
  els.restoreRecipeBackup?.addEventListener('click', chooseRestoreFile);
  els.restoreRecipeFile?.addEventListener('change', readRestoreFile);
  els.confirmRestoreRecipes?.addEventListener('click', restoreRecipesFromBackup);

  els.addIngredient.addEventListener(
    'click',
    () =>
      addIngredientRow()
  );

  els.recipeServings?.addEventListener('input', updateRecipeServingsAndQuantities);
  els.recipeServings?.addEventListener('change', updateRecipeServingsAndQuantities);

  const updatePrepTimeLabel = () => {
    els.prepTimeValue.textContent = formatDurationMinutes(els.prepTime.value);
  };
  els.prepTime.addEventListener('input', updatePrepTimeLabel);
  els.prepTime.addEventListener('change', updatePrepTimeLabel);

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

  const updateRecipeTimeFilter = () => {
    if (els.recipeTimeFilterValue && els.recipeTimeFilter) {
      els.recipeTimeFilterValue.textContent = formatDurationMinutes(els.recipeTimeFilter.value);
    }
    renderRecipes();
  };
  els.recipeTimeFilter?.addEventListener('input', updateRecipeTimeFilter);
  els.recipeTimeFilter?.addEventListener('change', updateRecipeTimeFilter);
  if (els.recipeTimeFilterValue && els.recipeTimeFilter) {
    els.recipeTimeFilterValue.textContent = formatDurationMinutes(els.recipeTimeFilter.value);
  }

  els.tagFilter.addEventListener(
    'change',
    renderRecipes
  );

  els.slotPeople?.addEventListener('input', updateCurrentSlotPeople);
  els.slotPeople?.addEventListener('change', updateCurrentSlotPeople);

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

  els.reviewShopping?.addEventListener('click', openShoppingReview);
  els.mergeSelectedShopping?.addEventListener('click', mergeSelectedShoppingRows);
  els.resetShoppingReview?.addEventListener('click', resetShoppingReviewToGenerated);
  els.shoppingReviewMode?.addEventListener('change', () => {
    saveShoppingReviewDraft(false);
    renderShoppingReviewForMode(els.shoppingReviewMode.value, { keepOpen: true });
  });
  els.sendReviewedShopping?.addEventListener('click', sendReviewedShopping);

  els.runShortcut.addEventListener(
    'click',
    runShortcut
  );
}


/* -------------------------------------------------------
   Start app
------------------------------------------------------- */

function reportStartupIssue(context, err) {
  console.error(`[Meal Planner ${APP_BUILD}] ${context}:`, err);
  const message = `Something went wrong in ${context}. Reload the page; your saved data is not deleted.`;
  if (els.connectStatus && (!els.mainApp || els.mainApp.hidden)) {
    els.connectStatus.textContent = message;
  } else if (els.toast) {
    toast(message);
  }
}

window.addEventListener('unhandledrejection', event => {
  console.error(`[Meal Planner ${APP_BUILD}] Unhandled promise rejection:`, event.reason);
});

console.info(`Meal Planner ${APP_BUILD}`);

try {
  wireUi();
} catch (err) {
  // Connection controls are wired first, so a later optional UI mismatch should
  // never make the household/login screen completely inert again.
  reportStartupIssue('UI startup', err);
}

try {
  initFirebase();
} catch (err) {
  reportStartupIssue('Firebase startup', err);
}
