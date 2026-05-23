import { supabase } from "../lib/supabaseClient.js";
import { signOutUser, getCurrentSession } from "../lib/auth.js";
import { getUserProfile } from "../lib/data.js";
import { redirectIfNoSession } from "../lib/router.js";
import { $, showToast } from "../lib/utils.js";

const AVATAR_STORAGE_KEY = "platewise_profile_avatar";
const PROFILE_CACHE_KEY = "platewise_profile_cache";
const ACTIVITY_STORAGE_KEY = "platewise_activity_level";

let currentAppUser = null;
let currentProfile = null;
let goalEditing = false;
let biometricsEditing = false;
let healthEditing = false;
let activeHealthInputTarget = "";
let navigationSetup = false;

const GENDER_OPTIONS = [
  ["male", "male"],
  ["female", "female"],
  ["non_binary", "non-binary"],
  ["prefer_not_to_say", "prefer not to say"],
];

const ACTIVITY_OPTIONS = [
  ["sedentary", "Sedentary"],
  ["lightly_active", "Lightly active"],
  ["moderately_active", "Moderately active"],
  ["very_active", "Very active"],
  ["extra_active", "Extra active"],
];

const GOAL_OPTIONS = [
  ["lose_weight", "Lose weight"],
  ["maintain", "Maintain"],
  ["gain_muscle", "Gain muscle"],
  ["gain_weight", "Gain weight"],
];

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeGoal(goal) {
  const normalized = String(goal || "").trim().toLowerCase().replace(/\s+/g, "_");
  const aliases = {
    lose_fat: "lose_weight",
    fat_loss: "lose_weight",
    weight_loss: "lose_weight",
    keep_weight: "maintain",
    maintenance: "maintain",
    build_muscle: "gain_muscle",
    muscle_gain: "gain_muscle",
    bulk: "gain_weight",
  };
  const resolved = aliases[normalized] || normalized;
  const allowed = ["lose_weight", "gain_weight", "gain_muscle", "maintain"];
  return allowed.includes(resolved) ? resolved : "";
}

function formatGoal(goal) {
  const normalized = normalizeGoal(goal);

  const labels = {
    lose_weight: "Lose weight",
    maintain: "Maintain",
    gain_muscle: "Gain muscle",
    gain_weight: "Gain weight",
  };

  return labels[normalized] || "Not set";
}

function goalDescription(goal) {
  const normalized = normalizeGoal(goal);

  const descriptions = {
    lose_weight: "Sustainable fat loss with balanced, high-satiety meals.",
    maintain: "Keep your current rhythm while improving meal quality.",
    gain_muscle: "Protein-forward meal guidance for strength and recovery.",
    gain_weight: "Healthy surplus planning with nutrient-dense meals.",
  };

  return descriptions[normalized] || "Complete onboarding to personalize your plan.";
}

function goalIconMarkup(goal) {
  const normalized = normalizeGoal(goal);

  const iconByGoal = {
    lose_weight: `
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M12 5V19M12 19L7 14M12 19L17 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `,
    maintain: `
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M6 11H18M8 7L6 11L8 15M16 7L18 11L16 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `,
    gain_muscle: `
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M7 14L14 7M14 7H8M14 7V13M5 19H19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `,
    gain_weight: `
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M12 19V5M12 5L7 10M12 5L17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `,
  };

  return iconByGoal[normalized] || iconByGoal.gain_weight;
}

function formatGender(gender) {
  if (!gender) return "-";

  return String(gender)
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .trim()
    .toLowerCase();
}

function hasProfileValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function mergeNonEmptyProfileValues(cachedProfile = {}, dbProfile = {}) {
  const merged = { ...(cachedProfile || {}) };

  Object.entries(dbProfile || {}).forEach(([key, value]) => {
    if (hasProfileValue(value)) merged[key] = value;
  });

  return merged;
}

