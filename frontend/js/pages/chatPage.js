import { supabase } from "../lib/supabaseClient.js";
import { upsertDailySummary } from "../lib/data.js";

// Merged version: keeps the new UI deployment setting, while preserving the old editable-ingredient workflow.
const IS_LOCAL =
  location.hostname === "127.0.0.1" ||
  location.hostname === "localhost";

const NLP_BASE = IS_LOCAL
  ? "http://127.0.0.1:9000"
  : (window.PLATEWISE_NLP_BASE || localStorage.getItem("PLATEWISE_NLP_BASE") || "https://platewise-nlp.onrender.com");

const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const imageUpload = document.getElementById("imageUpload");
const cameraCapture = document.getElementById("cameraCapture");
const sendBtn = document.getElementById("sendBtn");
const analyzeBtn = document.getElementById("analyzeBtn");
const reportBtn = document.getElementById("reportBtn");
const chatProfileBtn = document.getElementById("chatProfileBtn");
const PROFILE_CACHE_KEY = "platewise_profile_cache";

let currentImageFile = null;
let currentMeal = null;
let currentProfile = null;
let lastAnalysis = null;
let ingredientEditorDirty = false;
let mealAdviceNeedsRefresh = false;
let mealReportFinalized = false;
let cachedAppUserId = null;

let foodSearchTimer = null;

/* ===============================
   Basic UI helpers
================================ */

function addMessage(text, sender = "ai") {
  const msg = document.createElement("div");
  msg.className = `message ${sender === "user" ? "user-message" : "ai-message"}`;
  msg.innerText = text || "No response.";
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function isCannotEatMessage(text) {
  return /\b(?:i\s+)?(?:cannot|can't|can\s+not|could\s+not|should\s+not|must\s+not)\s+eat\b/i.test(
    text || ""
  );
}

function todayLocalISO() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildIngredientWeightSummary(meal) {
  const ingredients = getMealIngredients(meal);
  if (!ingredients.length) return "Image analyzed. Please review the detected ingredients below.";

  const dishName = meal?.dish_name || "this meal";
  const totalGrams = safeNumber(meal?.dish_estimated_grams);
  const ingredientLines = ingredients
    .map((item, index) => {
      const name = getIngredientName(item) || "Unknown ingredient";
      return `- ${name}: ${getIngredientGrams(item)} g`;
    })
    .join("\n");

  const totalLine = totalGrams > 0 ? `Estimated total: ${Math.round(totalGrams)} g.\n` : "";

  return `I analyzed your uploaded meal image.\n${dishName} detected.\n${totalLine}Please review the ingredient weights:\n${ingredientLines}`;
}

function friendlyErrorMessage(rawMessage, fallback = "Something went wrong. Please try again.") {
  const message = String(rawMessage || "");

  if (message.includes("503") || message.includes("UNAVAILABLE") || message.toLowerCase().includes("high demand")) {
    return "The image AI service is busy right now. Please try again in a minute, or describe the meal in text.";
  }

  if (message.includes("Failed to fetch")) {
    return `Could not connect to the NLP server. For local testing, make sure it is running at ${NLP_BASE}.`;
  }

  if (message.includes("Please login")) return "Please login first.";
  if (message.includes("Profile not found")) return "Please complete onboarding before using meal analysis.";

  return message || fallback;
}

function setBusy(isBusy) {
  [sendBtn, analyzeBtn, reportBtn].forEach((button) => {
    if (button) button.disabled = isBusy;
  });
}

async function compressImage(file, maxSide = 1200, quality = 0.82) {
  if (!file || !file.type?.startsWith("image/")) return file;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, width, height);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) return file;

  return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

function addSystem(text) {
  const div = document.createElement("div");
  div.className = "system-text";
  div.innerText = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addImageMessage(file) {
  const url = URL.createObjectURL(file);

  const wrap = document.createElement("div");
  wrap.className = "message user-message image-bubble";

  const img = document.createElement("img");
  img.className = "chat-image";
  img.src = url;

  wrap.appendChild(img);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

async function parseResponse(res) {
  const data = await res.json().catch(() => null);

  if (!data) {
    throw new Error(`Server returned ${res.status}, but no JSON was returned.`);
  }

  if (!res.ok) {
    throw new Error(JSON.stringify(data.detail || data));
  }

  return data;
}

/* ===============================
   Supabase user/profile
================================ */

async function getCurrentUserAndProfile() {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("Please login first.");
  }

  const { data: appUser, error: appUserError } = await supabase
    .from("users")
    .select("*")
    .eq("supabase_auth_id", user.id)
    .single();

  if (appUserError || !appUser) {
    throw new Error("User record not found in public.users.");
  }

  const { data: profile, error: profileError } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("user_id", appUser.id)
    .single();

  if (profileError || !profile) {
    throw new Error("Profile not found. Please complete onboarding first.");
  }

  return { user, appUser, profile };
}

async function getCurrentAppUserId() {
  if (cachedAppUserId) return cachedAppUserId;
  const { appUser } = await getCurrentUserAndProfile();
  cachedAppUserId = appUser.id;
  return cachedAppUserId;
}

async function applyProfileUpdates(appUserId, profileUpdates) {
  if (!profileUpdates || Object.keys(profileUpdates).length === 0) {
    return;
  }

  const { error } = await supabase
    .from("user_profiles")
    .update(profileUpdates)
    .eq("user_id", appUserId);

  if (error) {
    console.error("profile update failed:", error);
    addMessage("Profile update failed, but the response is still shown.", "ai");
  }
}

function parseList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const PROFILE_FOOD_ALIASES = {
  prawns: "shrimp",
  shrimps: "shrimp",
  peanuts: "peanut",
  eggs: "egg",
  tomatoes: "tomato",
  tomatos: "tomato",
  tomotaes: "tomato",
  "cherry tomatoes": "tomato",
  potatoes: "potato",
  lychees: "lychee",
  lyche: "lychee",
};

const DIET_PREFERENCE_KEYS = new Set([
  "vegetarian",
  "vegan",
  "low_sodium",
  "low_sugar",
  "high_protein",
]);

function normalizeProfileToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProfileItem(value) {
  const normalized = normalizeProfileToken(value);
  const preferenceKey = normalized.replaceAll(" ", "_");

  if (DIET_PREFERENCE_KEYS.has(preferenceKey)) return preferenceKey;
  if (PROFILE_FOOD_ALIASES[normalized]) return PROFILE_FOOD_ALIASES[normalized];
  if (normalized.endsWith("ies") && normalized.length > 4) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith("oes") && normalized.length > 4) return normalized.slice(0, -2);
  if (normalized.endsWith("es") && normalized.length > 4) return normalized.slice(0, -2);
  if (normalized.endsWith("s") && normalized.length > 3) return normalized.slice(0, -1);
  return normalized;
}

