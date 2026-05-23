import { getCurrentSession } from "../lib/auth.js";
import { getUserProfile, upsertUserProfile } from "../lib/data.js";
import { redirectIfNoSession } from "../lib/router.js";
import { $, showToast } from "../lib/utils.js";

const totalSteps = 4;
const AVATAR_STORAGE_KEY = "platewise_profile_avatar";
const PROFILE_CACHE_KEY = "platewise_profile_cache";
const ACTIVITY_STORAGE_KEY = "platewise_activity_level";

let currentStep = 1;
let selectedAvatarDataUrl = "";

function normalizeGoal(goal) {
  const value = String(goal || "").trim().toLowerCase().replace(/\s+/g, "_");
  const allowed = ["lose_weight", "gain_weight", "gain_muscle", "maintain"];
  return allowed.includes(value) ? value : "";
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

  return aliases[normalized] || "moderately_active";
}

function readCachedProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeProfileCachePatch(patch) {
  const cachedProfile = readCachedProfile();

  localStorage.setItem(
    PROFILE_CACHE_KEY,
    JSON.stringify({
      ...cachedProfile,
      ...patch,
    })
  );
}

function syncActivityLevelToLocalStorage(value) {
  const activityLevel = normalizeActivityLevel(value);

  localStorage.setItem(ACTIVITY_STORAGE_KEY, activityLevel);

  writeProfileCachePatch({
    activity: activityLevel,
    activityLevel,
    activity_level: activityLevel,
  });

  return activityLevel;
}

function splitSavedList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getStepPanels() {
  return Array.from(document.querySelectorAll(".onboarding-step"));
}

function updateStepUI() {
  getStepPanels().forEach((panel) => {
    const step = Number(panel.dataset.step);
    panel.classList.toggle("active", step === currentStep);
  });

  const stepLabel = $("stepLabel");
  const prevBtn = $("prevBtn");
  const nextBtn = $("nextBtn");
  const finishBtn = $("finishBtn");

  if (stepLabel) stepLabel.textContent = `Step ${currentStep} of ${totalSteps}`;

  if (prevBtn) prevBtn.classList.toggle("hidden", currentStep === 1);
  if (nextBtn) nextBtn.classList.toggle("hidden", currentStep === totalSteps);
  if (finishBtn) finishBtn.classList.toggle("hidden", currentStep !== totalSteps);
}

function validateStep(step) {
  if (step === 1) {
    const name = $("name")?.value.trim();
    const age = Number($("age")?.value);
    const gender = $("gender")?.value;

    if (!name) {
      showToast("Please enter your nickname.", true);
      return false;
    }

    if (!age || age < 1 || age > 120) {
      showToast("Please enter a valid age.", true);
      return false;
    }

    if (!gender) {
      showToast("Please select your gender.", true);
      return false;
    }
  }

  if (step === 2) {
    const height = Number($("height")?.value);
    const weight = Number($("weight")?.value);

    if (!height || height < 50 || height > 250) {
      showToast("Please enter a valid height in cm.", true);
      return false;
    }

    if (!weight || weight < 20 || weight > 300) {
      showToast("Please enter a valid weight in kg.", true);
      return false;
    }

    syncActivityLevelToLocalStorage($("activityLevel")?.value);
  }

  if (step === 4) {
    if (!normalizeGoal($("goal")?.value)) {
      showToast("Please select your primary goal.", true);
      return false;
    }
  }

  return true;
}

function goNext() {
  if (!validateStep(currentStep)) return;

  currentStep = Math.min(totalSteps, currentStep + 1);
  updateStepUI();
}

function goBack() {
  if (currentStep === 1) {
    window.location.href = "index.html";
    return;
  }

  currentStep = Math.max(1, currentStep - 1);
  updateStepUI();
}

function getDefaultAvatarMarkup() {
  return `
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M12 12C14.2 12 16 10.2 16 8C16 5.8 14.2 4 12 4C9.8 4 8 5.8 8 8C8 10.2 9.8 12 12 12Z"
        stroke="currentColor"
        stroke-width="1.8"
      />
      <path
        d="M4.8 20C5.7 16.9 8.4 15.2 12 15.2C15.6 15.2 18.3 16.9 19.2 20"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
  `;
}

function renderAvatar(dataUrl) {
  const preview = $("avatarPreview");
  if (!preview) return;

  if (!dataUrl) {
    preview.innerHTML = getDefaultAvatarMarkup();
    return;
  }

  preview.innerHTML = `<img src="${dataUrl}" alt="Profile avatar preview" />`;
}