function normalizeActivityLevel(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");

  const aliases = {
    sedentary: "sedentary",
    inactive: "sedentary",

    lightly_active: "lightly_active",
    light: "lightly_active",

    moderately_active: "moderately_active",
    moderate: "moderately_active",

    very_active: "very_active",
    active: "very_active",

    extra_active: "extra_active",
    athlete: "extra_active",
  };

  return aliases[normalized] || "";
}

function formatActivityLevel(value) {
  const normalized = normalizeActivityLevel(value) || "moderately_active";

  const labels = {
    sedentary: "Sedentary",
    lightly_active: "Lightly active",
    moderately_active: "Moderately active",
    very_active: "Very active",
    extra_active: "Extra active",
  };

  return labels[normalized] || "Moderately active";
}

function profileInputMarkup(id, value, unit = "") {
  return `
    <span class="profile-edit-value">
      <input id="${id}" type="number" inputmode="numeric" value="${escapeHTML(value)}" />
      ${unit ? `<em>${escapeHTML(unit)}</em>` : ""}
    </span>
  `;
}

function profileSelectMarkup(id, value, options) {
  const normalized = String(value || "").trim();
  return `
    <select id="${id}" class="profile-edit-select">
      ${options
        .map(([optionValue, label]) => {
          const selected = optionValue === normalized ? " selected" : "";
          return `<option value="${escapeHTML(optionValue)}"${selected}>${escapeHTML(label)}</option>`;
        })
        .join("")}
    </select>
  `;
}

function readCachedProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeProfileCache(profile) {
  localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile || {}));
}

function getMostReliableActivityLevel(profile, cachedProfile) {
  return (
    normalizeActivityLevel(cachedProfile?.activity_level) ||
    normalizeActivityLevel(cachedProfile?.activityLevel) ||
    normalizeActivityLevel(cachedProfile?.activity) ||
    normalizeActivityLevel(localStorage.getItem(ACTIVITY_STORAGE_KEY)) ||
    normalizeActivityLevel(profile?.activity_level) ||
    normalizeActivityLevel(profile?.activityLevel) ||
    normalizeActivityLevel(profile?.activity) ||
    "moderately_active"
  );
}

function splitList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);

  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const DIET_PREFERENCE_KEYS = new Set([
  "vegetarian",
  "vegan",
  "low_sodium",
  "low_sugar",
  "high_protein",
]);

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

function normalizeProfileToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularizeProfileFood(value) {
  const normalized = normalizeProfileToken(value);
  if (PROFILE_FOOD_ALIASES[normalized]) return PROFILE_FOOD_ALIASES[normalized];
  if (normalized.endsWith("ies") && normalized.length > 4) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith("oes") && normalized.length > 4) return normalized.slice(0, -2);
  if (normalized.endsWith("es") && normalized.length > 4) return normalized.slice(0, -2);
  if (normalized.endsWith("s") && normalized.length > 3) return normalized.slice(0, -1);
  return normalized;
}

function normalizeProfileItem(value) {
  const normalized = normalizeProfileToken(value);
  const key = normalized.replaceAll(" ", "_");
  if (DIET_PREFERENCE_KEYS.has(key)) return key;
  return singularizeProfileFood(normalized);
}

function formatPreferenceLabel(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .trim();
}

function getAllergiesAndPreferences(profile) {
  const rawAllergies = splitList(profile?.allergies);
  const rawDietPreferences = splitList(profile?.diet_preferences || profile?.dietPreferences);
  const rawRestrictions = splitList(profile?.restrictions);

  const allergies = [];
  const preferences = [];

  for (const item of [...rawAllergies, ...rawRestrictions]) {
    const normalized = normalizeProfileItem(item);
    if (!normalized) continue;
    if (DIET_PREFERENCE_KEYS.has(normalized)) {
      if (!preferences.includes(normalized)) preferences.push(normalized);
    } else if (!allergies.includes(normalized)) {
      allergies.push(normalized);
    }
  }

  for (const item of rawDietPreferences) {
    const normalized = normalizeProfileItem(item);
    if (!normalized) continue;
    if (!preferences.includes(normalized)) preferences.push(normalized);
  }

  return [...allergies, ...preferences].map(formatPreferenceLabel);
}