function writeProfileCacheFromCurrent(profile) {
  if (!profile || typeof profile !== "object") return;

  let cached = {};
  try {
    cached = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "{}");
  } catch {
    cached = {};
  }

  const restrictions = [];
  for (const item of [
    ...parseList(profile.restrictions),
    ...parseList(profile.dietary_restrictions),
    ...parseList(profile.allergies),
    ...parseList(profile.diet_preferences || profile.dietPreferences),
  ]) {
    const normalized = normalizeProfileItem(item);
    if (normalized && !restrictions.includes(normalized)) restrictions.push(normalized);
  }

  const next = {
    ...cached,
    ...profile,
  };

  if (restrictions.length > 0) {
    next.restrictions = restrictions.join(", ");
  }

  localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(next));
}

function removeRestrictionFromProfileCache(foodName) {
  const target = normalizeProfileItem(foodName);
  if (!target) return;

  let cached = {};
  try {
    cached = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "{}");
  } catch {
    cached = {};
  }

  const restrictions = [];
  for (const item of parseList(cached.restrictions)) {
    const normalized = normalizeProfileItem(item);
    if (normalized && normalized !== target && !restrictions.includes(normalized)) {
      restrictions.push(normalized);
    }
  }

  const next = {
    ...cached,
    restrictions: restrictions.join(", "),
  };
  localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(next));
}

function restrictionsWithoutFood(profile, foodName) {
  const target = normalizeProfileItem(foodName);
  const restrictions = [];

  for (const item of [
    ...parseList(profile?.restrictions),
    ...parseList(profile?.dietary_restrictions),
    ...parseList(profile?.allergies),
    ...parseList(profile?.diet_preferences || profile?.dietPreferences),
  ]) {
    const normalized = normalizeProfileItem(item);
    if (normalized && normalized !== target && !restrictions.includes(normalized)) {
      restrictions.push(normalized);
    }
  }

  return restrictions;
}

function extractCanEatFood(text) {
  const match = String(text || "").match(/\b(?:i\s+)?(?:can|could)\s+eat\s+([^,.!?;]+)/i);
  return match?.[1]?.trim() || "";
}


/* ===============================
   Ingredient editor helpers
================================ */

function getMealIngredients(meal) {
  if (!meal || !Array.isArray(meal.ingredients)) return [];
  return meal.ingredients;
}

function getIngredientName(item) {
  return item?.name || item?.ingredient || item?.food_name || "";
}

function getIngredientGrams(item) {
  const grams =
    item?.estimated_grams ??
    item?.grams ??
    item?.amount ??
    item?.weight ??
    100;

  const number = Number(grams);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 100;
}

function getTotalIngredientGrams() {
  const ingredients = getMealIngredients(currentMeal);
  return ingredients.reduce((sum, item) => {
    return sum + getIngredientGrams(item);
  }, 0);
}

function getIngredientIcon(name) {
  const lower = String(name || "").toLowerCase();

  if (
    lower.includes("beef") ||
    lower.includes("steak") ||
    lower.includes("meat") ||
    lower.includes("pork") ||
    lower.includes("lamb")
  ) {
    return "🥩";
  }

  if (
    lower.includes("chicken") ||
    lower.includes("turkey") ||
    lower.includes("duck")
  ) {
    return "🍗";
  }

  if (
    lower.includes("fish") ||
    lower.includes("salmon") ||
    lower.includes("tuna") ||
    lower.includes("seafood") ||
    lower.includes("shrimp") ||
    lower.includes("prawn")
  ) {
    return "🐟";
  }

  if (
    lower.includes("fries") ||
    lower.includes("french fries") ||
    lower.includes("potato")
  ) {
    return "🍟";
  }

  if (lower.includes("mushroom")) {
    return "🍄";
  }

  if (
    lower.includes("lettuce") ||
    lower.includes("salad") ||
    lower.includes("cabbage") ||
    lower.includes("spinach") ||
    lower.includes("vegetable") ||
    lower.includes("broccoli")
  ) {
    return "🥬";
  }

  if (lower.includes("rice")) {
    return "🍚";
  }

  if (
    lower.includes("noodle") ||
    lower.includes("pasta") ||
    lower.includes("spaghetti")
  ) {
    return "🍜";
  }

  if (lower.includes("egg")) {
    return "🥚";
  }

  if (
    lower.includes("bread") ||
    lower.includes("toast") ||
    lower.includes("bun")
  ) {
    return "🍞";
  }

  if (
    lower.includes("apple") ||
    lower.includes("banana") ||
    lower.includes("fruit") ||
    lower.includes("orange") ||
    lower.includes("grape")
  ) {
    return "🍎";
  }

  return "🍽️";
}

/* ===============================
   USDA local food search
================================ */

async function searchLocalFoods(query) {
  const q = String(query || "").trim();

  if (!q) return [];

  const res = await fetch(
    `${NLP_BASE}/food-search?q=${encodeURIComponent(q)}&limit=8`
  );

  const data = await parseResponse(res);

  if (!data.ok) return [];
  return data.items || data.results || [];
}

function getFoodDisplayName(item) {
  return (
    item?.name ||
    item?.main_food_description ||
    item?.food_name ||
    item?.description ||
    ""
  );
}

function getFoodSubText(item) {
  return (
    item?.name_zh ||
    item?.additional_food_description ||
    item?.category ||
    ""
  );
}

function getFoodCategory(item) {
  return item?.category || "";
}

function scaleNutrientsPer100g(nutrients, grams) {
  const ratio = Number(grams || 0) / 100;

  return {
    estimated_calories: Math.round(Number(nutrients?.calories || 0) * ratio),
    estimated_protein_g: Math.round(Number(nutrients?.protein_g || 0) * ratio),
    estimated_fat_g: Math.round(Number(nutrients?.fat_g || 0) * ratio),
    estimated_carbs_g: Math.round(Number(nutrients?.carbs_g || 0) * ratio),
    estimated_sodium_mg: Math.round(Number(nutrients?.sodium_mg || 0) * ratio),
    estimated_sugar_g: Math.round(Number(nutrients?.sugar_g || 0) * ratio),
    estimated_fiber_g: Math.round(Number(nutrients?.fiber_g || 0) * ratio),
  };
}

