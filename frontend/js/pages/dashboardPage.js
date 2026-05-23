import { supabase } from "../lib/supabaseClient.js";
import { getCurrentSession } from "../lib/auth.js";
import { redirectIfNoSession } from "../lib/router.js";
import { $ } from "../lib/utils.js";

// Merged version: keeps old target-calculation logic and supports the new dashboard UI IDs.
const HYDRATION_CUP_LITERS = 0.5;
const HYDRATION_OVERRIDE_PREFIX = "platewise_hydration_override";
const HYDRATION_GOAL_PREFIX = "platewise_hydration_goal";
const ACTIVITY_CSV_PATH = "./assets/MET_activities_with_activity_level.csv";
const ACTIVITY_LOG_PREFIX = "platewise_activity_logs";
const HYDRATION_EASTER_EGG_MEMBER_DIR = "./assets/colorful_egg/memebers";
const HYDRATION_EASTER_EGG_MEMBER_FILES = [
  "hydration-easter-egg-1.png",
  "hydration-easter-egg-2.png",
  "hydration-easter-egg-3.png",
  "hydration-easter-egg-4.png",
  "hydration-easter-egg-5.png",
];
const HYDRATION_EASTER_EGG_IMAGES = HYDRATION_EASTER_EGG_MEMBER_FILES.map(
  (fileName) => `${HYDRATION_EASTER_EGG_MEMBER_DIR}/${fileName}`
);

let hydrationContext = { userId: "", date: "" };
let activityContext = { userId: "", date: "" };
let activityRows = [];
let selectedActivityIntensity = "Moderately active";
let activityEntryMode = "custom";
let activityTemplateSearchTimer = null;
let dashboardState = {
  today: null,
  targets: null,
  burnedCalories: 0,
  activityWeightKg: 55,
};
let hydrationCelebrationTimer = null;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function dateISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function formatShortDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function riskClass(risk) {
  if (risk === "high") return "danger-text";
  if (risk === "medium") return "warning-text";
  return "success-text";
}

function normalizeRisk(risk) {
  const value = String(risk || "low").toLowerCase();
  if (value.includes("high")) return "high";
  if (value.includes("medium") || value.includes("moderate")) return "medium";
  return "low";
}

