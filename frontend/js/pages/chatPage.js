import { supabase } from "../lib/supabaseClient.js";

const IS_LOCAL =
  location.hostname === "127.0.0.1" ||
  location.hostname === "localhost";

const NLP_BASE = IS_LOCAL
  ? "http://127.0.0.1:9000"
  : "https://YOUR_RENDER_NLP_URL.onrender.com";

const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const imageUpload = document.getElementById("imageUpload");
const cameraCapture = document.getElementById("cameraCapture");
const sendBtn = document.getElementById("sendBtn");
const analyzeBtn = document.getElementById("analyzeBtn");
const reportBtn = document.getElementById("reportBtn");

let currentImageFile = null;
let currentMeal = null;
let currentProfile = null;
let lastAnalysis = null;

function addMessage(text, sender = "ai") {
  const msg = document.createElement("div");
  msg.className = `message ${sender === "user" ? "user-message" : "ai-message"}`;
  msg.innerText = text || "No response.";
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
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

function handleImage(file) {
  if (!file) return;
  currentImageFile = file;
  addImageMessage(file);
  addSystem("Image selected. Tap Analyze to process it.");
}

imageUpload.addEventListener("change", () => {
  handleImage(imageUpload.files[0]);
});

cameraCapture.addEventListener("change", () => {
  handleImage(cameraCapture.files[0]);
});

analyzeBtn.addEventListener("click", async () => {
  if (!currentImageFile) {
    addMessage("Please upload or take a photo first.", "ai");
    return;
  }

  try {
    addMessage("Analyzing image...", "ai");

    const { profile } = await getCurrentUserAndProfile();
    currentProfile = profile;

    const formData = new FormData();
    formData.append("image", currentImageFile);
    formData.append("profile", JSON.stringify(profile));

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

    addMessage(data.reply || data.insight?.final_summary || "Image analyzed.", "ai");
  } catch (err) {
    console.error(err);
    addMessage(`Image analysis failed: ${err.message}`, "ai");
  }
});

sendBtn.addEventListener("click", async () => {
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

    const res = await fetch(`${NLP_BASE}/chat-turn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_text: text,
        meal: currentMeal,
        profile: effectiveProfile,
      }),
    });

    const data = await parseResponse(res);

    if (!data.ok) {
      addMessage(data.reply || "Chat failed.", "ai");
      return;
    }

    currentMeal = data.meal || currentMeal;
    currentProfile = data.profile || effectiveProfile;
    lastAnalysis = data;

    const profileUpdates = data.profile_updates || {};
    if (Object.keys(profileUpdates).length > 0) {
      const { error } = await supabase
        .from("user_profiles")
        .update(profileUpdates)
        .eq("user_id", appUser.id);

      if (error) {
        console.error("profile update failed:", error);
        addMessage("Profile update failed, but the chat response is still shown.", "ai");
      }
    }

    addMessage(data.reply || "Done.", "ai");
  } catch (err) {
    console.error(err);
    addMessage(`Chat failed: ${err.message}`, "ai");
  }
});

async function uploadImageToStorage(appUser, file) {
  if (!file) return null;

  const ext = file.name.split(".").pop() || "jpg";
  const path = `${appUser.id}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from("meal-images")
    .upload(path, file, {
      cacheControl: "3600",
      upsert: false,
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

reportBtn.addEventListener("click", async () => {
  if (!currentMeal) {
    addMessage("Please analyze a meal before generating a report.", "ai");
    return;
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

    const imageUrl = await uploadImageToStorage(appUser, currentImageFile);
    const insight = reportData.insight || {};
    const totals = reportData.report_totals || {};

    const { data: report, error: reportError } = await supabase
      .from("reports")
      .insert({
        user_id: appUser.id,
        title: reportData.title || "Meal Analysis",
        source_type: currentImageFile ? "image" : "chat",
        image_url: imageUrl,
        risk_level: insight.risk_level || null,
        final_summary: insight.final_summary || reportData.reply || null,
        recommendation: insight.recommendation || null,
        total_calories: totals.total_calories || null,
        total_protein_g: totals.total_protein_g || null,
        total_fat_g: totals.total_fat_g || null,
        total_carbs_g: totals.total_carbs_g || null,
        total_sodium_mg: totals.total_sodium_mg || null,
        total_sugar_g: totals.total_sugar_g || null,
        total_fiber_g: totals.total_fiber_g || null,
      })
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
        console.error("report_items insert error:", itemError);
      }
    }

    await supabase.from("report_summaries").insert({
      report_id: report.id,
      summary_json: reportData,
      analysis_method: "original_nlp_pipeline",
    });

    addMessage("✅ Report saved successfully.", "ai");
    addMessage(reportData.reply || insight.final_summary || "Report generated.", "ai");
  } catch (err) {
    console.error(err);
    addMessage(`Report failed: ${err.message}`, "ai");
  }
});