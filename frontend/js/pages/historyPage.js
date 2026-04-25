import { supabase } from "../lib/supabaseClient.js";
import { getCurrentSession } from "../lib/auth.js";
import { redirectIfNoSession } from "../lib/router.js";
import { $, escapeHtml, formatDateTime } from "../lib/utils.js";

let allRecords = [];

function riskClass(risk) {
  if (risk === "high") return "high";
  if (risk === "medium") return "medium";
  if (risk === "low") return "low";
  return "";
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function dateISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function normalizeText(value) {
  return String(value || "").toLowerCase().trim();
}

function toISODate(value) {
  if (!value) return "";

  const raw = String(value).trim();

  // Already ISO: 2026-04-25
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }

  // Browser display or old text: 25/04/2026
  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const day = slashMatch[1].padStart(2, "0");
    const month = slashMatch[2].padStart(2, "0");
    const year = slashMatch[3];
    return `${year}-${month}-${day}`;
  }

  // Try normal Date fallback
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }

  return "";
}

function getRecordDate(record) {
  return toISODate(record.report_date || record.created_at);
}

function recordSearchText(record) {
  const items = record.report_items || [];
  const summaries = record.report_summaries || [];

  const itemText = items
    .map((item) => [
      item.food_name,
      item.notes,
      item.portion_unit,
      item.calories,
      item.sodium_mg,
      item.sugar_g,
      item.carbs_g,
      item.fat_g,
      item.protein_g,
    ].join(" "))
    .join(" ");

  const summaryText = summaries
    .map((summary) => JSON.stringify(summary.summary_json || {}))
    .join(" ");

  return normalizeText(`
    ${record.title || ""}
    ${record.report_date || ""}
    ${record.created_at || ""}
    ${record.risk_level || ""}
    ${record.final_summary || ""}
    ${record.recommendation || ""}
    ${record.total_calories || ""}
    ${record.total_sodium_mg || ""}
    ${record.total_sugar_g || ""}
    ${record.total_carbs_g || ""}
    ${record.total_fat_g || ""}
    ${record.total_protein_g || ""}
    ${itemText}
    ${summaryText}
  `);
}

function setActiveQuickFilter(activeId) {
  ["filterAllBtn", "filterTodayBtn", "filter7DaysBtn"].forEach((id) => {
    const btn = $(id);
    if (!btn) return;
    btn.classList.toggle("active", id === activeId);
  });
}

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

