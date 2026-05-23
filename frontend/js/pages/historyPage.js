import { supabase } from "../lib/supabaseClient.js";
import { getCurrentSession } from "../lib/auth.js";
import { redirectIfNoSession } from "../lib/router.js";
import { $, showToast } from "../lib/utils.js";

const DETAIL_PAGE = "meal-detail.html";
const SELECTED_REPORT_STORAGE_KEY = "platewise_selected_report";

let reports = [];
let activeRange = "all";
let filtersOpen = false;
let historySearchFrame = null;

async function getAppUser() {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("No auth user.");
  }

  const { data: appUser, error } = await supabase
    .from("users")
    .select("*")
    .eq("supabase_auth_id", user.id)
    .single();

  if (error) throw error;
  return appUser;
}

function setupDatePickers() {
  const dateConfigs = [
    {
      boxSelector: ".meal-history-calendar-box:first-child",
      inputId: "historyStartDate",
    },
    {
      boxSelector: ".meal-history-calendar-box:last-child",
      inputId: "historyEndDate",
    },
  ];

  dateConfigs.forEach(({ boxSelector, inputId }) => {
    const box = document.querySelector(boxSelector);
    const input = $(inputId);

    if (!box || !input) return;

    box.addEventListener("click", () => {
      if (typeof input.showPicker === "function") {
        input.showPicker();
      } else {
        input.focus();
        input.click();
      }
    });
  });
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toDate(value) {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateInputValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getReportId(report, fallbackIndex = 0) {
  return (
    report?.id ||
    report?.report_id ||
    report?.meal_report_id ||
    report?.uuid ||
    `local-${fallbackIndex}`
  );
}

function titleOf(report) {
  if (!report) return "Meal Report";

  return (
    report.meal_name ||
    report.title ||
    report.food_name ||
    report.name ||
    report.recipe_name ||
    report.dish_name ||
    report.report_title ||
    report.final_title ||
    report.detected_food ||
    getFirstItemName(report) ||
    "Meal Report"
  );
}

function getFirstItemName(report) {
  const items = Array.isArray(report?.report_items) ? report.report_items : [];
  const first = items[0];

  return (
    first?.food_name ||
    first?.name ||
    first?.item_name ||
    first?.title ||
    ""
  );
}

function dateOf(report) {
  return (
    report?.created_at ||
    report?.createdAt ||
    report?.updated_at ||
    report?.date ||
    report?.meal_date ||
    report?.report_date
  );
}

function imageOf(report) {
  const items = Array.isArray(report?.report_items) ? report.report_items : [];
  const firstItem = items[0] || {};

  return (
    report?.image_url ||
    report?.photo_url ||
    report?.meal_image_url ||
    report?.image ||
    report?.imageUrl ||
    firstItem?.image_url ||
    firstItem?.photo_url ||
    firstItem?.image ||
    ""
  );
}

function nutritionOf(report) {
  const nutrition = report?.nutrition || report?.nutrition_facts || {};
  const summary = Array.isArray(report?.report_summaries)
    ? report.report_summaries[0]?.summary_json || {}
    : {};

  return {
    calories: safeNumber(
      report?.total_calories ??
        report?.calories ??
        report?.kcal ??
        nutrition?.calories ??
        nutrition?.kcal ??
        summary?.calories ??
        summary?.total_calories
    ),
    protein: safeNumber(
      report?.total_protein_g ??
        report?.protein_g ??
        report?.protein ??
        nutrition?.protein ??
        nutrition?.protein_g ??
        summary?.protein ??
        summary?.protein_g ??
        summary?.total_protein_g
    ),
    carbs: safeNumber(
      report?.total_carbs_g ??
        report?.carbs_g ??
        report?.carbs ??
        report?.carbohydrates ??
        nutrition?.carbs ??
        nutrition?.carbs_g ??
        summary?.carbs ??
        summary?.carbs_g ??
        summary?.total_carbs_g
    ),
    fat: safeNumber(
      report?.total_fat_g ??
        report?.fat_g ??
        report?.fat ??
        nutrition?.fat ??
        nutrition?.fat_g ??
        summary?.fat ??
        summary?.fat_g ??
        summary?.total_fat_g
    ),
  };
}

function formatDateWithTime(value) {
  const date = toDate(value);
  if (!date) return "Unknown date";

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function prettyCalendarDate(value, fallback = "Select date") {
  if (!value) return fallback;

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return fallback;

  return date.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\u2026]+/g, " ")
    .replace(/[_/.,;:!?()[\]{}'"`~|\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenSearchValues(value) {
  if (value == null) return "";

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(flattenSearchValues).join(" ");
  }

  if (typeof value === "object") {
    return Object.values(value).map(flattenSearchValues).join(" ");
  }

  return "";
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function ingredientSearchTextFromMeal(meal) {
  const ingredients = Array.isArray(meal?.ingredients) ? meal.ingredients : [];
  return ingredients
    .map((ingredient) =>
      [
        ingredient?.name,
        ingredient?.food_name,
        ingredient?.item_name,
        ingredient?.title,
      ].join(" ")
    )
    .join(" ");
}

function getSearchableText(report) {
  const itemsText = asArray(report?.report_items)
    .map((item) =>
      [
        item?.food_name,
        item?.name,
        item?.item_name,
        item?.title,
        item?.ingredients,
      ].join(" ")
    )
    .join(" ");

  const summaryIngredientsText = asArray(report?.report_summaries)
    .map((summary) => ingredientSearchTextFromMeal(summary?.summary_json?.meal))
    .join(" ");

  return normalizeSearchText(
    [
      titleOf(report),
      getFirstItemName(report),
      report?.meal_name,
      report?.title,
      report?.food_name,
      report?.name,
      report?.recipe_name,
      report?.dish_name,
      report?.ingredients,
      report?.detected_items,
      flattenSearchValues(report?.nutrition),
      itemsText,
      summaryIngredientsText,
    ].join(" ")
  );
}

function searchMatches(report, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  const searchableText = getSearchableText(report);
  return normalizedQuery
    .split(" ")
    .filter(Boolean)
    .every((term) => searchableText.includes(term));
}

function rangeMatches(report) {
  if (activeRange === "all") return true;

  const date = toDate(dateOf(report));
  if (!date) return false;

  const now = new Date();

  if (activeRange === "today") {
    return date.toDateString() === now.toDateString();
  }

  if (activeRange === "7days") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);

    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    return date >= start && date <= end;
  }

  return true;
}

function dateInputsMatch(report) {
  const startValue = $("historyStartDate")?.value;
  const endValue = $("historyEndDate")?.value;

  if (!startValue && !endValue) return true;

  const date = toDate(dateOf(report));
  if (!date) return !startValue && !endValue;

  if (startValue) {
    const start = new Date(`${startValue}T00:00:00`);
    if (date < start) return false;
  }

  if (endValue) {
    const end = new Date(`${endValue}T23:59:59`);
    if (date > end) return false;
  }

  return true;
}

function filteredReports() {
  const query = $("historySearchInput")?.value.trim() || "";
  const normalizedQuery = normalizeSearchText(query);
  const hasDateFilter = Boolean($("historyStartDate")?.value || $("historyEndDate")?.value);

  return reports.filter((report) => {
    const matchesQuery = normalizedQuery ? searchMatches(report, normalizedQuery) : true;
    const matchesDate = hasDateFilter ? dateInputsMatch(report) : true;
    return matchesQuery && matchesDate;
  });
}

function scheduleRenderHistory() {
  if (historySearchFrame) {
    cancelAnimationFrame(historySearchFrame);
  }

  historySearchFrame = requestAnimationFrame(() => {
    historySearchFrame = null;
    renderHistory();
  });
}

function updateCalendarLabels() {
  const startValue = $("historyStartDate")?.value;
  const endValue = $("historyEndDate")?.value;

  if ($("historyStartTop")) {
    $("historyStartTop").textContent = "Start";
  }

  if ($("historyStartBottom")) {
    $("historyStartBottom").textContent = prettyCalendarDate(startValue, "Choose start");
  }

  if ($("historyEndTop")) {
    $("historyEndTop").textContent = "End";
  }

  if ($("historyEndBottom")) {
    $("historyEndBottom").textContent = prettyCalendarDate(endValue, "Choose end");
  }
}

function setDefaultDateRange() {
  if ($("historyStartDate")) $("historyStartDate").value = "";
  if ($("historyEndDate")) $("historyEndDate").value = "";

  activeRange = "all";

  document.querySelectorAll(".meal-history-range-switch button[data-range]").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === "all");
  });

  updateCalendarLabels();
}

