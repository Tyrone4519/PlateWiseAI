import { getCurrentSession } from "../lib/auth.js";
import { redirectIfNoSession } from "../lib/router.js";
import { $, showToast } from "../lib/utils.js";

const SELECTED_REPORT_STORAGE_KEY = "platewise_selected_report";

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function formatDateWithTime(value) {
  const date = toDate(value);
  if (!date) return "Unknown date";

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getFirstItemName(report) {
  const items = Array.isArray(report?.report_items) ? report.report_items : [];
  const first = items[0] || {};

  return (
    first.food_name ||
    first.name ||
    first.item_name ||
    first.title ||
    ""
  );
}

function titleOf(report) {
  return (
    report?.meal_name ||
    report?.title ||
    report?.food_name ||
    report?.name ||
    report?.recipe_name ||
    report?.dish_name ||
    report?.report_title ||
    report?.final_title ||
    report?.detected_food ||
    getFirstItemName(report) ||
    "Meal Report"
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

function readSelectedReport() {
  try {
    return JSON.parse(localStorage.getItem(SELECTED_REPORT_STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function stringifyDetail(value) {
  if (value === null || value === undefined || value === "") return "";

  if (Array.isArray(value)) {
    return value
      .map((item) => stringifyDetail(item))
      .filter(Boolean)
      .join(", ");
  }

  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([, itemValue]) => itemValue !== null && itemValue !== undefined && itemValue !== "")
      .map(([key, itemValue]) => `${formatKey(key)}: ${stringifyDetail(itemValue)}`)
      .join("\n");
  }

  return String(value);
}

function formatKey(key) {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getSummaryText(report) {
  const summary = Array.isArray(report?.report_summaries)
    ? report.report_summaries[0]?.summary_json || {}
    : {};

  return (
    report?.final_summary ||
    report?.summary ||
    report?.analysis ||
    report?.recommendation ||
    summary?.summary ||
    summary?.analysis ||
    summary?.recommendation ||
    summary?.health_insight ||
    "Nutrition analysis and meal details."
  );
}

function getItemName(item, index) {
  return (
    item?.food_name ||
    item?.name ||
    item?.item_name ||
    item?.title ||
    `Item ${index + 1}`
  );
}

function getItemWeightText(item) {
  const grams = safeNumber(
    item?.estimated_portion ??
      item?.estimated_grams ??
      item?.grams ??
      item?.weight_g
  );

  if (grams <= 0) return "";
  return `${Math.round(grams)}g`;
}

function getItemNutrition(item) {
  const nutrition = item?.nutrition || item?.nutrition_facts || {};

  return {
    calories: safeNumber(item?.calories ?? item?.kcal ?? nutrition?.calories ?? nutrition?.kcal),
    protein: safeNumber(item?.protein_g ?? item?.protein ?? nutrition?.protein_g ?? nutrition?.protein),
    carbs: safeNumber(item?.carbs_g ?? item?.carbs ?? item?.carbohydrates ?? nutrition?.carbs_g ?? nutrition?.carbs),
    fat: safeNumber(item?.fat_g ?? item?.fat ?? nutrition?.fat_g ?? nutrition?.fat),
  };
}

function sanitizeItemDescription(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const normalized = text.toLowerCase().replace(/\s+/g, "_");
  const hiddenTags = new Set([
    "default",
    "vegetable",
    "fruit",
    "meat",
    "seafood",
    "grain",
    "dairy",
    "sauce",
    "sauce_condiment",
    "condiment",
    "seasoning",
  ]);

  if (hiddenTags.has(normalized)) return "";

  // Hide taxonomy-like machine labels such as "sauce_condiment", "food_group_xxx".
  if (/^[a-z]+(?:_[a-z]+)+$/.test(normalized)) return "";

  return text;
}

function renderImage(report) {
  const container = $("mealDetailImage");
  if (!container) return;

  const image = imageOf(report);
  const title = titleOf(report);

  if (image) {
    container.innerHTML = `<img src="${escapeHTML(image)}" alt="${escapeHTML(title)}" />`;
    return;
  }

  container.innerHTML = `
    <div class="meal-detail-image-placeholder">
      <span></span>
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;
}

function renderItems(report) {
  const container = $("mealDetailItems");
  if (!container) return;

  const items = Array.isArray(report?.report_items) ? report.report_items : [];

  if (!items.length) {
    container.innerHTML = `
      <div class="meal-detail-no-data">
        No individual food items were saved for this report.
      </div>
    `;
    return;
  }

  container.innerHTML = items
    .map((item, index) => {
      const nutrition = getItemNutrition(item);
      const weightText = getItemWeightText(item);

      return `
        <article class="meal-detail-item">
          <div class="meal-detail-item-index">${index + 1}</div>

          <div class="meal-detail-item-main">
            <h4>
              <span>${escapeHTML(getItemName(item, index))}</span>
              ${weightText ? `<em>${escapeHTML(weightText)}</em>` : ""}
            </h4>

            <div class="meal-detail-item-macros">
              <span>${Math.round(nutrition.calories)} cal</span>
              <span>${Math.round(nutrition.protein)}g protein</span>
              <span>${Math.round(nutrition.carbs)}g carbs</span>
              <span>${Math.round(nutrition.fat)}g fat</span>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderAnalysis(report) {
  const container = $("mealDetailAnalysis");
  if (!container) return;

  const summaryText = getSummaryText(report);

  const summary = Array.isArray(report?.report_summaries)
    ? report.report_summaries[0]?.summary_json || {}
    : {};

  const detailRows = [
    ["Risk Level", report?.risk_level || summary?.risk_level],
    ["Recommendation", report?.recommendation || summary?.recommendation],
    ["Ingredients", report?.ingredients || report?.detected_items || summary?.ingredients],
    ["Notes", report?.notes || summary?.notes],
  ].filter(([, value]) => stringifyDetail(value));

  let html = "";

  if (summaryText) {
    html += `<p class="meal-detail-summary-text">${escapeHTML(summaryText)}</p>`;
  }

  if (detailRows.length) {
    html += `
      <div class="meal-detail-detail-list">
        ${detailRows
          .map(([label, value]) => {
            return `
              <div>
                <span>${escapeHTML(label)}</span>
                <strong>${escapeHTML(stringifyDetail(value))}</strong>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  const rawDetails = {
    ...summary,
  };

  delete rawDetails.summary;
  delete rawDetails.analysis;
  delete rawDetails.recommendation;
  delete rawDetails.risk_level;
  delete rawDetails.calories;
  delete rawDetails.total_calories;
  delete rawDetails.protein;
  delete rawDetails.protein_g;
  delete rawDetails.total_protein_g;
  delete rawDetails.carbs;
  delete rawDetails.carbs_g;
  delete rawDetails.total_carbs_g;
  delete rawDetails.fat;
  delete rawDetails.fat_g;
  delete rawDetails.total_fat_g;

  const extraDetails = Object.entries(rawDetails).filter(([, value]) => stringifyDetail(value));

  if (extraDetails.length) {
    html += `
      <div class="meal-detail-extra-grid">
        ${extraDetails
          .map(([key, value]) => {
            return `
              <div>
                <span>${escapeHTML(formatKey(key))}</span>
                <strong>${escapeHTML(stringifyDetail(value))}</strong>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  if (!html) {
    html = `
      <div class="meal-detail-no-data">
        No additional AI analysis was saved for this report.
      </div>
    `;
  }

  container.innerHTML = html;
}

function renderReport(report) {
  const nutrition = nutritionOf(report);

  if ($("mealDetailTitle")) $("mealDetailTitle").textContent = titleOf(report);
  if ($("mealDetailDate")) $("mealDetailDate").textContent = formatDateWithTime(dateOf(report));
  if ($("mealDetailSummary")) $("mealDetailSummary").textContent = getSummaryText(report);

  if ($("mealDetailCalories")) $("mealDetailCalories").textContent = String(Math.round(nutrition.calories));
  if ($("mealDetailProtein")) $("mealDetailProtein").textContent = `${Math.round(nutrition.protein)}g`;
  if ($("mealDetailCarbs")) $("mealDetailCarbs").textContent = `${Math.round(nutrition.carbs)}g`;
  if ($("mealDetailFat")) $("mealDetailFat").textContent = `${Math.round(nutrition.fat)}g`;

  renderImage(report);
  renderItems(report);
  renderAnalysis(report);
}

function showEmptyState() {
  $("mealDetailContent")?.classList.add("hidden");
  $("mealDetailEmpty")?.classList.remove("hidden");
}

function goBackToHistory() {
  window.location.href = "history.html";
}

async function boot() {
  const session = await getCurrentSession().catch(() => null);
  if (redirectIfNoSession(session)) return;

  $("mealDetailBackBtn")?.addEventListener("click", goBackToHistory);
  $("mealDetailEmptyBackBtn")?.addEventListener("click", goBackToHistory);

  const report = readSelectedReport();

  if (!report) {
    showEmptyState();
    showToast("No meal report selected.", true);
    return;
  }

  renderReport(report);
}

boot();