function compressAvatar(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const reader = new FileReader();

    reader.onload = () => {
      image.src = reader.result;
    };

    reader.onerror = () => {
      reject(new Error("Failed to read image."));
    };

    image.onload = () => {
      const canvas = document.createElement("canvas");
      const size = 320;

      canvas.width = size;
      canvas.height = size;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to process image."));
        return;
      }

      const minSide = Math.min(image.width, image.height);
      const sx = (image.width - minSide) / 2;
      const sy = (image.height - minSide) / 2;

      ctx.drawImage(image, sx, sy, minSide, minSide, 0, 0, size, size);

      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      resolve(dataUrl);
    };

    image.onerror = () => {
      reject(new Error("Invalid image file."));
    };

    reader.readAsDataURL(file);
  });
}

function setupAvatarPreview() {
  const input = $("profileImageInput");
  const preview = $("avatarPreview");

  if (!input || !preview) return;

  const savedAvatar = localStorage.getItem(AVATAR_STORAGE_KEY);
  if (savedAvatar) {
    selectedAvatarDataUrl = savedAvatar;
    renderAvatar(savedAvatar);
  }

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      showToast("Please choose an image file.", true);
      input.value = "";
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      showToast("Avatar image must be smaller than 5MB.", true);
      input.value = "";
      return;
    }

    try {
      const dataUrl = await compressAvatar(file);

      selectedAvatarDataUrl = dataUrl;
      localStorage.setItem(AVATAR_STORAGE_KEY, dataUrl);
      renderAvatar(dataUrl);

      showToast("Avatar updated.");
    } catch (error) {
      showToast(error.message || "Failed to update avatar.", true);
      input.value = "";
    }
  });
}

function ensureCheckIcon(button) {
  if (!button || button.querySelector(".allergy-check-icon")) return;

  const icon = document.createElement("span");
  icon.className = "allergy-check-icon";
  icon.textContent = "✓";
  icon.setAttribute("aria-hidden", "true");

  button.appendChild(icon);
}

function removeCheckIcon(button) {
  button?.querySelector(".allergy-check-icon")?.remove();
}

function syncAllergyCheckIcons() {
  document.querySelectorAll("#allergyChipGrid button[data-value]").forEach((button) => {
    if (button.classList.contains("selected")) {
      ensureCheckIcon(button);
    } else {
      removeCheckIcon(button);
    }

    button.querySelectorAll("svg").forEach((svg) => svg.remove());
  });
}

function setupSelectableButtons(containerId, selectedClass = "selected") {
  const container = $(containerId);
  if (!container) return;

  container.querySelectorAll("button[data-value]").forEach((button) => {
    button.addEventListener("click", () => {
      button.classList.toggle(selectedClass);

      if (containerId === "allergyChipGrid") {
        syncAllergyCheckIcons();
      }
    });
  });

  if (containerId === "allergyChipGrid") {
    syncAllergyCheckIcons();
  }
}

function setupGoalCards() {
  const list = $("goalCardList");
  const goalInput = $("goal");

  if (!list || !goalInput) return;

  list.querySelectorAll("button[data-goal]").forEach((button) => {
    button.addEventListener("click", () => {
      const goal = normalizeGoal(button.dataset.goal);
      if (!goal) return;

      goalInput.value = goal;

      list.querySelectorAll("button[data-goal]").forEach((item) => {
        item.classList.toggle("selected", item === button);
      });
    });
  });
}

function setupActivityLevelSync() {
  const activitySelect = $("activityLevel");
  if (!activitySelect) return;

  const cachedProfile = readCachedProfile();

  const savedActivityLevel =
    cachedProfile.activity_level ||
    cachedProfile.activityLevel ||
    cachedProfile.activity ||
    localStorage.getItem(ACTIVITY_STORAGE_KEY) ||
    activitySelect.value;

  const normalizedActivityLevel = syncActivityLevelToLocalStorage(savedActivityLevel);
  activitySelect.value = normalizedActivityLevel;

  activitySelect.addEventListener("change", () => {
    const newActivityLevel = syncActivityLevelToLocalStorage(activitySelect.value);
    activitySelect.value = newActivityLevel;
  });
}

function getSelectedAllergies() {
  const selected = Array.from(
    document.querySelectorAll("#allergyChipGrid button.selected[data-value]")
  ).map((button) => button.dataset.value);

  const other = $("otherAllergy")?.value.trim();
  if (other) selected.push(other);

  return selected;
}

function getSelectedConditions() {
  const selected = Array.from(
    document.querySelectorAll("#conditionGrid button.selected[data-value]")
  ).map((button) => button.dataset.value);

  const other = $("otherCondition")?.value.trim();
  if (other) selected.push(other);

  return selected;
}