function applyNutrientsToIngredient(ingredient, grams) {
  if (!ingredient?.nutrients_per_100g) return ingredient;

  return {
    ...ingredient,
    ...scaleNutrientsPer100g(ingredient.nutrients_per_100g, grams),
  };
}

function applySelectedFoodToIngredient(index, item) {
  if (
    !currentMeal ||
    !Array.isArray(currentMeal.ingredients) ||
    !currentMeal.ingredients[index]
  ) {
    return;
  }

  const name = getFoodDisplayName(item);
  const grams = getIngredientGrams(currentMeal.ingredients[index]) || 100;

  currentMeal.ingredients[index] = applyNutrientsToIngredient(
    {
      ...currentMeal.ingredients[index],
      name,
      estimated_grams: grams,
      nutrients_per_100g: item?.nutrients_per_100g || null,
      nutrition_source: item?.nutrition_source || "food_database.csv",
    },
    grams
  );

  markIngredientEditorDirty();
}

function customIngredientToFoodItem(row) {
  const servingWeight = Number(row?.serving_weight_g || 100) || 100;
  const per100 = {
    calories: Number(row?.calories_per_100g ?? (Number(row?.calories_kcal || 0) * 100) / servingWeight),
    protein_g: Number(row?.protein_per_100g ?? (Number(row?.protein_g || 0) * 100) / servingWeight),
    carbs_g: Number(row?.carbs_per_100g ?? (Number(row?.carbs_g || 0) * 100) / servingWeight),
    fat_g: Number(row?.fat_per_100g ?? (Number(row?.fat_g || 0) * 100) / servingWeight),
    sugar_g: Number(row?.sugar_per_100g ?? (Number(row?.sugar_g || 0) * 100) / servingWeight),
    sodium_mg: Number(row?.sodium_per_100g ?? (Number(row?.sodium_mg || 0) * 100) / servingWeight),
    fiber_g: Number(row?.fiber_per_100g ?? (Number(row?.fiber_g || 0) * 100) / servingWeight),
  };

  return {
    name: row?.name || "Custom ingredient",
    category: "My ingredients",
    nutrition_source: "user_custom_ingredients",
    serving_weight_g: servingWeight,
    nutrients_per_100g: per100,
  };
}

async function searchCustomIngredients(query) {
  const rows = await searchCustomIngredientRows(query, 8);
  return rows.map(customIngredientToFoodItem);
}

async function searchCustomIngredientRows(query, limit = 6) {
  const q = String(query || "").trim();

  const userId = await getCurrentAppUserId();
  let request = supabase
    .from("user_custom_ingredients")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (q) {
    request = request.ilike("name", `%${q}%`);
  }

  const { data, error } = await request;

  if (error) {
    console.warn("custom ingredient search failed:", error);
    return [];
  }

  return data || [];
}

function customIngredientSummary(row) {
  const weight = Number(row?.serving_weight_g || 0);
  const calories = Number(row?.calories_kcal || 0);
  const protein = Number(row?.protein_g || 0);
  const carbs = Number(row?.carbs_g || 0);
  const fat = Number(row?.fat_g || 0);
  const weightText = weight > 0 ? `${Math.round(weight)}g` : "saved amount";

  return `${weightText}: ${Math.round(calories)} kcal, P ${protein.toFixed(1)}g, C ${carbs.toFixed(1)}g, F ${fat.toFixed(1)}g`;
}

function fillCustomIngredientForm(row) {
  const setValue = (id, value) => {
    const input = document.getElementById(id);
    if (input) input.value = value ?? "";
  };

  setValue("customIngredientName", row?.name || "");
  setValue("customIngredientWeight", Math.round(Number(row?.serving_weight_g || 50)));
  setValue("customIngredientCalories", Number(row?.calories_kcal || 0));
  setValue("customIngredientProtein", Number(row?.protein_g || 0));
  setValue("customIngredientCarbs", Number(row?.carbs_g || 0));
  setValue("customIngredientFat", Number(row?.fat_g || 0));
  setValue("customIngredientSugar", Number(row?.sugar_g || 0));
  setValue("customIngredientSodium", Number(row?.sodium_mg || 0));
}

function customIngredientPayloadFromModal() {
  const weight = Number(document.getElementById("customIngredientWeight")?.value || 0);
  const name = String(document.getElementById("customIngredientName")?.value || "").trim();
  const calories = Number(document.getElementById("customIngredientCalories")?.value || 0);
  const protein = Number(document.getElementById("customIngredientProtein")?.value || 0);
  const carbs = Number(document.getElementById("customIngredientCarbs")?.value || 0);
  const fat = Number(document.getElementById("customIngredientFat")?.value || 0);
  const sugar = Number(document.getElementById("customIngredientSugar")?.value || 0);
  const sodium = Number(document.getElementById("customIngredientSodium")?.value || 0);

  if (!name) throw new Error("Please enter an ingredient name.");
  if (!Number.isFinite(weight) || weight <= 0) throw new Error("Please enter a valid weight.");

  const per100 = (value) => (Number(value || 0) * 100) / weight;

  return {
    name,
    serving_weight_g: weight,
    calories_kcal: calories,
    protein_g: protein,
    carbs_g: carbs,
    fat_g: fat,
    sugar_g: sugar,
    sodium_mg: sodium,
    fiber_g: 0,
    calories_per_100g: per100(calories),
    protein_per_100g: per100(protein),
    carbs_per_100g: per100(carbs),
    fat_per_100g: per100(fat),
    sugar_per_100g: per100(sugar),
    sodium_per_100g: per100(sodium),
    fiber_per_100g: 0,
  };
}