function riskLabel(risk) {
  const value = normalizeRisk(risk);
  return `${value.charAt(0).toUpperCase()}${value.slice(1)} Risk`;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getHydrationOverrideKey() {
  return `${HYDRATION_OVERRIDE_PREFIX}:${hydrationContext.userId || "anon"}:${hydrationContext.date || todayISO()}`;
}

function readHydrationOverride() {
  try {
    const raw = localStorage.getItem(getHydrationOverrideKey());
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeHydrationOverride(value) {
  try {
    localStorage.setItem(getHydrationOverrideKey(), String(value));
  } catch {
    // Local hydration state is optional.
  }
}

function getHydrationGoalKey() {
  return `${HYDRATION_GOAL_PREFIX}:${hydrationContext.userId || "anon"}`;
}

function readHydrationGoalOverride() {
  try {
    const raw = localStorage.getItem(getHydrationGoalKey());
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeHydrationGoalOverride(value) {
  try {
    localStorage.setItem(getHydrationGoalKey(), String(value));
  } catch {
    // Local goal persistence is optional.
  }
}

function getRandomHydrationEasterEggImage() {
  const images = HYDRATION_EASTER_EGG_IMAGES.filter(Boolean);
  if (!images.length) return null;

  const index = Math.floor(Math.random() * images.length);
  return images[index];
}

function showHydrationEasterEgg() {
  const overlay = $("hydrationEasterEgg");
  const image = $("hydrationEasterEggImage");
  if (!overlay || !image) return;

  const nextImage = getRandomHydrationEasterEggImage();
  if (!nextImage) return;

  window.clearTimeout(hydrationCelebrationTimer);
  image.onerror = () => {
    image.onerror = null;
    image.src = HYDRATION_EASTER_EGG_IMAGES[0] || "";
  };
  image.src = nextImage;
  overlay.classList.remove("is-visible");
  void overlay.offsetWidth;
  overlay.classList.add("is-visible");

  hydrationCelebrationTimer = window.setTimeout(() => {
    overlay.classList.remove("is-visible");
  }, 2200);
}

function getActivityLogKey() {
  return `${ACTIVITY_LOG_PREFIX}:${activityContext.userId || "anon"}:${activityContext.date || todayISO()}`;
}

function readLocalActivityLogs() {
  try {
    const raw = localStorage.getItem(getActivityLogKey());
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalActivityLogs(logs) {
  try {
    localStorage.setItem(getActivityLogKey(), JSON.stringify(logs));
  } catch {
    // Local activity state is optional.
  }
}

function readLocalBurnedCalories() {
  return readLocalActivityLogs().reduce((sum, row) => {
    return sum + safeNumber(row.calories_burned);
  }, 0);
}

async function getAppUser() {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error("No auth user");

  const { data: appUser, error } = await supabase
    .from("users")
    .select("*")
    .eq("supabase_auth_id", user.id)
    .single();

  if (error) throw error;
  return appUser;
}

async function getProfile(appUserId) {
  const { data } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("user_id", appUserId)
    .maybeSingle();

  return data;
}

async function getReports(appUserId) {
  const fromDate = dateISO(-6);

  const { data, error } = await supabase
    .from("reports")
    .select("*")
    .eq("user_id", appUserId)
    .gte("report_date", fromDate)
    .order("report_date", { ascending: true });

  if (error) {
    console.error("Dashboard getReports error:", error);
    throw error;
  }

  console.log("Dashboard appUserId:", appUserId);
  console.log("Dashboard fromDate:", fromDate);
  console.log("Dashboard reports:", data);

  return data || [];
}

async function getDailySummaries(appUserId) {
  const fromDate = dateISO(-6);

  const { data, error } = await supabase
    .from("daily_summaries")
    .select("*")
    .eq("user_id", appUserId)
    .gte("summary_date", fromDate)
    .order("summary_date", { ascending: true });

  if (error) return [];
  return data || [];
}

/**
 * Optional: read hydration logs if you already have this table.
 * If you do not have water_logs table, it will safely return 0.
 *
 * Suggested table:
 * water_logs:
 * - id
 * - user_id
 * - log_date
 * - water_l
 */
async function getTodayWater(appUserId) {
  const { data, error } = await supabase
    .from("water_logs")
    .select("water_l")
    .eq("user_id", appUserId)
    .eq("log_date", todayISO());

  if (error || !data) return readLocalBurnedCalories();

  return data.reduce((sum, row) => {
    return sum + safeNumber(row.water_l);
  }, 0);
}

/**
 * Optional: read exercise logs if you already have this table.
 * If you do not have exercise_logs table, it will safely return 0.
 *
 * Suggested table:
 * exercise_logs:
 * - id
 * - user_id
 * - log_date
 * - calories_burned
 */
async function getTodayBurnedCalories(appUserId) {
  const { data, error } = await supabase
    .from("exercise_logs")
    .select("calories_burned")
    .eq("user_id", appUserId)
    .eq("log_date", todayISO());

  if (error || !data) return 0;

  const remoteTotal = data.reduce((sum, row) => {
    return sum + safeNumber(row.calories_burned);
  }, 0);

  return remoteTotal + readLocalBurnedCalories();
}

function parseCSVLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function parseActivityCSV(csvText) {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim());
  const headers = parseCSVLine(lines.shift() || "").map((header) => header.trim());

  return lines
    .map((line) => {
      const values = parseCSVLine(line);
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index];
      });
      return {
        activity: String(row.activity || "").trim(),
        MET: safeNumber(row.MET),
        intensity: String(row.intensity || "").trim(),
      };
    })
    .filter((row) => row.activity && row.MET > 0 && row.intensity);
}

async function loadActivityRows() {
  if (activityRows.length) return activityRows;

  try {
    const response = await fetch(ACTIVITY_CSV_PATH);
    if (!response.ok) throw new Error("Activity table not found.");
    activityRows = parseActivityCSV(await response.text());
  } catch (error) {
    console.warn("Failed to load activity CSV:", error);
    activityRows = [
      { activity: "Brisk walking", MET: 4.3, intensity: "Moderately active" },
      { activity: "Walking, easy pace", MET: 2.8, intensity: "Lightly active" },
      { activity: "Running", MET: 8.3, intensity: "Very active" },
      { activity: "Cycling", MET: 6.8, intensity: "Very active" },
    ];
  }

  return activityRows;
}

function groupReportsByDate(reports) {
  const map = {};

  reports.forEach((r) => {
    const date = r.report_date || (r.created_at || "").slice(0, 10);
    if (!date) return;

    if (!map[date]) {
      map[date] = {
        summary_date: date,
        meals_count: 0,
        total_calories: 0,
        total_sodium_mg: 0,
        total_sugar_g: 0,
        total_carbs_g: 0,
        total_fat_g: 0,
        total_protein_g: 0,
        total_fiber_g: 0,
        overall_risk: "low",
      };
    }

    map[date].meals_count += 1;
    map[date].total_calories += safeNumber(r.total_calories);
    map[date].total_sodium_mg += safeNumber(r.total_sodium_mg);
    map[date].total_sugar_g += safeNumber(r.total_sugar_g);
    map[date].total_carbs_g += safeNumber(r.total_carbs_g);
    map[date].total_fat_g += safeNumber(r.total_fat_g);
    map[date].total_protein_g += safeNumber(r.total_protein_g);
    map[date].total_fiber_g += safeNumber(r.total_fiber_g);

    if (normalizeRisk(r.risk_level) === "high") {
      map[date].overall_risk = "high";
    } else if (r.risk_level === "medium" && map[date].overall_risk !== "high") {
      map[date].overall_risk = "medium";
    }
  });

  return map;
}

function buildSevenDays(dailySummaries, reports) {
  const reportMap = groupReportsByDate(reports);
  const summaryMap = {};

  dailySummaries.forEach((s) => {
    summaryMap[s.summary_date] = s;
  });

  const days = [];

  for (let i = -6; i <= 0; i += 1) {
    const date = dateISO(i);
    const summary = summaryMap[date];
    const fallback = reportMap[date];

    days.push({
      summary_date: date,
      meals_count: safeNumber(summary?.meals_count ?? fallback?.meals_count),
      total_calories: safeNumber(summary?.total_calories ?? fallback?.total_calories),
      total_sodium_mg: safeNumber(summary?.total_sodium_mg ?? fallback?.total_sodium_mg),
      total_sugar_g: safeNumber(summary?.total_sugar_g ?? fallback?.total_sugar_g),
      total_carbs_g: safeNumber(fallback?.total_carbs_g),
      total_fat_g: safeNumber(fallback?.total_fat_g),
      total_protein_g: safeNumber(fallback?.total_protein_g),
      total_fiber_g: safeNumber(fallback?.total_fiber_g),
      overall_risk: summary?.overall_risk ?? fallback?.overall_risk ?? "low",
      generated_summary: summary?.generated_summary ?? "",
    });
  }

  return days;
}

/**
 * Calculate individual daily nutrition targets.
 * It reads your user_profiles data.
 *
 * Expected profile fields:
 * - sex / gender
 * - age
 * - height_cm
 * - weight_kg
 * - activity_level
 * - goal
 *
 * If some fields are missing, it uses safe defaults.
 */
function normalizeActivityLevel(value) {
  const raw = String(value || "lightly_active")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");

  const map = {
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

  return map[raw] || "lightly_active";
}

function calculateUserTargets(profile) {
  const sex = String(profile?.sex || profile?.gender || "female").toLowerCase();

  const age = safeNumber(profile?.age, 24);
  const heightCm = safeNumber(profile?.height_cm || profile?.height, 165);
  const weightKg = safeNumber(profile?.weight_kg, 55);

  const activityLevel = normalizeActivityLevel(profile?.activity_level);

  const activityFactors = {
    sedentary: 1.2,
    lightly_active: 1.375,
    moderately_active: 1.55,
    very_active: 1.725,
    extra_active: 1.9,
  };

  const activityFactor = activityFactors[activityLevel] || 1.375;

  let bmr;

  if (sex === "male" || sex === "m") {
    bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + 5;
  } else {
    bmr = 10 * weightKg + 6.25 * heightCm - 5 * age - 161;
  }

  const tdee = bmr * activityFactor;

  const goal = String(profile?.goal || "maintain").toLowerCase();

  let calorieGoal = tdee;

  if (goal.includes("lose") || goal.includes("loss")) {
    calorieGoal = tdee - 400;
  } else if (goal.includes("gain") || goal.includes("bulk")) {
    calorieGoal = tdee + 300;
  }

  calorieGoal = Math.max(calorieGoal, 1200);

  const proteinGoal = calorieGoal * 0.2 / 4;
  const carbsGoal = calorieGoal * 0.5 / 4;
  const fatGoal = calorieGoal * 0.3 / 9;

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    calorieGoal: Math.round(calorieGoal),

    proteinGoal: Math.round(proteinGoal),
    carbsGoal: Math.round(carbsGoal),
    fatGoal: Math.round(fatGoal),

    sugarGoal: safeNumber(profile?.sugar_goal_g, 50),
    sodiumGoal: safeNumber(profile?.sodium_goal_mg, 2300),

    waterGoal: safeNumber(profile?.water_goal_l || profile?.water_goal, 3.5),

    activityLevel: activityLevel,
    activityFactor: activityFactor,
    goal: goal,
  };
}

function renderDailyProgress(today, targets, burnedCalories) {
  const consumed = Math.round(safeNumber(today.total_calories));
  const goal = Math.round(safeNumber(targets.calorieGoal, 2400));
  const burned = Math.round(safeNumber(burnedCalories));
  const left = Math.max(goal - consumed + burned, 0);

  setText("dashboardCalorieGoal", `${goal.toLocaleString()} kcal`);
  setText("dashboardCaloriesLeft", left.toLocaleString());
  setText("dashboardCaloriesConsumed", consumed.toLocaleString());
  setText("dashboardCaloriesBurned", burned.toLocaleString());

  const radius = 76;
  const circumference = 2 * Math.PI * radius;
  const burnedRadius = 61;
  const burnedCircumference = 2 * Math.PI * burnedRadius;
  const consumedProgress = clamp(consumed / Math.max(goal, 1), 0, 1);
  const burnedProgress = clamp(burned / Math.max(goal, 1), 0, 1);
  const consumedLength = circumference * consumedProgress;
  const burnedLength = burnedCircumference * burnedProgress;

  const consumedRing = $("calorieRingConsumed") || $("calorieRingProgress");
  if (consumedRing) {
    consumedRing.style.strokeDasharray = `${consumedLength} ${circumference - consumedLength}`;
    consumedRing.style.strokeDashoffset = "0";
  }

  const burnedRing = $("calorieRingBurned");
  if (burnedRing) {
    burnedRing.style.strokeDasharray = `${burnedLength} ${burnedCircumference - burnedLength}`;
    burnedRing.style.strokeDashoffset = "0";
  }
}

function setMacroBar(barId, consumed, goal) {
  const bar = $(barId);
  if (!bar) return;

  const percentage = clamp((safeNumber(consumed) / Math.max(safeNumber(goal), 1)) * 100, 0, 100);
  bar.style.width = `${percentage}%`;
}

function renderMacroProgress(today, targets) {
  const proteinConsumed = Math.round(safeNumber(today.total_protein_g));
  const carbsConsumed = Math.round(safeNumber(today.total_carbs_g));
  const fatConsumed = Math.round(safeNumber(today.total_fat_g));
  const sugarConsumed = Math.round(safeNumber(today.total_sugar_g));
  const sodiumConsumed = Math.round(safeNumber(today.total_sodium_mg));

  const proteinGoal = Math.round(safeNumber(targets.proteinGoal));
  const carbsGoal = Math.round(safeNumber(targets.carbsGoal));
  const fatGoal = Math.round(safeNumber(targets.fatGoal));
  const sugarGoal = Math.round(safeNumber(targets.sugarGoal, 50));
  const sodiumGoal = Math.round(safeNumber(targets.sodiumGoal, 2300));

  setText("dashboardProteinText", `${proteinConsumed}g / ${proteinGoal}g`);
  setText("dashboardCarbsText", `${carbsConsumed}g / ${carbsGoal}g`);
  setText("dashboardFatText", `${fatConsumed}g / ${fatGoal}g`);
  setText("dashboardSugarText", `${sugarConsumed}g / ${sugarGoal}g`);
  setText("dashboardSodiumText", `${sodiumConsumed}mg / ${sodiumGoal}mg`);

  setMacroBar("dashboardProteinBar", proteinConsumed, proteinGoal);
  setMacroBar("dashboardCarbsBar", carbsConsumed, carbsGoal);
  setMacroBar("dashboardFatBar", fatConsumed, fatGoal);
  setMacroBar("dashboardSugarBar", sugarConsumed, sugarGoal);
  setMacroBar("dashboardSodiumBar", sodiumConsumed, sodiumGoal);
}

function renderHydration(waterConsumed, targets) {
  const override = readHydrationOverride();
  const consumed = safeNumber(override ?? waterConsumed);
  const goal = safeNumber(readHydrationGoalOverride() ?? targets.waterGoal, 3.5);
  const totalCups = Math.max(1, Math.ceil(goal / HYDRATION_CUP_LITERS));
  const filledCups = clamp(Math.round(consumed / HYDRATION_CUP_LITERS), 0, totalCups);

  const goalInput = $("dashboardWaterGoalInput");
  if (goalInput && document.activeElement !== goalInput) {
    goalInput.value = String(goal);
  }
  setText("dashboardWaterConsumed", consumed.toFixed(1));

  const cupsContainer = $("dashboardWaterCups");
  if (!cupsContainer) return;

  cupsContainer.innerHTML = Array.from({ length: totalCups }, (_, index) => {
    const filled = index < filledCups;
    return `
      <button
        type="button"
        class="hydration-cup-btn${filled ? " is-filled" : ""}"
        data-cup-index="${index}"
        aria-pressed="${filled ? "true" : "false"}"
        aria-label="Cup ${index + 1}"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M8 5.8H16L14.9 19H9.1L8 5.8Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
          <path d="M9.3 12C10.2 11.4 11.1 11.4 12 12C12.9 12.6 13.8 12.6 14.7 12V17.3H9.7L9.3 12Z" fill="currentColor" opacity="${filled ? "0.28" : "0.12"}" />
          <path d="M9.2 9H14.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
          <path d="M9.3 12C10.2 11.4 11.1 11.4 12 12C12.9 12.6 13.8 12.6 14.7 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>
    `;
  }).join("");

  cupsContainer.querySelectorAll(".hydration-cup-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.getAttribute("data-cup-index"));
      if (!Number.isFinite(index)) return;

      const nextFilled = index + 1 === filledCups ? index : index + 1;
      const nextConsumed = clamp(nextFilled * HYDRATION_CUP_LITERS, 0, goal);
      const reachedHydrationGoal = consumed < goal && nextConsumed >= goal;
      writeHydrationOverride(nextConsumed);
      renderHydration(nextConsumed, targets);
      renderDashboardInsight(window.__platewiseToday || {}, targets, nextConsumed);
      if (reachedHydrationGoal) showHydrationEasterEgg();
    });
  });
}