function normalizeRestrictionList(values) {
  const normalizedItems = [];
  for (const value of splitList(values)) {
    const normalized = normalizeProfileItem(value);
    if (normalized && !normalizedItems.includes(normalized)) {
      normalizedItems.push(normalized);
    }
  }
  return normalizedItems;
}

function healthInlineInputMarkup(elementId) {
  const placeholder = elementId === "profileRestrictions" ? "Add allergy" : "Add medical note";
  return `
    <span class="profile-chip-inline-input" data-target="${escapeHTML(elementId)}">
      <input type="text" class="profile-chip-input" placeholder="${escapeHTML(placeholder)}" />
      <button type="button" class="profile-chip-confirm" aria-label="Add">Add</button>
      <button type="button" class="profile-chip-cancel" aria-label="Cancel">Cancel</button>
    </span>
  `;
}

function renderChipList(elementId, values) {
  const container = $(elementId);
  if (!container) return;

  const items = [];
  for (const value of splitList(values)) {
    const normalized = normalizeProfileItem(value);
    if (normalized && !items.includes(normalized)) items.push(normalized);
  }

  if (!items.length) {
    container.innerHTML = healthEditing
      ? (activeHealthInputTarget === elementId
          ? healthInlineInputMarkup(elementId)
          : `<button type="button" class="profile-chip-add" data-target="${escapeHTML(elementId)}" aria-label="Add item">+</button>`)
      : "<span>None listed</span>";
    return;
  }

  container.innerHTML = items
    .map((item) => {
      const editable = healthEditing ? `
        <button type="button" class="profile-chip-remove" data-chip="${escapeHTML(item)}" aria-label="Remove ${escapeHTML(formatPreferenceLabel(item))}">
          x
        </button>
      ` : "";
      return `<span class="profile-editable-chip">${escapeHTML(formatPreferenceLabel(item))}${editable}</span>`;
    })
    .join("");

  if (healthEditing) {
    container.insertAdjacentHTML(
      "beforeend",
      activeHealthInputTarget === elementId
        ? healthInlineInputMarkup(elementId)
        : `<button type="button" class="profile-chip-add" data-target="${escapeHTML(elementId)}" aria-label="Add item">+</button>`
    );
  }
}

function mergeProfilesForDisplay(dbProfile, cachedProfile) {
  const merged = mergeNonEmptyProfileValues(cachedProfile, dbProfile);

  const dbRestrictions = normalizeRestrictionList(dbProfile?.restrictions);
  const cacheRestrictions = normalizeRestrictionList(cachedProfile?.restrictions);
  const chosenRestrictions = dbRestrictions.length > 0 ? dbRestrictions : cacheRestrictions;

  if (chosenRestrictions.length > 0) {
    merged.restrictions = chosenRestrictions.join(", ");
  } else {
    merged.restrictions = "";
  }

  return merged;
}

function getAvatarUrl(profile) {
  return (
    profile?.profile_image_url ||
    profile?.avatar_url ||
    profile?.avatarUrl ||
    profile?.avatar ||
    localStorage.getItem(AVATAR_STORAGE_KEY) ||
    ""
  );
}

function setAvatar(profile) {
  const avatar = $("profileAvatar");
  if (!avatar) return;

  const name = profile?.name || "PlateWise User";
  const initial = name.trim().charAt(0).toUpperCase() || "P";
  const imageUrl = getAvatarUrl(profile);

  if (imageUrl) {
    avatar.innerHTML = `<img src="${escapeHTML(imageUrl)}" alt="${escapeHTML(name)} profile photo" />`;
  } else {
    avatar.innerHTML = `<span id="profileInitial">${escapeHTML(initial)}</span>`;
  }
}