async function getReports(appUserId) {
  const { data, error } = await supabase
    .from("reports")
    .select(`
      *,
      report_items(*),
      report_summaries(*)
    `)
    .eq("user_id", appUserId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

function getFilters() {
  return {
    keyword: normalizeText($("historySearch")?.value || ""),
    from: toISODate($("historyDateFrom")?.value || ""),
    to: toISODate($("historyDateTo")?.value || ""),
  };
}

function filterRecords(records) {
  const { keyword, from, to } = getFilters();

  return records.filter((record) => {
    const recordDate = getRecordDate(record);

    if (from && recordDate && recordDate < from) return false;
    if (to && recordDate && recordDate > to) return false;

    if (keyword) {
      const combined = recordSearchText(record);
      if (!combined.includes(keyword)) return false;
    }

    return true;
  });
}

function renderResultCount(records) {
  const resultCount = $("historyResultCount");
  if (!resultCount) return;

  const total = allRecords.length;
  const shown = records.length;

  if (!total) {
    resultCount.textContent = "0 reports";
    return;
  }

  resultCount.textContent = `${shown} / ${total}`;
}

function renderRecords(records) {
  const container = $("historyContainer");
  if (!container) return;

  renderResultCount(records);

  if (!records.length) {
    container.innerHTML = `
      <div class="card empty-state-card">
        <h3>No reports found</h3>
        <p class="muted">Try another keyword or date range.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = records.map((record) => {
    const items = record.report_items || [];
    const itemText = items.length
      ? items.slice(0, 6).map((i) => i.food_name).filter(Boolean).join(", ")
      : "No item details";

    const recordDate = getRecordDate(record);
    const dateLabel = recordDate
      ? `${recordDate} · ${formatDateTime(record.created_at)}`
      : formatDateTime(record.created_at);

    const calories = Math.round(Number(record.total_calories || 0));
    const sodium = Math.round(Number(record.total_sodium_mg || 0));
    const sugar = Math.round(Number(record.total_sugar_g || 0));
    const carbs = Math.round(Number(record.total_carbs_g || 0));

    return `
      <div class="card report-card-compact">
        <div class="report-title-line">
          <div>
            <h3>${escapeHtml(record.title || "Meal Report")}</h3>
            <div class="report-date-line">${escapeHtml(dateLabel)}</div>
          </div>
          <span class="risk-pill ${riskClass(record.risk_level)}">
            ${escapeHtml(record.risk_level || "unknown")}
          </span>
        </div>

        ${record.image_url ? `
          <img class="report-image" src="${escapeHtml(record.image_url)}" alt="Meal image" />
        ` : ""}

        <p class="history-foods"><strong>Foods:</strong> ${escapeHtml(itemText)}</p>

        <div class="history-nutrition-grid">
          <div class="nutrition-item">
            <strong>${calories}</strong>
            <span>Calories</span>
          </div>
          <div class="nutrition-item">
            <strong>${sodium} mg</strong>
            <span>Sodium</span>
          </div>
          <div class="nutrition-item">
            <strong>${sugar} g</strong>
            <span>Sugar</span>
          </div>
          <div class="nutrition-item">
            <strong>${carbs} g</strong>
            <span>Carbs</span>
          </div>
        </div>

        <p class="history-summary-text">
          <strong>Summary:</strong> ${escapeHtml(record.final_summary || "-")}
        </p>

        <p class="history-summary-text">
          <strong>Recommendation:</strong> ${escapeHtml(record.recommendation || "-")}
        </p>
      </div>
    `;
  }).join("");
}

function applyFilters() {
  const filtered = filterRecords(allRecords);
  renderRecords(filtered);
}

function clearFilters() {
  if ($("historySearch")) $("historySearch").value = "";
  if ($("historyDateFrom")) $("historyDateFrom").value = "";
  if ($("historyDateTo")) $("historyDateTo").value = "";

  setActiveQuickFilter("filterAllBtn");
  renderRecords(allRecords);
}

function setTodayFilter() {
  const today = todayISO();

  $("historyDateFrom").value = today;
  $("historyDateTo").value = today;

  setActiveQuickFilter("filterTodayBtn");
  applyFilters();
}

function setLast7DaysFilter() {
  $("historyDateFrom").value = dateISO(-6);
  $("historyDateTo").value = todayISO();

  setActiveQuickFilter("filter7DaysBtn");
  applyFilters();
}

function setAllFilter() {
  $("historyDateFrom").value = "";
  $("historyDateTo").value = "";

  setActiveQuickFilter("filterAllBtn");
  applyFilters();
}

function setupFilters() {
  $("applyHistoryFiltersBtn")?.addEventListener("click", applyFilters);
  $("clearHistoryFiltersBtn")?.addEventListener("click", clearFilters);

  $("filterAllBtn")?.addEventListener("click", setAllFilter);
  $("filterTodayBtn")?.addEventListener("click", setTodayFilter);
  $("filter7DaysBtn")?.addEventListener("click", setLast7DaysFilter);

  $("historySearch")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      applyFilters();
    }
  });

  // 这里保留自动筛选，让用户不用每次都点 Search
  $("historySearch")?.addEventListener("input", applyFilters);
  $("historyDateFrom")?.addEventListener("change", () => {
    setActiveQuickFilter("");
    applyFilters();
  });
  $("historyDateTo")?.addEventListener("change", () => {
    setActiveQuickFilter("");
    applyFilters();
  });
}

async function boot() {
  const session = await getCurrentSession().catch(() => null);
  if (redirectIfNoSession(session)) return;

  try {
    const appUser = await getAppUser();
    allRecords = await getReports(appUser.id);

    renderRecords(allRecords);
    setupFilters();
  } catch (error) {
    console.error(error);

    const container = $("historyContainer");
    if (container) {
      container.innerHTML = `
        <div class="card empty-state-card">
          <h3>Could not load history</h3>
          <p class="muted">${escapeHtml(error.message || "Unknown error")}</p>
        </div>
      `;
    }

    const resultCount = $("historyResultCount");
    if (resultCount) {
      resultCount.textContent = "Failed";
    }
  }
}

boot();