function setupHydrationHint() {
  const btn = $("hydrationHintBtn");
  const wrap = btn?.parentElement;
  if (!btn || !wrap) return;

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    wrap.classList.toggle("is-open");
  });

  document.addEventListener("click", () => {
    wrap.classList.remove("is-open");
  });
}

async function saveHydrationGoalToProfile(value) {
  if (!hydrationContext.userId) return;

  const firstAttempt = await supabase
    .from("user_profiles")
    .update({
      water_goal_l: value,
    })
    .eq("user_id", hydrationContext.userId);

  if (!firstAttempt.error) return;

  await supabase
    .from("user_profiles")
    .update({
      water_goal: value,
    })
    .eq("user_id", hydrationContext.userId);
}

function setupHydrationGoalInput(targets, initialWaterConsumed) {
  const input = $("dashboardWaterGoalInput");
  if (!input) return;

  const applyGoal = async () => {
    const nextGoal = clamp(safeNumber(input.value, targets.waterGoal), 0.5, 10);
    input.value = String(nextGoal);
    targets.waterGoal = nextGoal;
    writeHydrationGoalOverride(nextGoal);
    renderHydration(initialWaterConsumed, targets);
    renderDashboardInsight(window.__platewiseToday || {}, targets, safeNumber(readHydrationOverride() ?? initialWaterConsumed));
    await saveHydrationGoalToProfile(nextGoal).catch(() => null);
  };

  input.addEventListener("change", applyGoal);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      input.blur();
    }
  });
}

