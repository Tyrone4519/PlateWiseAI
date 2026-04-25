import { supabase } from './supabaseClient.js';
import { getCurrentUser } from './auth.js';

export async function ensureAppUser(displayName = null) {
  const authUser = await getCurrentUser();
  if (!authUser) throw new Error('User not logged in.');

  const payload = {
    supabase_auth_id: authUser.id,
    email: authUser.email,
    display_name: displayName || authUser.user_metadata?.display_name || null,
  };

  const { data, error } = await supabase
    .from('users')
    .upsert(payload, { onConflict: 'supabase_auth_id' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getAppUser() {
  const authUser = await getCurrentUser();
  if (!authUser) return null;

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('supabase_auth_id', authUser.id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function upsertUserProfile(profile) {
  const appUser = await ensureAppUser(profile.name || null);

  const payload = {
    user_id: appUser.id,
    name: profile.name || null,
    age: profile.age ? Number(profile.age) : null,
    gender: profile.gender || null,
    height_cm: profile.height ? Number(profile.height) : null,
    weight_kg: profile.weight ? Number(profile.weight) : null,
    goal: profile.goal || null,
    restrictions: profile.restrictions || null,
    health_notes: profile.healthNotes || null,
  };

  const { data, error } = await supabase
    .from('user_profiles')
    .upsert(payload, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getUserProfile() {
  const appUser = await getAppUser();
  if (!appUser) return null;

  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', appUser.id)
    .maybeSingle();

  if (error) throw error;
  return { appUser, profile: data };
}

export async function createDemoReport({ title, finalSummary, recommendation, riskLevel, sourceType = 'mixed', imageUrl = null }) {
  const appUser = await getAppUser();
  if (!appUser) throw new Error('No app user found.');

  const totals = {
    total_calories: 650,
    total_protein_g: 28,
    total_fat_g: 24,
    total_carbs_g: 72,
    total_sodium_mg: riskLevel === 'high' ? 1900 : riskLevel === 'medium' ? 1200 : 700,
    total_sugar_g: 14,
    total_fiber_g: 8,
  };

  const { data: report, error: reportError } = await supabase
    .from('reports')
    .insert({
      user_id: appUser.id,
      title,
      report_date: new Date().toISOString().slice(0, 10),
      source_type: sourceType,
      image_url: imageUrl,
      status: 'final',
      risk_level: riskLevel,
      final_summary: finalSummary,
      recommendation: recommendation,
      ...totals,
    })
    .select()
    .single();

  if (reportError) throw reportError;

  const items = [
    {
      report_id: report.id,
      food_name: 'Rice / staple base',
      estimated_portion: 1,
      portion_unit: 'serving',
      calories: 280,
      protein_g: 4,
      fat_g: 1,
      carbs_g: 60,
      sodium_mg: 120,
      sugar_g: 1,
      fiber_g: 2,
      confidence_score: 78,
      notes: 'Auto-generated demo item',
    },
    {
      report_id: report.id,
      food_name: 'Protein / main dish',
      estimated_portion: 1,
      portion_unit: 'serving',
      calories: 310,
      protein_g: 22,
      fat_g: 20,
      carbs_g: 10,
      sodium_mg: 820,
      sugar_g: 6,
      fiber_g: 1,
      confidence_score: 74,
      notes: 'Auto-generated demo item',
    },
  ];

  const { error: itemsError } = await supabase.from('report_items').insert(items);
  if (itemsError) throw itemsError;

  const { error: summaryError } = await supabase.from('report_summaries').upsert({
    report_id: report.id,
    analysis_method: 'frontend_demo_analysis',
    summary_json: {
      generated_at: new Date().toISOString(),
      risk_level: riskLevel,
      title,
      recommendation,
      notes: 'This record was generated from the frontend demo workflow.',
    },
  }, { onConflict: 'report_id' });
  if (summaryError) throw summaryError;

  await upsertDailySummary(appUser.id);

  return report;
}

export async function upsertDailySummary(userId) {
  const today = new Date().toISOString().slice(0, 10);

  const { data: reports, error: reportsError } = await supabase
    .from('reports')
    .select('id, risk_level, total_calories, total_sodium_mg, total_sugar_g, report_date, created_at')
    .eq('user_id', userId)
    .eq('report_date', today)
    .order('created_at', { ascending: false });

  if (reportsError) throw reportsError;

  const mealsCount = reports.length;
  const totalCalories = reports.reduce((sum, r) => sum + Number(r.total_calories || 0), 0);
  const totalSodium = reports.reduce((sum, r) => sum + Number(r.total_sodium_mg || 0), 0);
  const totalSugar = reports.reduce((sum, r) => sum + Number(r.total_sugar_g || 0), 0);

  let overallRisk = 'low';
  if (reports.some(r => r.risk_level === 'high')) overallRisk = 'high';
  else if (reports.some(r => r.risk_level === 'medium')) overallRisk = 'medium';

  const generatedSummary = mealsCount === 0
    ? 'No saved reports today.'
    : `Today you saved ${mealsCount} report(s). Estimated sodium intake is ${Math.round(totalSodium)} mg.`;

  const { error } = await supabase
    .from('daily_summaries')
    .upsert({
      user_id: userId,
      summary_date: today,
      meals_count: mealsCount,
      total_calories: totalCalories,
      total_sodium_mg: totalSodium,
      total_sugar_g: totalSugar,
      overall_risk: overallRisk,
      generated_summary: generatedSummary,
    }, { onConflict: 'user_id,summary_date' });

  if (error) throw error;
}

export async function getTodaySummary() {
  const appUser = await getAppUser();
  if (!appUser) return null;

  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('daily_summaries')
    .select('*')
    .eq('user_id', appUser.id)
    .eq('summary_date', today)
    .maybeSingle();

  if (error) throw error;
  return { appUser, summary: data };
}

export async function getLatestReport() {
  const appUser = await getAppUser();
  if (!appUser) return null;

  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('user_id', appUser.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getReportHistory() {
  const appUser = await getAppUser();
  if (!appUser) return [];

  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('user_id', appUser.id)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}