function clearDateInputs() {
  if ($("historyStartDate")) $("historyStartDate").value = "";
  if ($("historyEndDate")) $("historyEndDate").value = "";
  updateCalendarLabels();
}

function applyRange(range) {
  activeRange = range || "all";

  const now = new Date();
  const start = new Date();

  if (activeRange === "all") {
    clearDateInputs();
  }

  if (activeRange === "today") {
    const today = toDateInputValue(now);

    if ($("historyStartDate")) $("historyStartDate").value = today;
    if ($("historyEndDate")) $("historyEndDate").value = today;
  }

  if (activeRange === "7days") {
    start.setDate(now.getDate() - 6);

    if ($("historyStartDate")) $("historyStartDate").value = toDateInputValue(start);
    if ($("historyEndDate")) $("historyEndDate").value = toDateInputValue(now);
  }

  document.querySelectorAll(".meal-history-range-switch button[data-range]").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === activeRange);
  });

  updateCalendarLabels();
  renderHistory();
}

function setFilterMode(open) {
  filtersOpen = Boolean(open);

  $("historyFilterPanel")?.classList.toggle("hidden", !filtersOpen);
  $("historyBackBtn")?.classList.toggle("visible", filtersOpen);
  $("historyMain")?.classList.toggle("filter-mode", filtersOpen);

  const squareBtn = $("filterSquareBtn");
  if (squareBtn) {
    squareBtn.classList.toggle("active", filtersOpen);
    squareBtn.setAttribute("aria-expanded", String(filtersOpen));
  }
}