async function saveCustomIngredientToMeal(index) {
  if (!currentMeal?.ingredients?.[index]) return;

  const userId = await getCurrentAppUserId();
  const payload = customIngredientPayloadFromModal();

  const { data: existing, error: findError } = await supabase
    .from("user_custom_ingredients")
    .select("id")
    .eq("user_id", userId)
    .eq("name", payload.name)
    .maybeSingle();

  if (findError) throw findError;

  const query = existing?.id
    ? supabase
        .from("user_custom_ingredients")
        .update({
          ...payload,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
    : supabase
        .from("user_custom_ingredients")
        .insert({
          user_id: userId,
          ...payload,
          updated_at: new Date().toISOString(),
        });

  const { data, error } = await query
    .select("*")
    .single();

  if (error) throw error;

  const item = customIngredientToFoodItem(data);
  currentMeal.ingredients[index] = applyNutrientsToIngredient(
    {
      ...currentMeal.ingredients[index],
      name: item.name,
      estimated_grams: Number(data.serving_weight_g || payload.serving_weight_g),
      nutrients_per_100g: item.nutrients_per_100g,
      nutrition_source: "user_custom_ingredients",
    },
    Number(data.serving_weight_g || payload.serving_weight_g)
  );

  markIngredientEditorDirty();
}

async function renderCustomIngredientHistory(query = "") {
  const historyBox = document.getElementById("customIngredientHistory");
  if (!historyBox) return;

  const q = String(query || "").trim();
  historyBox.innerHTML = `<p class="custom-ingredient-history-empty">Searching your saved ingredients...</p>`;

  try {
    const rows = await searchCustomIngredientRows(q, 5);

    if (!rows.length) {
      historyBox.innerHTML = q
        ? `<p class="custom-ingredient-history-empty">No saved match yet. You can create it below.</p>`
        : `<p class="custom-ingredient-history-empty">Type a name to search your saved custom ingredients.</p>`;
      return;
    }

    historyBox.innerHTML = `
      <div class="custom-ingredient-history-title">Saved custom ingredients</div>
      ${rows
        .map(
          (row, rowIndex) => `
            <button
              type="button"
              class="custom-ingredient-history-item"
              data-custom-row-index="${rowIndex}"
            >
              <strong>${escapeHtml(row?.name || "Custom ingredient")}</strong>
              <span>${escapeHtml(customIngredientSummary(row))}</span>
            </button>
          `
        )
        .join("")}
    `;

    historyBox.querySelectorAll(".custom-ingredient-history-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = rows[Number(btn.dataset.customRowIndex)];
        fillCustomIngredientForm(row);
      });
    });
  } catch (error) {
    console.warn("custom ingredient history failed:", error);
    historyBox.innerHTML = `<p class="custom-ingredient-history-empty">Could not load saved ingredients.</p>`;
  }
}

function closeFoodSuggestions() {
  document.querySelectorAll(".food-suggestion-box").forEach((box) => {
    box.remove();
  });
}

function removeIngredientEditor() {
  const oldEditor = document.getElementById("ingredientEditorCard");
  if (oldEditor) oldEditor.remove();
}

function renderFoodSuggestions(input, items) {
  closeFoodSuggestions();

  if (!items.length) return;

  const box = document.createElement("div");
  box.className = "food-suggestion-box";

  box.innerHTML = items
    .map((item) => {
      const name = getFoodDisplayName(item);
      const subText = getFoodSubText(item);
      const category = getFoodCategory(item);

      return `
        <button
          type="button"
          class="food-suggestion-item"
          data-result-index="${index}"
          data-name="${escapeAttr(name)}"
        >
          <strong>${escapeHtml(name)}</strong>
          <small>${escapeHtml(subText)}</small>
          ${category ? `<span>${escapeHtml(category)}</span>` : ""}
        </button>
      `;
    })
    .join("");

  input.parentElement.appendChild(box);

  box.querySelectorAll(".food-suggestion-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const selected = items[Number(btn.dataset.resultIndex)];
      input.value = getFoodDisplayName(selected) || btn.dataset.name || "";
      closeFoodSuggestions();

      const row = input.closest(".ingredient-edit-row");
      const index = Number(row?.dataset.index);

      if (Number.isFinite(index)) {
        applySelectedFoodToIngredient(index, selected);
      }
    });
  });
}

function setupFoodSearchInputs() {
  const inputs = chatMessages.querySelectorAll(".ingredient-name-input");

  inputs.forEach((input) => {
    input.addEventListener("input", () => {
      const row = input.closest(".ingredient-edit-row");
      const index = Number(row?.dataset.index);

      if (
        currentMeal &&
        Array.isArray(currentMeal.ingredients) &&
        Number.isFinite(index) &&
        currentMeal.ingredients[index]
      ) {
        currentMeal.ingredients[index].name = input.value.trim();
        delete currentMeal.ingredients[index].nutrients_per_100g;
        delete currentMeal.ingredients[index].nutrition_source;
        markIngredientEditorDirty();
      }

      clearTimeout(foodSearchTimer);

      foodSearchTimer = setTimeout(async () => {
        try {
          const items = await searchLocalFoods(input.value);
          renderFoodSuggestions(input, items);
        } catch (err) {
          console.error("food search failed:", err);
        }
      }, 250);
    });

    input.addEventListener("focus", async () => {
      try {
        if (!input.value.trim()) return;

        const items = await searchLocalFoods(input.value);
        renderFoodSuggestions(input, items);
      } catch (err) {
        console.error("food search failed:", err);
      }
    });
  });
}

document.addEventListener("click", (event) => {
  if (
    !event.target.closest(".food-suggestion-box") &&
    !event.target.closest(".ingredient-name-input")
  ) {
    closeFoodSuggestions();
  }
});

/* ===============================
   Ingredient editor actions
================================ */
function syncCurrentMealFromEditor() {
  if (!currentMeal || !Array.isArray(currentMeal.ingredients)) return [];

  const gramInputs = chatMessages.querySelectorAll(".ingredient-gram-input");

  const editedIngredients = currentMeal.ingredients
    .map((item, index) => {
      const name = getIngredientName(item).trim();
      const grams = Number(gramInputs[index]?.value || getIngredientGrams(item));

      return applyNutrientsToIngredient({
        ...item,
        name,
        estimated_grams: grams > 0 ? Math.round(grams) : 100,
      }, grams > 0 ? Math.round(grams) : 100);
    })
    .filter((item) => item.name);

  currentMeal.ingredients = editedIngredients;
  return editedIngredients;
}

function markIngredientEditorDirty() {
  ingredientEditorDirty = true;
}

function removeIngredient(index) {
  if (!currentMeal || !Array.isArray(currentMeal.ingredients)) return;

  syncCurrentMealFromEditor();

  currentMeal.ingredients.splice(index, 1);
  markIngredientEditorDirty();
  renderIngredientEditor();
}

function addIngredient() {
  if (!currentMeal) {
    currentMeal = {
      dish_name: "manual meal",
      ingredients: [],
    };
  }

  if (!Array.isArray(currentMeal.ingredients)) {
    currentMeal.ingredients = [];
  }

  syncCurrentMealFromEditor();

  currentMeal.ingredients.push({
    name: "",
    estimated_grams: 100,
  });
  markIngredientEditorDirty();

  renderIngredientEditor();

  setTimeout(() => {
    openIngredientSearchModal(currentMeal.ingredients.length - 1);
  }, 50);
}

