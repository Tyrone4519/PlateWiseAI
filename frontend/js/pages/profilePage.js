import { supabase } from "../lib/supabaseClient.js";
import { getCurrentSession, signOutUser } from "../lib/auth.js";
import { redirectIfNoSession } from "../lib/router.js";
import { $, showToast } from "../lib/utils.js";

let currentAppUser = null;
let currentProfile = null;

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
  const { data, error } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("user_id", appUserId)
    .single();

  if (error) throw error;
  return data;
}

function renderProfile(profile) {
  $("profileName").textContent = profile.name || "User";
  $("profileGoal").textContent = profile.goal || "-";
  $("profileAge").textContent = profile.age || "-";
  $("profileGender").textContent = profile.gender || "-";
  $("profileHeight").textContent = profile.height_cm || "-";
  $("profileWeight").textContent = profile.weight_kg || "-";
  $("profileRestrictions").textContent = profile.restrictions || "-";
  $("profileHealthNotes").textContent = profile.health_notes || "-";

  const avatar = $("avatarCircle");
  if (profile.avatar_url) {
    avatar.innerHTML = `<img src="${profile.avatar_url}" alt="Avatar" />`;
  } else {
    avatar.textContent = (profile.name || "P").charAt(0).toUpperCase();
  }
}

async function uploadAvatar(file) {
  if (!file || !currentAppUser) return;

  const ext = file.name.split(".").pop() || "jpg";
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${currentAppUser.id}/${Date.now()}.${safeExt}`;

  const { error: uploadError } = await supabase.storage
    .from("profile-avatars")
    .upload(path, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || "image/jpeg",
    });

  if (uploadError) throw uploadError;

  const { data } = supabase.storage
    .from("profile-avatars")
    .getPublicUrl(path);

  const avatarUrl = data?.publicUrl;
  if (!avatarUrl) throw new Error("Could not get avatar URL.");

  const { error: updateError } = await supabase
    .from("user_profiles")
    .update({ avatar_url: avatarUrl })
    .eq("user_id", currentAppUser.id);

  if (updateError) throw updateError;

  currentProfile.avatar_url = avatarUrl;
  renderProfile(currentProfile);
}

async function handleLogout() {
  try {
    await signOutUser();
    window.location.href = "index.html";
  } catch (error) {
    showToast(error.message || "Logout failed.", true);
  }
}

async function boot() {
  const session = await getCurrentSession().catch(() => null);
  if (redirectIfNoSession(session)) return;

  currentAppUser = await getAppUser();
  currentProfile = await getProfile(currentAppUser.id);

  renderProfile(currentProfile);

  $("avatarUpload")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      await uploadAvatar(file);
      showToast("Profile photo updated.");
    } catch (error) {
      showToast(error.message || "Failed to update photo.", true);
    }
  });

  $("logoutBtn")?.addEventListener("click", handleLogout);
}

boot();