function fillProfile(profile) {
  const cachedProfile = readCachedProfile();
  const normalizedActivityLevel = getMostReliableActivityLevel(profile, cachedProfile);

  currentProfile = {
    ...(profile || {}),
    activity: normalizedActivityLevel,
    activityLevel: normalizedActivityLevel,
    activity_level: normalizedActivityLevel,
  };

  const updatedCache = {
    ...cachedProfile,
    ...currentProfile,
    activity: normalizedActivityLevel,
    activityLevel: normalizedActivityLevel,
    activity_level: normalizedActivityLevel,
  };

  localStorage.setItem(ACTIVITY_STORAGE_KEY, normalizedActivityLevel);
  writeProfileCache(updatedCache);

  const name = currentProfile?.name || "PlateWise User";
  const age = currentProfile?.age || "";
  const gender = formatGender(currentProfile?.gender);
  const height = currentProfile?.height_cm || currentProfile?.height || "";
  const weight = currentProfile?.weight_kg || currentProfile?.weight || "";
  const goal = currentProfile?.goal || "";

  if ($("profileName")) $("profileName").textContent = name;
  if ($("profileMeta")) $("profileMeta").textContent = "Personalized nutrition profile";

  if ($("profileAge")) {
    $("profileAge").innerHTML = biometricsEditing
      ? profileInputMarkup("profileAgeInput", age)
      : escapeHTML(age || "-");
  }
  if ($("profileGender")) {
    $("profileGender").innerHTML = biometricsEditing
      ? profileSelectMarkup("profileGenderInput", currentProfile?.gender || "", GENDER_OPTIONS)
      : escapeHTML(gender || "-");
  }

  if ($("profileHeight")) {
    $("profileHeight").innerHTML = biometricsEditing
      ? profileInputMarkup("profileHeightInput", height, "cm")
      : escapeHTML(height || "-");
  }
  if ($("profileHeightUnit")) $("profileHeightUnit").classList.toggle("hidden", biometricsEditing || !height);

  if ($("profileWeight")) {
    $("profileWeight").innerHTML = biometricsEditing
      ? profileInputMarkup("profileWeightInput", weight, "kg")
      : escapeHTML(weight || "-");
  }
  if ($("profileWeightUnit")) $("profileWeightUnit").classList.toggle("hidden", biometricsEditing || !weight);

  if ($("profileGoal")) {
    $("profileGoal").innerHTML = goalEditing
      ? profileSelectMarkup("profileGoalInput", normalizeGoal(goal) || "maintain", GOAL_OPTIONS)
      : escapeHTML(formatGoal(goal));
  }
  if ($("profileGoalDescription")) $("profileGoalDescription").textContent = goalDescription(goal);
  if ($("profileGoalIcon")) $("profileGoalIcon").innerHTML = goalIconMarkup(goal);

  if ($("profileActivityLevel")) {
    $("profileActivityLevel").innerHTML = biometricsEditing
      ? profileSelectMarkup("profileActivityInput", normalizedActivityLevel, ACTIVITY_OPTIONS)
      : escapeHTML(formatActivityLevel(normalizedActivityLevel));
  }

  renderChipList("profileRestrictions", getAllergiesAndPreferences(currentProfile));
  renderChipList(
    "profileHealthNotes",
    currentProfile?.health_notes ||
      currentProfile?.healthNotes ||
      currentProfile?.conditions
  );

  setAvatar(currentProfile);
  document.querySelector(".profile-goal-card-v2")?.classList.toggle("is-editing", goalEditing);
  document.querySelector(".profile-biometrics-card")?.classList.toggle("is-editing", biometricsEditing);
  document.querySelector(".profile-health-card-v2")?.classList.toggle("is-editing", healthEditing);
  if ($("editGoalBtn")) $("editGoalBtn").textContent = goalEditing ? "Save" : "Edit";
  if ($("editBiometricsBtn")) $("editBiometricsBtn").textContent = biometricsEditing ? "Save" : "Edit";
  if ($("editHealthBtn")) $("editHealthBtn").textContent = healthEditing ? "Save" : "Edit";
}
async function getAppUserForProfile() {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) throw new Error("No auth user");

  const { data: appUser, error } = await supabase
    .from("users")
    .select("*")
    .eq("supabase_auth_id", user.id)
    .single();

  if (error) throw error;
  return appUser;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read image."));

    reader.readAsDataURL(file);
  });
}