async function saveIngredientEdits(options = {}) {
  const { silent = false } = options;

  if (!currentMeal) {
    addMessage("Please analyze a meal first.", "ai");
    return false;
  }

  const editedIngredients = syncCurrentMealFromEditor();

  if (!editedIngredients.length) {
    addMessage("Please keep at least one ingredient.", "ai");
    return false;
  }

  ingredientEditorDirty = false;
  mealAdviceNeedsRefresh = true;

  if (!silent) {
    renderIngredientEditor();
    addMessage("Ingredients saved. Tap Looks good when you are ready for the health advice.", "ai");
  }

  return true;
}

function renderIngredientEditor() {
  removeIngredientEditor();

  if (!currentMeal || mealReportFinalized) return;

  const ingredients = getMealIngredients(currentMeal);
  const totalGrams = getTotalIngredientGrams();

  const card = document.createElement("div");
  card.id = "ingredientEditorCard";
  card.className = "ingredients-editor-card";

  card.innerHTML = `
    <div class="ingredients-editor-header">
      <div>
        <h2>Detected ingredients</h2>
        <p>Edit before report</p>
      </div>
      <span class="ingredients-info-icon" title="Review detected ingredients before report">i</span>
    </div>

    <div class="ingredients-table-card">
      <div class="ingredients-table-head compact-head">
        <span>Ingredient</span>
        <span>Amount (g)</span>
      </div>

      <div class="ingredients-list">
        ${
          ingredients.length
            ? ingredients
                .map((item, index) => {
                  const name = getIngredientName(item);
                  const grams = getIngredientGrams(item);

                  return `
                    <div class="ingredient-edit-row compact-ingredient-row" data-index="${index}">
                      <div class="ingredient-name-area">
                        <span class="drag-handle" title="Ingredient item">⋮⋮</span>

                        <button
                          class="ingredient-name-display"
                          type="button"
                          data-index="${index}"
                          title="Click to search and edit food name"
                        >
                          ${escapeHtml(name || "Select ingredient")}
                        </button>
                      </div>

                      <div class="ingredient-amount-area">
                        <div class="amount-input-wrap">
                          <input
                            class="ingredient-gram-input ingredient-amount-input"
                            type="number"
                            min="1"
                            step="1"
                            value="${grams}"
                            placeholder="grams"
                          />
                          <span class="amount-unit">g</span>
                        </div>

                        <button
                          class="ingredient-remove-btn delete-ingredient-btn"
                          type="button"
                          data-index="${index}"
                          title="Remove ingredient"
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  `;
                })
                .join("")
            : `<p class="muted small-text">No ingredients yet. Add one manually.</p>`
        }
      </div>

      <button id="addIngredientBtn" class="add-ingredient-btn" type="button">
        <span>＋</span>
        Add ingredient
      </button>
    </div>

    <div class="ingredients-summary-card">
      <div>
        <p>Total amount</p>
        <strong id="ingredientTotalAmount">${totalGrams} g</strong>
      </div>

      <div class="ingredient-summary-actions">
        <button id="saveIngredientBtn" class="secondary-btn small-btn" type="button">
          Save edits
        </button>
        <button id="looksGoodBtn" class="looks-good-btn" type="button">
          ✓ Looks good
        </button>
      </div>
    </div>
  `;

  chatMessages.appendChild(card);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  document
    .getElementById("addIngredientBtn")
    ?.addEventListener("click", addIngredient);

  document
    .getElementById("saveIngredientBtn")
    ?.addEventListener("click", () => saveIngredientEdits());

  document
    .getElementById("looksGoodBtn")
    ?.addEventListener("click", async () => {
      let ok = true;

      if (ingredientEditorDirty) {
        ok = await saveIngredientEdits({ silent: true });
      } else {
        syncCurrentMealFromEditor();
      }

      if (ok) {
        try {
          let advice = lastAnalysis?.reply || "Looks good. The meal analysis is ready.";

          if (mealAdviceNeedsRefresh) {
            addMessage("Generating health advice...", "ai");
            advice = await refreshMealAdviceFromEdits();
          }

          addMessage(advice || "Looks good. The meal analysis is ready.", "ai");
          addMessage("Tap Report to save this meal to your history.", "ai");
        } catch (err) {
          console.error(err);
          addMessage(friendlyErrorMessage(err.message, "Could not generate health advice."), "ai");
        }
      }
    });

  card.querySelectorAll(".ingredient-name-display").forEach((btn) => {
    btn.addEventListener("click", () => {
      openIngredientSearchModal(Number(btn.dataset.index));
    });
  });

  card.querySelectorAll(".ingredient-remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      removeIngredient(Number(btn.dataset.index));
    });
  });

  card.querySelectorAll(".ingredient-gram-input").forEach((input) => {
    input.addEventListener("input", () => {
      const row = input.closest(".ingredient-edit-row");
      const index = Number(row?.dataset.index);

      if (
        currentMeal &&
        Array.isArray(currentMeal.ingredients) &&
        Number.isFinite(index) &&
        currentMeal.ingredients[index]
      ) {
        const grams = Number(input.value || 100);
        const roundedGrams = grams > 0 ? Math.round(grams) : 100;
        currentMeal.ingredients[index] = applyNutrientsToIngredient(
          {
            ...currentMeal.ingredients[index],
            estimated_grams: roundedGrams,
          },
          roundedGrams
        );
        markIngredientEditorDirty();
      }

      const totalEl = document.getElementById("ingredientTotalAmount");
      if (totalEl) {
        totalEl.innerText = `${getTotalIngredientGrams()} g`;
      }
    });
  });
}