function getSodiumProgressMessage(today = {}, targets = {}) {
  const sodiumConsumed = safeNumber(today.total_sodium_mg);
  const sodiumGoal = Math.max(safeNumber(targets.sodiumGoal, 2300), 1);
  const sodiumProgress = sodiumConsumed / sodiumGoal;

  if (sodiumProgress >= 1) {
    return "Your meals have been a bit on the saltier side today, which might leave you feeling thirsty. Drinking plenty of water now is very important to help rinse away the extra salt.";
  }

  if (sodiumProgress >= 0.8) {
    return "Your salt intake is getting close to today's limit, so try to choose lower-salt options. Drinking an extra glass of water right now will help your body flush out the excess sodium.";
  }

  if (sodiumProgress >= 0.5) {
    return "Your sodium levels are climbing a little, so keeping your next meals light is a good idea. Pairing food with vegetables like spinach or celery can help your body stay balanced.";
  }

  return "Your meals have been wonderfully light today, keeping your salt intake beautifully controlled.";
}

function getHydrationProgressMessage(targets, waterConsumed) {
  const goal = Math.max(safeNumber(targets.waterGoal, 3.5), HYDRATION_CUP_LITERS);
  const hydrationProgress = safeNumber(waterConsumed) / goal;

  if (hydrationProgress >= 1) {
    return "Congratulations! You have reached your hydration goal for today. Your mindful choices and healthy habits are keeping your body beautifully nourished.";
  }

  if (hydrationProgress >= 0.8) {
    return "You are just a few sips away from your daily goal! If you feel too full for water, a light vegetable soup or a juicy pear is a fantastic way to finish the day.";
  }

  if (hydrationProgress >= 0.5) {
    return "You are already past the halfway mark, great job! A few slices of watermelon or an orange make a perfect afternoon snack to help keep you hydrated.";
  }

  if (hydrationProgress >= 0.2) {
    return "You are building a great habit today, so keep taking small sips. Try adding hydrating vegetables like cucumbers or tomatoes to your next meal for an extra boost.";
  }

  return "A fresh glass of water is a wonderful way to start your day. You can also grab a juicy apple or some berries to add a natural, vitamin-rich boost to your hydration.";
}