async function uploadAvatar(file) {
  if (!file) return null;

  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }

  if (file.size > 5 * 1024 * 1024) {
    throw new Error("Profile photo must be smaller than 5MB.");
  }

  const localPreviewUrl = await readFileAsDataUrl(file);

  localStorage.setItem(AVATAR_STORAGE_KEY, localPreviewUrl);

  currentProfile = {
    ...currentProfile,
    avatar_url: localPreviewUrl,
    profile_image_url: localPreviewUrl,
  };

  fillProfile(currentProfile);

  if (!currentAppUser) {
    return localPreviewUrl;
  }

  try {
    const ext = file.name.split(".").pop() || "jpg";
    const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const path = `${currentAppUser.id}/${Date.now()}.${safeExt}`;

    const { error: uploadError } = await supabase.storage
      .from("profile-avatars")
      .upload(path, file, {
        cacheControl: "3600",
        upsert: true,
        contentType: file.type || "image/jpeg",
      });

    if (uploadError) {
      console.warn("Supabase avatar upload failed, using local avatar only:", uploadError);
      return localPreviewUrl;
    }

    const { data } = supabase.storage
      .from("profile-avatars")
      .getPublicUrl(path);

    const avatarUrl = data?.publicUrl;
    if (!avatarUrl) return localPreviewUrl;

    const { error: updateError } = await supabase
      .from("user_profiles")
      .update({
        avatar_url: avatarUrl,
        profile_image_url: avatarUrl,
      })
      .eq("user_id", currentAppUser.id);

    if (updateError) {
      console.warn("Profile avatar DB update failed, using local avatar only:", updateError);
      return localPreviewUrl;
    }

    localStorage.setItem(AVATAR_STORAGE_KEY, avatarUrl);

    currentProfile = {
      ...currentProfile,
      avatar_url: avatarUrl,
      profile_image_url: avatarUrl,
    };

    fillProfile(currentProfile);

    return avatarUrl;
  } catch (error) {
    console.warn("Avatar upload fallback:", error);
    return localPreviewUrl;
  }
}

function setupAvatarUpload() {
  const input = $("avatarUpload");
  const avatar = $("profileAvatar");

  avatar?.addEventListener("click", () => {
    input?.click();
  });

  avatar?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input?.click();
    }
  });

  input?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      await uploadAvatar(file);
      showToast("Profile photo updated.");
    } catch (error) {
      console.error("Avatar upload failed:", error);
      showToast(error.message || "Failed to update photo.", true);
    } finally {
      input.value = "";
    }
  });
}

async function handleLogout() {
  try {
    await signOutUser();
    window.location.href = "index.html";
  } catch (error) {
    showToast(error.message || "Failed to sign out.", true);
  }
}

function listToStorage(items) {
  return items.map((item) => formatPreferenceLabel(item)).filter(Boolean).join(", ");
}

function getCurrentRestrictions() {
  return normalizeRestrictionList([
    ...splitList(currentProfile?.restrictions),
    ...splitList(currentProfile?.allergies),
  ]);
}