function openIngredientSearchModal(index) {
  if (
    !currentMeal ||
    !Array.isArray(currentMeal.ingredients) ||
    !currentMeal.ingredients[index]
  ) {
    return;
  }

  closeIngredientSearchModal();

  const currentName = getIngredientName(currentMeal.ingredients[index]);

  const modal = document.createElement("div");
  modal.id = "ingredientSearchModal";
  modal.className = "ingredient-modal-overlay";

  modal.innerHTML = `
    <div class="ingredient-modal">
      <div class="ingredient-modal-header">
        <div>
          <h3>Add ingredient</h3>
          <p>Search USDA foods or create your own ingredient with nutrition values and weight.</p>
        </div>

        <button
          type="button"
          class="ingredient-modal-close"
          id="ingredientModalCloseBtn"
        >
          ×
        </button>
      </div>

      <div class="ingredient-modal-body">
        <div class="ingredient-mode-toggle" role="group" aria-label="Ingredient entry mode">
          <button type="button" class="active" id="ingredientSearchModeBtn">
            Search USDA
          </button>
          <button type="button" id="ingredientCustomModeBtn">
            Create Custom
          </button>
        </div>

        <section id="ingredientSearchPanel">
          <label class="ingredient-modal-label">Ingredient name</label>

          <input
            id="ingredientModalSearchInput"
            class="ingredient-modal-search-input"
            type="text"
            value="${escapeAttr(currentName)}"
            placeholder="Search food from USDA table"
            autocomplete="off"
          />

          <div id="ingredientModalResults" class="ingredient-modal-results">
            <p class="ingredient-modal-empty">Start typing to search USDA foods.</p>
          </div>
        </section>

        <section id="ingredientCustomPanel" class="hidden">
          <p class="ingredient-custom-note">Can't find it in USDA? Create it here and save it to your own ingredient library.</p>

          <div class="ingredient-custom-top-grid">
            <label class="ingredient-custom-field ingredient-custom-name-field">
              <span>Ingredient name</span>
              <input id="customIngredientName" type="text" placeholder="e.g. homemade sesame sauce" autocomplete="off" />
            </label>

            <label class="ingredient-custom-field">
              <span>Weight</span>
              <div class="ingredient-custom-unit-input">
                <input id="customIngredientWeight" type="number" min="1" step="1" value="50" />
                <em>g</em>
              </div>
            </label>
          </div>

          <div id="customIngredientHistory" class="custom-ingredient-history">
            <p class="custom-ingredient-history-empty">Type a name to search your saved custom ingredients.</p>
          </div>

          <label class="ingredient-modal-label">Nutrition per this amount</label>
          <div class="ingredient-nutrition-grid">
            <label class="ingredient-custom-field">
              <span>Calories (kcal)</span>
              <input id="customIngredientCalories" type="number" min="0" step="1" placeholder="e.g. 120" />
            </label>
            <label class="ingredient-custom-field">
              <span>Protein (g)</span>
              <input id="customIngredientProtein" type="number" min="0" step="0.1" placeholder="e.g. 3" />
            </label>
            <label class="ingredient-custom-field">
              <span>Carbs (g)</span>
              <input id="customIngredientCarbs" type="number" min="0" step="0.1" placeholder="e.g. 10" />
            </label>
            <label class="ingredient-custom-field">
              <span>Fat (g)</span>
              <input id="customIngredientFat" type="number" min="0" step="0.1" placeholder="e.g. 5" />
            </label>
            <label class="ingredient-custom-field">
              <span>Sugar (g)</span>
              <input id="customIngredientSugar" type="number" min="0" step="0.1" placeholder="e.g. 2" />
            </label>
            <label class="ingredient-custom-field">
              <span>Sodium (mg)</span>
              <input id="customIngredientSodium" type="number" min="0" step="1" placeholder="e.g. 250" />
            </label>
          </div>

        </section>
      </div>

      <div class="ingredient-modal-footer">
        <button
          type="button"
          class="ingredient-modal-cancel"
          id="ingredientModalCancelBtn"
        >
          Cancel
        </button>

        <button
          type="button"
          class="ingredient-modal-save"
          id="ingredientModalSaveBtn"
        >
          Save ingredient
        </button>
      </div>
    </div>
  `;

  const modalHost = document.querySelector(".app-screen") || document.body;
  modalHost.appendChild(modal);

  const input = document.getElementById("ingredientModalSearchInput");
  const closeBtn = document.getElementById("ingredientModalCloseBtn");
  const cancelBtn = document.getElementById("ingredientModalCancelBtn");
  const saveBtn = document.getElementById("ingredientModalSaveBtn");
  const searchModeBtn = document.getElementById("ingredientSearchModeBtn");
  const customModeBtn = document.getElementById("ingredientCustomModeBtn");
  const searchPanel = document.getElementById("ingredientSearchPanel");
  const customPanel = document.getElementById("ingredientCustomPanel");
  const customNameInput = document.getElementById("customIngredientName");
  let ingredientModalMode = "search";
  let customHistoryTimer = null;

  closeBtn?.addEventListener("click", closeIngredientSearchModal);
  cancelBtn?.addEventListener("click", closeIngredientSearchModal);

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeIngredientSearchModal();
    }
  });

  const setIngredientModalMode = (mode) => {
    ingredientModalMode = mode;
    const isCustom = mode === "custom";
    searchModeBtn?.classList.toggle("active", !isCustom);
    customModeBtn?.classList.toggle("active", isCustom);
    searchPanel?.classList.toggle("hidden", isCustom);
    customPanel?.classList.toggle("hidden", !isCustom);
    if (isCustom) {
      renderCustomIngredientHistory(customNameInput?.value || "");
    }
    setTimeout(() => {
      (isCustom ? customNameInput : input)?.focus();
    }, 0);
  };

  searchModeBtn?.addEventListener("click", () => setIngredientModalMode("search"));
  customModeBtn?.addEventListener("click", () => setIngredientModalMode("custom"));

  saveBtn?.addEventListener("click", async () => {
    if (ingredientModalMode === "custom") {
      try {
        saveBtn.disabled = true;
        await saveCustomIngredientToMeal(index);
        closeIngredientSearchModal();
        renderIngredientEditor();
      } catch (error) {
        console.error("custom ingredient save failed:", error);
        addMessage(error.message || "Could not save custom ingredient.", "ai");
      } finally {
        saveBtn.disabled = false;
      }
      return;
    }

    const newName = input.value.trim();

    if (!newName) {
      addMessage("Please enter an ingredient name.", "ai");
      return;
    }

    currentMeal.ingredients[index].name = newName;
    delete currentMeal.ingredients[index].nutrients_per_100g;
    delete currentMeal.ingredients[index].nutrition_source;
    markIngredientEditorDirty();
    closeIngredientSearchModal();
    renderIngredientEditor();
  });

  let modalSearchTimer = null;

  input?.addEventListener("input", () => {
    clearTimeout(modalSearchTimer);

    modalSearchTimer = setTimeout(async () => {
      await searchFoodsInModal(input.value, index);
    }, 250);
  });

  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();

      const newName = input.value.trim();

      if (newName) {
        currentMeal.ingredients[index].name = newName;
        delete currentMeal.ingredients[index].nutrients_per_100g;
        delete currentMeal.ingredients[index].nutrition_source;
        markIngredientEditorDirty();
        closeIngredientSearchModal();
        renderIngredientEditor();
      }
    }

    if (event.key === "Escape") {
      closeIngredientSearchModal();
    }
  });

  customNameInput?.addEventListener("input", () => {
    clearTimeout(customHistoryTimer);
    customHistoryTimer = setTimeout(() => {
      renderCustomIngredientHistory(customNameInput.value);
    }, 220);
  });

  customNameInput?.addEventListener("focus", () => {
    renderCustomIngredientHistory(customNameInput.value);
  });

  setTimeout(() => {
    input?.focus();
    input?.select();
  }, 50);

  if (currentName) {
    searchFoodsInModal(currentName, index);
  }
}