function getHydrationProgressInsight(today, targets, waterConsumed) {
  const hydrationMessage = getHydrationProgressMessage(targets, waterConsumed);
  const sodiumMessage = getSodiumProgressMessage(today, targets);
  return `${hydrationMessage} ${sodiumMessage}`;
}

function renderDashboardInsight(today, targets, waterConsumed) {
  setText("dashboardInsightText", getHydrationProgressInsight(today, targets, waterConsumed));
  return;

  const calorieLeft = safeNumber(targets.calorieGoal) - safeNumber(today.total_calories);
  const proteinLeft = safeNumber(targets.proteinGoal) - safeNumber(today.total_protein_g);
  const waterLeft = safeNumber(targets.waterGoal) - safeNumber(waterConsumed);

  let insight = "Nice progress today! Keep balancing your meals and hydration to stay on track.";

  if (waterLeft <= 0) {
    insight = "Congratulations! You reached your hydration goal today. Keep that steady rhythm going.";
  } else if (safeNumber(today.meals_count) === 0) {
    insight = "No meal report has been saved today. Upload or analyse a meal to start tracking your daily progress.";
  } else if (proteinLeft > 25) {
    insight = "Your protein intake is still below today’s target. Consider adding eggs, tofu, chicken, fish, Greek yogurt, or beans in your next meal.";
  } else if (waterLeft > 1) {
    insight = "Your hydration is still a bit low today. Try drinking one or two more glasses of water.";
  } else if (calorieLeft < 200) {
    insight = "You are close to your daily calorie target. Keep the next meal lighter and balanced.";
  } else if (today.overall_risk === "high") {
    insight = "One or more meals today may be high risk. Check sodium, sugar, and fat levels before your next meal.";
  }

  setText("dashboardInsightText", insight);
}