function toggleFilterMode() {
  setFilterMode(!filtersOpen);
}

function makeThumb(report, index) {
  const image = imageOf(report);

  if (image) {
    return `<img src="${escapeHTML(image)}" alt="${escapeHTML(titleOf(report))}" />`;
  }

  return `
    <div class="meal-history-thumb-placeholder variant-${(index % 5) + 1}">
      <span></span><span></span><span></span><span></span>
    </div>
  `;
}

function renderMealCard(report, index) {
  const nutrition = nutritionOf(report);
  const title = escapeHTML(titleOf(report));
  const date = escapeHTML(formatDateWithTime(dateOf(report)));
  const reportId = escapeHTML(getReportId(report, index));
  const searchText = escapeHTML(getSearchableText(report));

  return `
    <article class="meal-history-card" data-report-id="${reportId}" data-search-text="${searchText}" role="button" tabindex="0" aria-label="Open ${title} details">
      <div class="meal-history-thumb">
        ${makeThumb(report, index)}
      </div>

      <div class="meal-history-card-main">
        <div class="meal-history-card-top">
          <h2>${title}</h2>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M9 6L15 12L9 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>

        <p>${date}</p>

        <div class="meal-history-macros">
          <span><em>CALS</em><strong>${Math.round(nutrition.calories)}</strong></span>
          <span><em>PROT</em><strong>${Math.round(nutrition.protein)}g</strong></span>
          <span><em>CARB</em><strong>${Math.round(nutrition.carbs)}g</strong></span>
          <span><em>FAT</em><strong>${Math.round(nutrition.fat)}g</strong></span>
        </div>
      </div>
    </article>
  `;
}

function openReportDetails(reportId) {
  const report = reports.find((item, index) => String(getReportId(item, index)) === String(reportId));

  if (!report) {
    showToast("Could not open this meal report.", true);
    return;
  }

  localStorage.setItem(SELECTED_REPORT_STORAGE_KEY, JSON.stringify(report));

  const realId = report.id || report.report_id || report.meal_report_id;
  const query = realId ? `?id=${encodeURIComponent(realId)}` : "";

  window.location.href = `${DETAIL_PAGE}${query}`;
}

function bindMealCardEvents() {
  document.querySelectorAll(".meal-history-card[data-report-id]").forEach((card) => {
    card.addEventListener("click", () => {
      openReportDetails(card.dataset.reportId);
    });

    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openReportDetails(card.dataset.reportId);
      }
    });
  });
}

function applyVisibleSearchFilter() {
  const list = $("historyMealList");
  const empty = $("historyEmptyState");
  const info = $("historyInfoCards");
  const query = normalizeSearchText($("historySearchInput")?.value || "");
  const terms = query.split(" ").filter(Boolean);
  const cards = Array.from(document.querySelectorAll(".meal-history-card"));

  if (!list || cards.length === 0) return false;

  let visibleCount = 0;

  cards.forEach((card) => {
    const haystack = card.dataset.searchText || "";
    const matches = terms.length === 0 || terms.every((term) => haystack.includes(term));

    card.classList.toggle("hidden", !matches);
    if (matches) visibleCount += 1;
  });

  list.classList.toggle("hidden", visibleCount === 0);
  empty?.classList.toggle("hidden", visibleCount > 0);

  if (visibleCount === 0 && $("historyEmptyText")) {
    $("historyEmptyText").textContent = "We couldn't find any meal logs for this search. Try a different keyword.";
  }

  if (visibleCount > 0) {
    info?.classList.add("hidden");
  }

  return true;
}