function closeIngredientSearchModal() {
  const modal = document.getElementById("ingredientSearchModal");
  if (modal) modal.remove();
}

async function searchFoodsInModal(query, index) {
  const resultsBox = document.getElementById("ingredientModalResults");

  if (!resultsBox) return;

  const q = String(query || "").trim();

  if (!q) {
    resultsBox.innerHTML = `
      <p class="ingredient-modal-empty">Start typing to search USDA foods.</p>
    `;
    return;
  }

  resultsBox.innerHTML = `
    <p class="ingredient-modal-empty">Searching...</p>
  `;

  try {
    const [usdaItems, customItems] = await Promise.all([
      searchLocalFoods(q),
      searchCustomIngredients(q),
    ]);
    const items = [
      ...customItems.map((item) => ({ ...item, result_group: "My ingredients" })),
      ...usdaItems.map((item) => ({ ...item, result_group: "USDA" })),
    ];

    if (!items.length) {
      resultsBox.innerHTML = `
        <div class="ingredient-modal-no-result">
          <p>No matched food found.</p>
          <button type="button" id="useTypedIngredientBtn">
            Create custom "${escapeHtml(q)}"
          </button>
        </div>
      `;

      document
        .getElementById("useTypedIngredientBtn")
        ?.addEventListener("click", () => {
          const input = document.getElementById("ingredientModalSearchInput");
          const typedName = input?.value.trim();

          if (typedName) {
            document.getElementById("ingredientCustomModeBtn")?.click();
            const customNameInput = document.getElementById("customIngredientName");
            if (customNameInput) {
              customNameInput.value = typedName;
              renderCustomIngredientHistory(typedName);
            }
          }
        });

      return;
    }

    resultsBox.innerHTML = items
      .map((item, resultIndex) => {
        const name = getFoodDisplayName(item);
        const subText = getFoodSubText(item);
        const category = getFoodCategory(item);

        return `
          <button
            type="button"
            class="ingredient-modal-result-item"
            data-result-index="${resultIndex}"
            data-name="${escapeAttr(name)}"
          >
            <strong>${escapeHtml(name)}</strong>
            <small>${escapeHtml(subText)}</small>
            <span>${escapeHtml(item.result_group || category || "Food")}</span>
          </button>
        `;
      })
      .join("");

    resultsBox.querySelectorAll(".ingredient-modal-result-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const selected = items[Number(btn.dataset.resultIndex)];
        applySelectedFoodToIngredient(index, selected);

        closeIngredientSearchModal();
        renderIngredientEditor();
      });
    });
  } catch (err) {
    console.error("modal food search failed:", err);

    resultsBox.innerHTML = `
      <p class="ingredient-modal-empty">Search failed. Please try again.</p>
    `;
  }
}

/* ===============================
   Image upload
================================ */

async function handleImage(file) {
  if (!file) return;

  try {
    currentImageFile = await compressImage(file);
  } catch (error) {
    console.warn("Image compression failed, using original file:", error);
    currentImageFile = file;
  }

  addImageMessage(currentImageFile);
  addSystem("Image selected. Tap Analyze to process it.");
}

imageUpload?.addEventListener("change", () => {
  handleImage(imageUpload.files?.[0]);
  imageUpload.value = "";
});

cameraCapture?.addEventListener("change", () => {
  handleImage(cameraCapture.files?.[0]);
  cameraCapture.value = "";
});

/* ===============================
   Analyze image
================================ */

analyzeBtn?.addEventListener("click", async () => {
  if (!currentImageFile) {
    addMessage("Please upload or take a photo first.", "ai");
    return;
  }

  try {
    addMessage("Analyzing image...", "ai");

    const { appUser, profile } = await getCurrentUserAndProfile();
    currentProfile = profile;
    mealReportFinalized = false;

    const formData = new FormData();
    formData.append("image", currentImageFile);
    formData.append("profile", JSON.stringify(profile));
    formData.append("goal", profile.goal || "healthy eating");

    const res = await fetch(`${NLP_BASE}/analyze-image`, {
      method: "POST",
      body: formData,
    });

    const data = await parseResponse(res);

    if (!data.ok) {
      addMessage(data.reply || "Image analysis failed.", "ai");
      return;
    }

    currentMeal = data.meal || null;
    currentProfile = data.profile || profile;
    lastAnalysis = data;
    ingredientEditorDirty = false;
    mealAdviceNeedsRefresh = false;
    mealReportFinalized = false;

    writeProfileCacheFromCurrent(currentProfile);
    await applyProfileUpdates(appUser.id, data.profile_updates || {});

    addMessage(buildIngredientWeightSummary(currentMeal), "ai");

    renderIngredientEditor();
  } catch (err) {
    console.error(err);
    addMessage(friendlyErrorMessage(err.message, "Image analysis failed."), "ai");
  }
});

/* ===============================
   Chat
================================ */