function renderTrend(days) {
  const chart = $("trendChart");
  const labels = $("trendLabels");
  if (!chart || !labels) return;

  const values = days.map((d) => safeNumber(d.total_calories));
  const max = Math.max(...values, 1);

  const width = 330;
  const height = 120;
  const pad = 16;
  const step = (width - pad * 2) / Math.max(days.length - 1, 1);

  const points = values.map((value, index) => {
    const x = pad + step * index;
    const y = height - pad - (value / max) * (height - pad * 2);
    return { x, y, value };
  });

  const line = points.map((p) => `${p.x},${p.y}`).join(" ");

  chart.innerHTML = `
    <svg width="100%" height="130" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#e3ddd0" stroke-width="2"/>
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#e3ddd0" stroke-width="2"/>
      <polyline points="${line}" fill="none" stroke="#3f7d58" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      ${points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="#f2b84b"></circle>`).join("")}
    </svg>
  `;

  labels.innerHTML = days
    .map((d) => `<span>${formatShortDate(d.summary_date)}</span>`)
    .join("");
}

function activityEstimate() {
  const met = safeNumber($("activityMetInput")?.value, 0);
  const durationMin = safeNumber($("activityDurationInput")?.value, 0);
  const weightKg = safeNumber(dashboardState.activityWeightKg, 55);
  const durationHours = durationMin / 60;
  return Math.max(0, Math.round(met * weightKg * durationHours));
}

function updateActivityEstimate() {
  const met = safeNumber($("activityMetInput")?.value, 0);
  const durationMin = safeNumber($("activityDurationInput")?.value, 0);
  const weightKg = safeNumber(dashboardState.activityWeightKg, 55);
  const durationHours = durationMin / 60;
  const calories = activityEstimate();

  setText("activityEstimatedCalories", calories.toLocaleString());
  setText("activityCalculationText", `Calculated: ${met.toFixed(1)} MET x ${weightKg.toFixed(1)} kg x ${durationHours.toFixed(2)} hr = ${calories.toLocaleString()} kcal`);
}

function activityRowsForIntensity(intensity) {
  return activityRows
    .filter((row) => row.intensity === intensity)
    .sort((a, b) => a.activity.localeCompare(b.activity));
}

function closeActivityTypeMenu() {
  $("activityTypeMenu")?.classList.add("hidden");
  $("activityTypeButton")?.setAttribute("aria-expanded", "false");
}

function updateActivityTypeButtonLabel() {
  const select = $("activityTypeSelect");
  const label = $("activityTypeButtonText");
  if (!select || !label) return;

  const option = select.options[select.selectedIndex];
  label.textContent = option?.textContent || "Select activity";
}

function renderActivityTypeMenu(rows) {
  const menu = $("activityTypeMenu");
  if (!menu) return;

  menu.innerHTML = rows
    .map((row, index) => {
      return `
        <button type="button" class="activity-type-option" data-activity-index="${index}">
          ${escapeHTML(row.activity)}
        </button>
      `;
    })
    .join("");

  menu.querySelectorAll(".activity-type-option").forEach((button) => {
    button.addEventListener("click", () => {
      const select = $("activityTypeSelect");
      const row = rows[Number(button.dataset.activityIndex)];
      if (select) select.value = button.dataset.activityIndex;
      if ($("activityMetInput") && row) $("activityMetInput").value = String(row.MET);
      updateActivityTypeButtonLabel();
      closeActivityTypeMenu();
      updateActivityEstimate();
    });
  });
}

function populateActivitySelect() {
  const select = $("activityTypeSelect");
  if (!select) return;

  const rows = activityRowsForIntensity(selectedActivityIntensity);
  select.innerHTML = rows
    .map((row, index) => {
      return `<option value="${index}">${row.activity}</option>`;
    })
    .join("");

  const briskIndex = rows.findIndex((row) => row.activity.toLowerCase().includes("brisk"));
  if (briskIndex >= 0) select.value = String(briskIndex);

  const selectedRow = rows[Number(select.value)] || rows[0];
  if (!isCustomActivitySelected() && $("activityMetInput") && selectedRow) {
    $("activityMetInput").value = String(selectedRow.MET);
  }

  renderActivityTypeMenu(rows);
  updateActivityTypeButtonLabel();
  closeActivityTypeMenu();
  updateActivityEstimate();
  updateCustomActivityState();
}

function isCustomActivitySelected() {
  return activityEntryMode === "custom";
}

function setSelectedActivityIntensity(intensity, options = {}) {
  selectedActivityIntensity = intensity || "Moderately active";

  document.querySelectorAll("#activityIntensityList button[data-intensity]").forEach((button) => {
    button.classList.toggle("active", button.dataset.intensity === selectedActivityIntensity);
  });

  if (options.populateList) {
    populateActivitySelect();
  }
}

function setActivityLastValues(text) {
  const el = $("activityLastValues");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

function hideActivityTemplateResults() {
  const box = $("activityTemplateResults");
  if (!box) return;
  box.innerHTML = "";
  box.classList.add("hidden");
}

async function searchUserActivityTemplates(query) {
  const q = String(query || "").trim();
  if (!activityContext.userId) return [];

  let request = supabase
    .from("user_custom_activities")
    .select("*")
    .eq("user_id", activityContext.userId)
    .order("updated_at", { ascending: false })
    .limit(6);

  if (q) {
    request = request.ilike("activity_name", `%${q}%`);
  }

  const { data, error } = await request;

  if (error) {
    console.warn("custom activity template search failed:", error);
    return [];
  }

  return data || [];
}

async function getLastActivityLogByName(activityName) {
  if (!activityContext.userId || !activityName) return null;

  const { data, error } = await supabase
    .from("exercise_logs")
    .select("duration_min, calories_burned, met_value, intensity, created_at, log_date")
    .eq("user_id", activityContext.userId)
    .ilike("activity_name", activityName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return data;
}

async function applyActivityTemplate(template) {
  if (!template) return;

  activityEntryMode = "custom";
  updateCustomActivityState();
  if ($("activityCustomNameInput")) $("activityCustomNameInput").value = template.activity_name || "";
  if ($("activityMetInput")) $("activityMetInput").value = String(safeNumber(template.met_value, 4));
  setSelectedActivityIntensity(template.intensity || selectedActivityIntensity);

  const lastLog = await getLastActivityLogByName(template.activity_name);
  if (lastLog?.duration_min && $("activityDurationInput")) {
    $("activityDurationInput").value = String(Math.round(safeNumber(lastLog.duration_min, 30)));
  }

  const noteParts = [
    `Last saved: ${safeNumber(template.met_value, 0).toFixed(1)} MET`,
    template.intensity || "",
  ].filter(Boolean);

  if (lastLog?.duration_min) {
    noteParts.push(`${Math.round(safeNumber(lastLog.duration_min))} min`);
  }

  if (lastLog?.calories_burned) {
    noteParts.push(`${Math.round(safeNumber(lastLog.calories_burned))} kcal`);
  }

  setActivityLastValues(noteParts.join(" · "));
  hideActivityTemplateResults();
  updateActivityEstimate();
}

async function renderActivityTemplateResults(query) {
  const box = $("activityTemplateResults");
  if (!box) return;

  const templates = await searchUserActivityTemplates(query);
  if (!templates.length) {
    hideActivityTemplateResults();
    return;
  }

  box.innerHTML = templates
    .map((item, index) => {
      return `
        <button type="button" class="activity-template-item" data-template-index="${index}">
          <strong>${escapeHTML(item.activity_name || "Custom activity")}</strong>
          <span>${safeNumber(item.met_value, 0).toFixed(1)} MET · ${escapeHTML(item.intensity || "Custom")}</span>
        </button>
      `;
    })
    .join("");
  box.classList.remove("hidden");

  box.querySelectorAll(".activity-template-item").forEach((button) => {
    button.addEventListener("click", () => {
      applyActivityTemplate(templates[Number(button.dataset.templateIndex)]);
    });
  });
}

async function saveCustomActivityTemplate(log) {
  if (!activityContext.userId || !log?.activity || log.activity === "Custom activity") return;

  const payload = {
    activity_name: log.activity,
    intensity: log.intensity,
    met_value: log.met,
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from("user_custom_activities")
    .select("id")
    .eq("user_id", activityContext.userId)
    .ilike("activity_name", log.activity)
    .limit(1)
    .maybeSingle();

  if (existing?.id) {
    const { error } = await supabase
      .from("user_custom_activities")
      .update(payload)
      .eq("id", existing.id);
    if (error) console.warn("custom activity template update failed:", error);
    return;
  }

  const { error } = await supabase
    .from("user_custom_activities")
    .insert({
      user_id: activityContext.userId,
      ...payload,
    });

  if (error) console.warn("custom activity template insert failed:", error);
}

function updateCustomActivityState() {
  const custom = isCustomActivitySelected();
  $("activityCustomWrap")?.classList.toggle("hidden", !custom);
  $("activityListWrap")?.classList.toggle("hidden", custom);
  $("activityCustomModeBtn")?.classList.toggle("active", custom);
  $("activityListModeBtn")?.classList.toggle("active", !custom);

  if (custom) {
    const metInput = $("activityMetInput");
    if (metInput && safeNumber(metInput.value) <= 0) metInput.value = "4.0";
    setTimeout(() => $("activityCustomNameInput")?.focus(), 0);
  } else {
    hideActivityTemplateResults();
    setActivityLastValues("");
  }
}

function setActivityModalOpen(open) {
  const backdrop = $("activityModalBackdrop");
  if (!backdrop) return;

  backdrop.classList.toggle("hidden", !open);
  backdrop.setAttribute("aria-hidden", String(!open));

  if (open) {
    setTimeout(() => (isCustomActivitySelected() ? $("activityCustomNameInput") : $("activityTypeSelect"))?.focus(), 0);
  }
}

async function saveActivityLog() {
  const select = $("activityTypeSelect");
  const rows = activityRowsForIntensity(selectedActivityIntensity);
  const custom = isCustomActivitySelected();
  const selectedRow = custom ? {} : rows[Number(select?.value)] || rows[0] || {};
  const met = safeNumber($("activityMetInput")?.value, selectedRow.MET);
  const duration = Math.max(1, Math.round(safeNumber($("activityDurationInput")?.value, 30)));
  const weightKg = safeNumber(dashboardState.activityWeightKg, 55);
  const burned = Math.round(met * weightKg * (duration / 60));
  const customName = String($("activityCustomNameInput")?.value || "").trim();

  const log = {
    activity: custom ? customName || "Custom activity" : selectedRow.activity || "Activity",
    intensity: selectedActivityIntensity,
    met,
    weight_kg: weightKg,
    duration_min: duration,
    calories_burned: burned,
    logged_at: new Date().toISOString(),
  };

  let savedRemotely = false;
  if (activityContext.userId) {
    const { error } = await supabase
      .from("exercise_logs")
      .insert({
        user_id: activityContext.userId,
        log_date: todayISO(),
        activity_name: log.activity,
        intensity: log.intensity,
        met_value: log.met,
        weight_kg: log.weight_kg,
        duration_min: log.duration_min,
        calories_burned: log.calories_burned,
      });

    savedRemotely = !error;
  }

  if (!savedRemotely) {
    const logs = readLocalActivityLogs();
    logs.push(log);
    writeLocalActivityLogs(logs);
  }

  if (custom) {
    await saveCustomActivityTemplate(log);
    setActivityLastValues(`Last saved: ${log.met.toFixed(1)} MET · ${log.intensity} · ${log.duration_min} min · ${log.calories_burned} kcal`);
  }

  dashboardState.burnedCalories += burned;
  if (dashboardState.today && dashboardState.targets) {
    renderDailyProgress(dashboardState.today, dashboardState.targets, dashboardState.burnedCalories);
  } else {
    setText("dashboardCaloriesBurned", dashboardState.burnedCalories.toLocaleString());
  }

  setActivityModalOpen(false);
}

async function setupActivityModal() {
  const addBtn = $("dashboardAddActivityBtn");
  if (!addBtn) return;

  await loadActivityRows();
  populateActivitySelect();

  addBtn.addEventListener("click", () => {
    populateActivitySelect();
    setActivityModalOpen(true);
  });

  $("activityListModeBtn")?.addEventListener("click", () => {
    activityEntryMode = "list";
    updateCustomActivityState();
    hideActivityTemplateResults();
    setActivityLastValues("");
    populateActivitySelect();
    updateActivityEstimate();
  });

  $("activityCustomModeBtn")?.addEventListener("click", () => {
    activityEntryMode = "custom";
    updateCustomActivityState();
    updateActivityEstimate();
  });

  $("activityModalCloseBtn")?.addEventListener("click", () => setActivityModalOpen(false));
  $("activityCancelBtn")?.addEventListener("click", () => setActivityModalOpen(false));
  $("activityModalBackdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) setActivityModalOpen(false);
  });

  document.querySelectorAll("#activityIntensityList button[data-intensity]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedActivityIntensity = button.dataset.intensity || "Moderately active";

      document.querySelectorAll("#activityIntensityList button[data-intensity]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });

      populateActivitySelect();
    });
  });

  $("activityTypeSelect")?.addEventListener("change", () => {
    const rows = activityRowsForIntensity(selectedActivityIntensity);
    const custom = isCustomActivitySelected();
    const row = custom ? null : rows[Number($("activityTypeSelect")?.value)] || rows[0];
    if ($("activityMetInput") && row) $("activityMetInput").value = String(row.MET);
    updateActivityTypeButtonLabel();
    updateCustomActivityState();
    updateActivityEstimate();
  });

  $("activityTypeButton")?.addEventListener("click", () => {
    const menu = $("activityTypeMenu");
    if (!menu) return;
    const willOpen = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !willOpen);
    $("activityTypeButton")?.setAttribute("aria-expanded", String(willOpen));
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest("#activityListWrap")) {
      closeActivityTypeMenu();
    }
  });

  $("activityMetInput")?.addEventListener("input", updateActivityEstimate);
  $("activityCustomNameInput")?.addEventListener("input", () => {
    updateActivityEstimate();
    setActivityLastValues("");
    clearTimeout(activityTemplateSearchTimer);
    const query = $("activityCustomNameInput")?.value || "";
    activityTemplateSearchTimer = setTimeout(() => {
      renderActivityTemplateResults(query).catch((error) => {
        console.warn("activity template render failed:", error);
      });
    }, 180);
  });
  $("activityCustomNameInput")?.addEventListener("focus", () => {
    const query = $("activityCustomNameInput")?.value || "";
    renderActivityTemplateResults(query).catch(() => null);
  });
  $("activityDurationInput")?.addEventListener("input", updateActivityEstimate);
  $("activityMetInfoBtn")?.addEventListener("click", () => {
    $("activityMetTip")?.classList.toggle("hidden");
  });
  $("activitySaveBtn")?.addEventListener("click", () => {
    saveActivityLog().catch((error) => {
      console.error("Failed to save activity:", error);
      setActivityModalOpen(false);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("activityModalBackdrop")?.classList.contains("hidden")) {
      setActivityModalOpen(false);
    }
  });
}

function setupActions() {
  $("dashboardProfileBtn")?.addEventListener("click", () => {
    window.location.href = "profile.html";
  });

  $("dashboardLogMealBtn")?.addEventListener("click", () => {
    window.location.href = "chat.html";
  });

  $("dashboardFloatingLogBtn")?.addEventListener("click", () => {
    window.location.href = "chat.html";
  });
}

async function boot() {
  const session = await getCurrentSession().catch(() => null);
  if (redirectIfNoSession(session)) return;

  setupActions();
  setupHydrationHint();

  const appUser = await getAppUser();
  hydrationContext = { userId: String(appUser.id || ""), date: todayISO() };
  activityContext = { userId: String(appUser.id || ""), date: todayISO() };
  await setupActivityModal();
  const profile = await getProfile(appUser.id);
  const reports = await getReports(appUser.id);
  const summaries = await getDailySummaries(appUser.id);

  const days = buildSevenDays(summaries, reports);
  const today = days[days.length - 1];
  const latestReport = reports[reports.length - 1];

  const targets = calculateUserTargets(profile);
  const activityWeightKg = safeNumber(profile?.weight_kg, 55);
  targets.waterGoal = safeNumber(readHydrationGoalOverride() ?? targets.waterGoal, 3.5);
  const waterConsumed = await getTodayWater(appUser.id);
  const displayedWater = safeNumber(readHydrationOverride() ?? waterConsumed);
  const burnedCalories = await getTodayBurnedCalories(appUser.id);
  dashboardState = { today, targets, burnedCalories, activityWeightKg };
  window.__platewiseToday = today;

  /**
   * Keep your old dashboard IDs.
   * These will only update if the elements still exist.
   */
  const displayName = profile?.name || appUser.display_name || "User";
  setText("dashboardGreeting", displayName);
  setText("dashboardAvatarInitial", displayName.trim().charAt(0).toUpperCase() || "P");
  setText("todayMealsCount", today.meals_count);
  setText("todayCalories", Math.round(today.total_calories || 0));

  const todayRisk = $("todayRisk");
  if (todayRisk) {
    const risk = normalizeRisk(today.overall_risk);
    todayRisk.textContent = riskLabel(risk);
    todayRisk.className = todayRisk.classList.contains("dashboard-risk-pill")
      ? `dashboard-risk-pill ${risk}`
      : `stat-number ${riskClass(risk)}`;
  }

  if ($("nutritionRiskText")) {
    const risk = normalizeRisk(today.overall_risk);
    $("nutritionRiskText").textContent = risk.charAt(0).toUpperCase() + risk.slice(1);
    $("nutritionRiskText").className = risk;
  }

  setText("nutritionCalories", Math.round(today.total_calories || 0));
  setText("nutritionSodium", `${Math.round(today.total_sodium_mg || 0)} mg`);
  setText("nutritionSugar", `${Math.round(today.total_sugar_g || 0)} g`);
  setText("nutritionCarbs", `${Math.round(today.total_carbs_g || 0)} g`);
  setText("nutritionFat", `${Math.round(today.total_fat_g || 0)} g`);
  setText("nutritionProtein", `${Math.round(today.total_protein_g || 0)} g`);
  setText("nutritionFiber", `${Math.round(today.total_fiber_g || 0)} g`);

  if ($("todaySummaryText")) {
    if (today.generated_summary) {
      $("todaySummaryText").textContent = today.generated_summary;
    } else if (today.meals_count > 0) {
      $("todaySummaryText").textContent = `You saved ${today.meals_count} meal report(s) today.`;
    }
  }

  if (latestReport) {
    setText("lastMealTitle", latestReport.title || "Saved report");

    const lastMealRisk = $("lastMealRisk");
    if (lastMealRisk) {
      lastMealRisk.textContent = latestReport.risk_level || "-";
      lastMealRisk.className = riskClass(latestReport.risk_level);
    }

    setText("lastMealSuggestion", latestReport.recommendation || "No recommendation available.");
  }

  /**
   * New mobile dashboard UI.
   */
  renderDailyProgress(today, targets, burnedCalories);
  renderMacroProgress(today, targets);
  setupHydrationGoalInput(targets, displayedWater);
  renderHydration(displayedWater, targets);
  renderDashboardInsight(today, targets, displayedWater);

  /**
   * Keep your old trend chart.
   */
  renderTrend(days);
}

boot();