function renderHistory() {
  const list = $("historyMealList");
  const empty = $("historyEmptyState");
  const info = $("historyInfoCards");

  if (!list || !empty) return;

  const visibleReports = filteredReports();

  const hasFilters = Boolean(
    $("historySearchInput")?.value.trim() ||
      $("historyStartDate")?.value ||
      $("historyEndDate")?.value
  );

  if (visibleReports.length) {
    list.innerHTML = visibleReports.map(renderMealCard).join("");
    bindMealCardEvents();

    list.classList.remove("hidden");
    empty.classList.add("hidden");
    info?.classList.add("hidden");
    return;
  }

  list.innerHTML = "";
  list.classList.add("hidden");
  empty.classList.remove("hidden");

  if ($("historyEmptyText")) {
    $("historyEmptyText").textContent = hasFilters
      ? "We couldn't find any meal logs for this selection. Try adjusting your date range or using different keywords."
      : "Your meal history is currently empty. Start logging your daily nutrition to see detailed health insights here.";
  }

  if (filtersOpen || hasFilters) {
    info?.classList.add("hidden");
  } else {
    info?.classList.remove("hidden");
  }
}

function setupEvents() {
  $("filterSquareBtn")?.addEventListener("click", toggleFilterMode);
  $("historyBackBtn")?.addEventListener("click", () => setFilterMode(false));

  $("historySearchInput")?.addEventListener("input", () => {
    applyVisibleSearchFilter();
    scheduleRenderHistory();
  });
  $("historySearchInput")?.addEventListener("keyup", () => {
    applyVisibleSearchFilter();
    scheduleRenderHistory();
  });
  $("historySearchInput")?.addEventListener("search", () => {
    applyVisibleSearchFilter();
    scheduleRenderHistory();
  });
  $("historySearchInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      renderHistory();
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target?.id === "historySearchInput") {
      applyVisibleSearchFilter();
      scheduleRenderHistory();
    }
  });

  document.addEventListener("keyup", (event) => {
    if (event.target?.id === "historySearchInput") {
      applyVisibleSearchFilter();
      scheduleRenderHistory();
    }
  });

  document.addEventListener("search", (event) => {
    if (event.target?.id === "historySearchInput") {
      applyVisibleSearchFilter();
      scheduleRenderHistory();
    }
  });

  $("historyStartDate")?.addEventListener("change", () => {
    activeRange = "custom";

    document.querySelectorAll(".meal-history-range-switch button[data-range]").forEach((button) => {
      button.classList.remove("active");
    });

    updateCalendarLabels();
    renderHistory();
  });

  $("historyEndDate")?.addEventListener("change", () => {
    activeRange = "custom";

    document.querySelectorAll(".meal-history-range-switch button[data-range]").forEach((button) => {
      button.classList.remove("active");
    });

    updateCalendarLabels();
    renderHistory();
  });

  document.querySelectorAll(".meal-history-range-switch button[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      applyRange(button.dataset.range || "all");
    });
  });

  $("historyClearBtn")?.addEventListener("click", () => {
    if ($("historySearchInput")) $("historySearchInput").value = "";

    activeRange = "all";

    document.querySelectorAll(".meal-history-range-switch button[data-range]").forEach((button) => {
      button.classList.toggle("active", button.dataset.range === "all");
    });

    clearDateInputs();
    renderHistory();
  });

  $("historySearchBtn")?.addEventListener("click", () => {
    renderHistory();
    setFilterMode(false);
  });

  $("historyFirstMealBtn")?.addEventListener("click", () => {
    window.location.href = "chat.html";
  });
}

async function loadReports() {
  try {
    const appUser = await getAppUser();

    const { data, error } = await supabase
      .from("reports")
      .select(`
        *,
        report_items(*),
        report_summaries(*)
      `)
      .eq("user_id", appUser.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    reports = Array.isArray(data) ? data : [];

    reports.sort((a, b) => {
      const dateA = toDate(dateOf(a))?.getTime() || 0;
      const dateB = toDate(dateOf(b))?.getTime() || 0;
      return dateB - dateA;
    });

    renderHistory();
  } catch (error) {
    console.error("Failed to load meal history:", error);
    showToast(error.message || "Failed to load meal history.", true);
    reports = [];
    renderHistory();
  }
}

async function boot() {
  const session = await getCurrentSession().catch(() => null);
  if (redirectIfNoSession(session)) return;

  setupEvents();
  setupDatePickers();
  setDefaultDateRange();

  await loadReports();
}

boot();