sendBtn?.addEventListener("click", async () => {
  const text = chatInput.value.trim();

  if (!text) {
    addMessage("Please type a message first.", "ai");
    return;
  }

  addMessage(text, "user");
  chatInput.value = "";

  try {
    addMessage("Thinking...", "ai");

    const { appUser, profile } = await getCurrentUserAndProfile();
    const effectiveProfile = currentProfile || profile;
    const profileOnlyRestrictionUpdate = isCannotEatMessage(text);

    if (profileOnlyRestrictionUpdate) {
      removeIngredientEditor();
    }

    const res = await fetch(`${NLP_BASE}/chat-turn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_text: text,
        meal: mealReportFinalized || profileOnlyRestrictionUpdate ? null : currentMeal,
        profile: effectiveProfile,
      }),
    });

    const data = await parseResponse(res);

    if (!data.ok) {
      addMessage(data.reply || "Chat failed.", "ai");
      return;
    }

    if (!mealReportFinalized && !profileOnlyRestrictionUpdate) {
      currentMeal = data.meal || currentMeal;
    }
    currentProfile = data.profile || effectiveProfile;
    lastAnalysis = data;
    ingredientEditorDirty = false;
    mealAdviceNeedsRefresh = false;

    writeProfileCacheFromCurrent(currentProfile);
    await applyProfileUpdates(appUser.id, data.profile_updates || {});
    const canEatFood = extractCanEatFood(text);
    if (canEatFood) {
      const restrictions = restrictionsWithoutFood(currentProfile, canEatFood);
      if (currentProfile) {
        currentProfile = {
          ...currentProfile,
          restrictions: restrictions.join(", "),
          dietary_restrictions: restrictions,
          allergies: restrictions,
        };
      }
      await applyProfileUpdates(appUser.id, { restrictions: restrictions.join(", ") });
      writeProfileCacheFromCurrent(currentProfile);
      removeRestrictionFromProfileCache(canEatFood);
    }

    addMessage(data.reply || "Done.", "ai");

    if (currentMeal && !mealReportFinalized && !profileOnlyRestrictionUpdate) {
      renderIngredientEditor();
    } else if (profileOnlyRestrictionUpdate) {
      removeIngredientEditor();
    }
  } catch (err) {
    console.error(err);
    addMessage(friendlyErrorMessage(err.message, "Chat failed."), "ai");
  }
});

chatInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    sendBtn?.click();
  }
});

async function refreshMealAdviceFromEdits() {
  const { appUser, profile } = await getCurrentUserAndProfile();
  const effectiveProfile = currentProfile || profile;
  const editedIngredients = syncCurrentMealFromEditor();

  if (!editedIngredients.length) {
    throw new Error("Please keep at least one ingredient.");
  }

  const res = await fetch(`${NLP_BASE}/meal-advice`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      meal: currentMeal,
      profile: effectiveProfile,
      ingredients: editedIngredients,
    }),
  });

  const data = await parseResponse(res);

  if (!data.ok) {
    throw new Error(data.reply || "Meal edit failed.");
  }

  currentMeal = data.meal || currentMeal;
  currentProfile = data.profile || effectiveProfile;
  lastAnalysis = data;
  ingredientEditorDirty = false;
  mealAdviceNeedsRefresh = false;

  writeProfileCacheFromCurrent(currentProfile);
  await applyProfileUpdates(appUser.id, data.profile_updates || {});

  return data.reply || data.insight?.final_summary || "";
}

/* ===============================
   Upload meal image to Supabase Storage
================================ */

async function uploadImageToStorage(appUser, file) {
  if (!file) return null;

  const ext = file.name.split(".").pop() || "jpg";
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${appUser.id}/${Date.now()}.${safeExt}`;

  const { error } = await supabase.storage
    .from("meal-images")
    .upload(path, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || "image/jpeg",
    });

  if (error) {
    console.warn("Image storage upload failed:", error);
    return null;
  }

  const { data } = supabase.storage
    .from("meal-images")
    .getPublicUrl(path);

  return data?.publicUrl || null;
}

/* ===============================
   Build report
================================ */

reportBtn?.addEventListener("click", async () => {
  if (!currentMeal) {
    addMessage("Please analyze a meal before generating a report.", "ai");
    return;
  }

  if (ingredientEditorDirty) {
    const editsSaved = await saveIngredientEdits({ silent: true });
    if (!editsSaved) return;
  } else {
    syncCurrentMealFromEditor();
  }

  try {
    addMessage("Generating report...", "ai");

    const { appUser, profile } = await getCurrentUserAndProfile();
    const effectiveProfile = currentProfile || profile;

    const res = await fetch(`${NLP_BASE}/build-report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        meal: currentMeal,
        profile: effectiveProfile,
        last_analysis: lastAnalysis,
      }),
    });

    const reportData = await parseResponse(res);

    if (!reportData.ok) {
      addMessage(reportData.reply || "Report failed.", "ai");
      return;
    }

    mealReportFinalized = true;
    currentMeal = null;
    ingredientEditorDirty = false;
    mealAdviceNeedsRefresh = false;
    removeIngredientEditor();

    currentProfile = reportData.profile || effectiveProfile;
    lastAnalysis = reportData;

    writeProfileCacheFromCurrent(currentProfile);
    await applyProfileUpdates(appUser.id, reportData.profile_updates || {});

    const imageUrl = await uploadImageToStorage(appUser, currentImageFile);
    const insight = reportData.insight || {};
    const totals = reportData.report_totals || {};

    const reportPayload = {
      user_id: appUser.id,
      report_date: todayLocalISO(),

      title: reportData.title || "Meal Analysis",
      source_type: currentImageFile ? "image" : "chat",
      image_url: imageUrl,
      status: "final",

      risk_level: insight.risk_level || "low",
      final_summary: insight.final_summary || reportData.reply || null,
      recommendation: insight.recommendation || "No recommendation available.",

      total_calories: safeNumber(totals.total_calories),
      total_protein_g: safeNumber(totals.total_protein_g),
      total_fat_g: safeNumber(totals.total_fat_g),
      total_carbs_g: safeNumber(totals.total_carbs_g),
      total_sodium_mg: safeNumber(totals.total_sodium_mg),
      total_sugar_g: safeNumber(totals.total_sugar_g),
      total_fiber_g: safeNumber(totals.total_fiber_g),
    };

    console.log("Saving report payload:", reportPayload);

    const { data: report, error: reportError } = await supabase
      .from("reports")
      .insert(reportPayload)
      .select()
      .single();

    if (reportError) {
      throw new Error(reportError.message);
    }

    const itemRows = (reportData.items_for_db || []).map((item) => ({
      report_id: report.id,
      ...item,
    }));

    if (itemRows.length > 0) {
      const { error: itemError } = await supabase
        .from("report_items")
        .insert(itemRows);

      if (itemError) {
        throw new Error(`Report saved, but food items failed to save: ${itemError.message}`);
      }
    }

    const { error: summaryError } = await supabase
      .from("report_summaries")
      .upsert({
        report_id: report.id,
        summary_json: reportData,
        analysis_method: "original_nlp_pipeline_with_editable_ingredients",
      }, { onConflict: "report_id" });

    if (summaryError) {
      throw new Error(`Report saved, but summary failed to save: ${summaryError.message}`);
    }

    await upsertDailySummary(appUser.id);

    currentImageFile = null;

    addMessage("✅ Report saved successfully.", "ai");
  } catch (err) {
    console.error(err);
    addMessage(friendlyErrorMessage(err.message, "Report failed."), "ai");
  }
});

/* ===============================
   Capability chips
================================ */

document.addEventListener("click", (event) => {
  const chip = event.target.closest(".capability-chip");
  if (!chip) return;

  chatInput.value = chip.dataset.example || "";
  chatInput.focus();
});

chatProfileBtn?.addEventListener("click", () => {
  window.location.href = "profile.html";
});