function getCurrentHealthNotes() {
  return splitList(currentProfile?.health_notes || currentProfile?.healthNotes || currentProfile?.conditions)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getCurrentDietPreferences() {
  return splitList(currentProfile?.diet_preferences || currentProfile?.dietPreferences)
    .map(normalizeProfileItem)
    .filter(Boolean);
}

async function updateProfileRecord(payload) {
  const nextProfile = { ...(currentProfile || {}), ...payload };
  currentProfile = nextProfile;
  writeProfileCache({ ...readCachedProfile(), ...nextProfile });

  if (!currentAppUser?.id) return;

  const { error } = await supabase
    .from("user_profiles")
    .update(payload)
    .eq("user_id", currentAppUser.id);

  if (!error) return;

  const supportedKeys = [
    "age",
    "gender",
    "height_cm",
    "weight_kg",
    "goal",
    "restrictions",
    "health_notes",
    "avatar_url",
    "profile_image_url",
  ];
  const fallbackPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => supportedKeys.includes(key))
  );

  if (!Object.keys(fallbackPayload).length) return;

  const fallbackResult = await supabase
    .from("user_profiles")
    .update(fallbackPayload)
    .eq("user_id", currentAppUser.id);

  if (fallbackResult.error) throw fallbackResult.error;
}