function applySelectedValues(containerId, values) {
  const normalizedValues = values.map((value) => value.toLowerCase());
  const container = $(containerId);

  if (!container) return;

  container.querySelectorAll("button[data-value]").forEach((button) => {
    const buttonValue = String(button.dataset.value || "").toLowerCase();
    button.classList.toggle("selected", normalizedValues.includes(buttonValue));
  });

  if (containerId === "allergyChipGrid") {
    syncAllergyCheckIcons();
  }
}

function fillForm(profile) {
  if (!profile) return;

  const avatar =
    profile.avatar_url ||
    profile.avatarUrl ||
    profile.avatar ||
    localStorage.getItem(AVATAR_STORAGE_KEY);

  if (avatar) {
    selectedAvatarDataUrl = avatar;
    localStorage.setItem(AVATAR_STORAGE_KEY, avatar);
    renderAvatar(avatar);
  }

  $("name").value = profile.name || "";
  $("age").value = profile.age || "";
  $("gender").value = profile.gender || "";
  $("height").value = profile.height_cm || profile.height || "";
  $("weight").value = profile.weight_kg || profile.weight || "";

  if ($("activityLevel")) {
    const savedActivityLevel =
      profile.activity_level ||
      profile.activityLevel ||
      profile.activity ||
      localStorage.getItem(ACTIVITY_STORAGE_KEY) ||
      $("activityLevel").value;

    const normalizedActivityLevel = syncActivityLevelToLocalStorage(savedActivityLevel);
    $("activityLevel").value = normalizedActivityLevel;
  }

  const goal = normalizeGoal(profile.goal) || "gain_weight";
  $("goal").value = goal;

  document.querySelectorAll("#goalCardList button[data-goal]").forEach((button) => {
    button.classList.toggle("selected", normalizeGoal(button.dataset.goal) === goal);
  });

  const allergies = splitSavedList(profile.restrictions || profile.allergies);
  applySelectedValues("allergyChipGrid", allergies);

  const conditions = splitSavedList(profile.health_notes || profile.healthNotes || profile.conditions);
  applySelectedValues("conditionGrid", conditions);
}

async function handleSave(event) {
  event.preventDefault();

  if (!validateStep(currentStep)) return;

  const allergies = getSelectedAllergies();
  const conditions = getSelectedConditions();

  const selectedActivityLevel = syncActivityLevelToLocalStorage($("activityLevel")?.value);

  const payload = {
    name: $("name").value.trim(),
    age: $("age").value.trim(),
    gender: $("gender").value,

    height: $("height").value.trim(),
    height_cm: $("height").value.trim(),

    weight: $("weight").value.trim(),
    weight_kg: $("weight").value.trim(),

    goal: normalizeGoal($("goal").value),

    activity: selectedActivityLevel,
    activityLevel: selectedActivityLevel,
    activity_level: selectedActivityLevel,

    restrictions: allergies.join(", "),
    allergies: allergies.join(", "),

    healthNotes: conditions.join(", "),
    health_notes: conditions.join(", "),
    conditions: conditions.join(", "),

    avatarUrl: selectedAvatarDataUrl,
    avatar_url: selectedAvatarDataUrl,
  };

  if (
    !payload.name ||
    !payload.age ||
    !payload.gender ||
    !payload.height ||
    !payload.weight ||
    !payload.goal
  ) {
    showToast("Please complete all required fields.", true);
    return;
  }

  try {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, selectedActivityLevel);
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(payload));

    await upsertUserProfile(payload);

    localStorage.setItem(ACTIVITY_STORAGE_KEY, selectedActivityLevel);
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(payload));

    showToast("Profile saved successfully.");

    setTimeout(() => {
      window.location.href = "dashboard.html";
    }, 500);
  } catch (error) {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, selectedActivityLevel);
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(payload));

    showToast(error.message || "Saved locally, but failed to sync profile.", true);

    setTimeout(() => {
      window.location.href = "dashboard.html";
    }, 800);
  }
}

async function boot() {
  const session = await getCurrentSession().catch(() => null);
  if (redirectIfNoSession(session)) return;

  const data = await getUserProfile().catch(() => null);
  const cachedProfile = readCachedProfile();

  setupAvatarPreview();
  setupSelectableButtons("allergyChipGrid");
  setupSelectableButtons("conditionGrid");
  setupGoalCards();
  setupActivityLevelSync();

  fillForm({
    ...(data?.profile || {}),
    ...cachedProfile,
  });

  $("profileForm")?.addEventListener("submit", handleSave);
  $("nextBtn")?.addEventListener("click", goNext);
  $("prevBtn")?.addEventListener("click", goBack);
  $("topBackBtn")?.addEventListener("click", goBack);

  updateStepUI();
}

boot();