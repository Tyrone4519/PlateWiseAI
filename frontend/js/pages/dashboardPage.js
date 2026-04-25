import { supabase } from "../lib/supabaseClient.js";
import { getCurrentSession } from "../lib/auth.js";
import { redirectIfNoSession } from "../lib/router.js";
import { $ } from "../lib/utils.js";

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

async function getAppUser() {
  const { data: { user } } = await supabase.auth.getUser();
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

  if (error) throw error;
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
        overall_risk: "low",
      };
    }

    map[date].meals_count += 1;
    map[date].total_calories += Number(r.total_calories || 0);
    map[date].total_sodium_mg += Number(r.total_sodium_mg || 0);
    map[date].total_sugar_g += Number(r.total_sugar_g || 0);
    map[date].total_carbs_g += Number(r.total_carbs_g || 0);
    map[date].total_fat_g += Number(r.total_fat_g || 0);
    map[date].total_protein_g += Number(r.total_protein_g || 0);

    if (r.risk_level === "high") map[date].overall_risk = "high";
    else if (r.risk_level === "medium" && map[date].overall_risk !== "high") {
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
      meals_count: Number(summary?.meals_count ?? fallback?.meals_count ?? 0),
      total_calories: Number(summary?.total_calories ?? fallback?.total_calories ?? 0),
      total_sodium_mg: Number(summary?.total_sodium_mg ?? fallback?.total_sodium_mg ?? 0),
      total_sugar_g: Number(summary?.total_sugar_g ?? fallback?.total_sugar_g ?? 0),
      total_carbs_g: Number(fallback?.total_carbs_g ?? 0),
      total_fat_g: Number(fallback?.total_fat_g ?? 0),
      total_protein_g: Number(fallback?.total_protein_g ?? 0),
      overall_risk: summary?.overall_risk ?? fallback?.overall_risk ?? "low",
      generated_summary: summary?.generated_summary ?? "",
    });
  }

  return days;
}

function renderTrend(days) {
  const chart = $("trendChart");
  const labels = $("trendLabels");
  if (!chart || !labels) return;

  const values = days.map((d) => Number(d.total_calories || 0));
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

async function boot() {
  const session = await getCurrentSession().catch(() => null);
  if (redirectIfNoSession(session)) return;

  const appUser = await getAppUser();
  const profile = await getProfile(appUser.id);
  const reports = await getReports(appUser.id);
  const summaries = await getDailySummaries(appUser.id);
  const days = buildSevenDays(summaries, reports);
  const today = days[days.length - 1];
  const latestReport = reports[reports.length - 1];

  $("dashboardGreeting").textContent = profile?.name || appUser.display_name || "User";
  $("todayMealsCount").textContent = today.meals_count;
  $("todayCalories").textContent = Math.round(today.total_calories || 0);
  $("todayRisk").textContent = today.overall_risk.charAt(0).toUpperCase() + today.overall_risk.slice(1);
  $("todayRisk").className = `stat-number ${riskClass(today.overall_risk)}`;

  $("nutritionCalories").textContent = Math.round(today.total_calories || 0);
  $("nutritionSodium").textContent = `${Math.round(today.total_sodium_mg || 0)} mg`;
  $("nutritionSugar").textContent = `${Math.round(today.total_sugar_g || 0)} g`;
  $("nutritionCarbs").textContent = `${Math.round(today.total_carbs_g || 0)} g`;
  $("nutritionFat").textContent = `${Math.round(today.total_fat_g || 0)} g`;
  $("nutritionProtein").textContent = `${Math.round(today.total_protein_g || 0)} g`;

  if (today.generated_summary) {
    $("todaySummaryText").textContent = today.generated_summary;
  } else if (today.meals_count > 0) {
    $("todaySummaryText").textContent = `You saved ${today.meals_count} meal report(s) today.`;
  }

  if (latestReport) {
    $("lastMealTitle").textContent = latestReport.title || "Saved report";
    $("lastMealRisk").textContent = latestReport.risk_level || "-";
    $("lastMealRisk").className = riskClass(latestReport.risk_level);
    $("lastMealSuggestion").textContent = latestReport.recommendation || "No recommendation available.";
  }

  renderTrend(days);
}

boot();