function readNumberInput(id, min, max) {
  const value = Number($(id)?.value);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

async function saveBiometrics() {
  const age = readNumberInput("profileAgeInput", 1, 120);
  const height = readNumberInput("profileHeightInput", 50, 250);
  const weight = readNumberInput("profileWeightInput", 20, 300);
  const gender = $("profileGenderInput")?.value || "";
  const activityLevel = normalizeActivityLevel($("profileActivityInput")?.value) || "moderately_active";

  if (!age || !height || !weight || !gender) {
    showToast("Please enter valid biometrics.", true);
    return false;
  }

  const payload = {
    age,
    gender,
    height_cm: height,
    weight_kg: weight,
    activity_level: activityLevel,
  };

  localStorage.setItem(ACTIVITY_STORAGE_KEY, activityLevel);
  await updateProfileRecord(payload);
  showToast("Biometrics updated.");
  return true;
}

async function saveHealthLists(restrictions, healthNotes, dietPreferences = getCurrentDietPreferences()) {
  const restrictionText = listToStorage(restrictions);
  const healthText = healthNotes.map((item) => item.trim()).filter(Boolean).join(", ");
  const dietText = listToStorage(dietPreferences);

  await updateProfileRecord({
    restrictions: restrictionText,
    allergies: restrictionText,
    diet_preferences: dietText,
    health_notes: healthText,
    conditions: healthText,
  });
}

async function removeHealthChip(targetId, chipValue) {
  const normalizedChip = normalizeProfileItem(chipValue);
  const restrictions = getCurrentRestrictions().filter((item) => normalizeProfileItem(item) !== normalizedChip);
  const healthNotes = getCurrentHealthNotes().filter((item) => normalizeProfileItem(item) !== normalizedChip);

  if (targetId === "profileRestrictions") {
    const dietPreferences = getCurrentDietPreferences().filter((item) => normalizeProfileItem(item) !== normalizedChip);
    await saveHealthLists(restrictions, getCurrentHealthNotes(), dietPreferences);
  } else {
    await saveHealthLists(getCurrentRestrictions(), healthNotes);
  }

  fillProfile(currentProfile);
}

async function addHealthChip(targetId) {
  const input = $(targetId)?.querySelector(".profile-chip-input");
  const value = input?.value || "";
  const normalized = targetId === "profileRestrictions"
    ? normalizeProfileItem(value)
    : String(value || "").trim().toLowerCase();

  if (!normalized) return;

  const restrictions = getCurrentRestrictions();
  const healthNotes = getCurrentHealthNotes();

  if (targetId === "profileRestrictions") {
    if (!restrictions.includes(normalized)) restrictions.push(normalized);
  } else if (!healthNotes.map((item) => item.toLowerCase()).includes(normalized)) {
    healthNotes.push(normalized);
  }

  await saveHealthLists(restrictions, healthNotes);
  activeHealthInputTarget = "";
  fillProfile(currentProfile);
}

function showHealthInlineInput(targetId) {
  activeHealthInputTarget = targetId;
  fillProfile(currentProfile);
  setTimeout(() => {
    $(targetId)?.querySelector(".profile-chip-input")?.focus();
  }, 0);
}

function hideHealthInlineInput() {
  activeHealthInputTarget = "";
  fillProfile(currentProfile);
}

async function toggleBiometricsEdit() {
  if (!biometricsEditing) {
    biometricsEditing = true;
    fillProfile(currentProfile);
    return;
  }

  const saved = await saveBiometrics().catch((error) => {
    showToast(error.message || "Failed to update biometrics.", true);
    return false;
  });

  if (saved) {
    biometricsEditing = false;
    fillProfile(currentProfile);
  }
}

async function toggleGoalEdit() {
  if (!goalEditing) {
    goalEditing = true;
    fillProfile(currentProfile);
    return;
  }

  const goal = normalizeGoal($("profileGoalInput")?.value);
  if (!goal) {
    showToast("Please choose a valid goal.", true);
    return;
  }

  try {
    await updateProfileRecord({ goal });
    goalEditing = false;
    showToast("Goal updated.");
    fillProfile(currentProfile);
  } catch (error) {
    showToast(error.message || "Failed to update goal.", true);
  }
}

function toggleHealthEdit() {
  healthEditing = !healthEditing;
  activeHealthInputTarget = "";
  if (!healthEditing) showToast("Health information saved.");
  fillProfile(currentProfile);
}

function setupNavigation() {
  if (navigationSetup) return;
  navigationSetup = true;

  $("editProfileBtn")?.addEventListener("click", () => {
    window.location.href = "onboarding.html";
  });

  $("editGoalBtn")?.addEventListener("click", toggleGoalEdit);
  $("editBiometricsBtn")?.addEventListener("click", toggleBiometricsEdit);
  $("editHealthBtn")?.addEventListener("click", toggleHealthEdit);

  $("profileRestrictions")?.addEventListener("click", async (event) => {
    const removeBtn = event.target.closest(".profile-chip-remove");
    const addBtn = event.target.closest(".profile-chip-add");
    const confirmBtn = event.target.closest(".profile-chip-confirm");
    const cancelBtn = event.target.closest(".profile-chip-cancel");
    if (removeBtn) await removeHealthChip("profileRestrictions", removeBtn.dataset.chip);
    if (addBtn) showHealthInlineInput("profileRestrictions");
    if (confirmBtn) await addHealthChip("profileRestrictions");
    if (cancelBtn) hideHealthInlineInput();
  });

  $("profileHealthNotes")?.addEventListener("click", async (event) => {
    const removeBtn = event.target.closest(".profile-chip-remove");
    const addBtn = event.target.closest(".profile-chip-add");
    const confirmBtn = event.target.closest(".profile-chip-confirm");
    const cancelBtn = event.target.closest(".profile-chip-cancel");
    if (removeBtn) await removeHealthChip("profileHealthNotes", removeBtn.dataset.chip);
    if (addBtn) showHealthInlineInput("profileHealthNotes");
    if (confirmBtn) await addHealthChip("profileHealthNotes");
    if (cancelBtn) hideHealthInlineInput();
  });

  ["profileRestrictions", "profileHealthNotes"].forEach((targetId) => {
    $(targetId)?.addEventListener("keydown", async (event) => {
      if (!event.target.closest(".profile-chip-input")) return;
      if (event.key === "Enter") {
        event.preventDefault();
        await addHealthChip(targetId);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hideHealthInlineInput();
      }
    });
  });

  $("logMealBtn")?.addEventListener("click", () => {
    window.location.href = "chat.html";
  });

  $("logoutBtn")?.addEventListener("click", handleLogout);
}

async function boot() {
  setupNavigation();

  const session = await getCurrentSession().catch(() => null);
  if (redirectIfNoSession(session)) return;

  try {
    currentAppUser = await getAppUserForProfile().catch(() => null);

    const data = await getUserProfile().catch(() => null);
    const cachedProfile = readCachedProfile();

    fillProfile(mergeProfilesForDisplay(data?.profile || {}, cachedProfile));
  } catch (error) {
    showToast(error.message || "Failed to load profile.", true);
    fillProfile(readCachedProfile());
  }

  setupAvatarUpload();
}

boot();

