import { getCurrentSession } from "../lib/auth.js";
import { getUserProfile, upsertUserProfile } from "../lib/data.js";
import { redirectIfNoSession } from "../lib/router.js";
import { $, showToast } from "../lib/utils.js";

function normalizeGoal(goal) {
  const value = String(goal || "").trim().toLowerCase().replace(/\s+/g, "_");
  const allowed = ["lose_weight", "gain_weight", "gain_muscle", "maintain"];
  return allowed.includes(value) ? value : "";
}

function fillForm(profile) {
  if (!profile) return;

  $("name").value = profile.name || "";
  $("age").value = profile.age || "";
  $("gender").value = profile.gender || "";
  $("height").value = profile.height_cm || "";
  $("weight").value = profile.weight_kg || "";
  $("goal").value = normalizeGoal(profile.goal);
  $("restrictions").value = profile.restrictions || "";
  $("healthNotes").value = profile.health_notes || "";
}

async function handleSave() {
  const payload = {
    name: $("name").value.trim(),
    age: $("age").value.trim(),
    gender: $("gender").value,
    height: $("height").value.trim(),
    weight: $("weight").value.trim(),
    goal: normalizeGoal($("goal").value),
    restrictions: $("restrictions").value.trim(),
    healthNotes: $("healthNotes").value.trim(),
  };

  if (!payload.name || !payload.age || !payload.gender || !payload.height || !payload.weight || !payload.goal) {
    showToast("Please complete name, age, gender, height, weight, and goal.", true);
    return;
  }

  try {
    await upsertUserProfile(payload);
    showToast("Profile saved successfully.");
    setTimeout(() => {
      window.location.href = "dashboard.html";
    }, 500);
  } catch (error) {
    showToast(error.message || "Failed to save profile.", true);
  }
}

async function boot() {
  const session = await getCurrentSession().catch(() => null);
  if (redirectIfNoSession(session)) return;

  const data = await getUserProfile().catch(() => null);
  if (data?.profile) fillForm(data.profile);

  $("saveProfileBtn")?.addEventListener("click", handleSave);
}

boot();