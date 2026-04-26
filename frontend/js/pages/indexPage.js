import {
  signInWithEmail,
  signUpWithEmail,
  getCurrentSession,
  getCurrentUser,
  signOutUser,
} from "../lib/auth.js";

import {
  ensureAppUser,
  getUserProfile,
} from "../lib/data.js";

import {
  showToast,
  $,
} from "../lib/utils.js";

function isProfileComplete(profile) {
  if (!profile) return false;

  return Boolean(
    profile.name &&
    profile.age &&
    profile.gender &&
    profile.height_cm &&
    profile.weight_kg &&
    profile.goal
  );
}

async function goToNextPageAfterLogin() {
  try {
    await ensureAppUser();

    const profileData = await getUserProfile().catch(() => null);
    const profile = profileData?.profile || null;

    if (!isProfileComplete(profile)) {
      window.location.href = "onboarding.html";
      return;
    }

    window.location.href = "dashboard.html";
  } catch (error) {
    console.error("goToNextPageAfterLogin failed:", error);

    await signOutUser().catch(() => {});
    showToast("Login session expired. Please login again.", true);
  }
}

async function handleLogin(event) {
  event.preventDefault();

  const email = $("loginEmail")?.value.trim();
  const password = $("loginPassword")?.value.trim();

  if (!email || !password) {
    showToast("Please enter both email and password.", true);
    return;
  }

  try {
    await signOutUser().catch(() => {});

    await signInWithEmail(email, password);
    await goToNextPageAfterLogin();
  } catch (error) {
    console.error("login error:", error);
    showToast(error.message || "Login failed.", true);
  }
}

async function handleSignup() {
  const email = $("loginEmail")?.value.trim();
  const password = $("loginPassword")?.value.trim();

  if (!email || !password) {
    showToast("Please enter email and password first.", true);
    return;
  }

  if (password.length < 6) {
    showToast("Password should be at least 6 characters.", true);
    return;
  }

  try {
    await signOutUser().catch(() => {});

    await signUpWithEmail(email, password);
    showToast("Sign-up successful. Please confirm your email, then login.");
  } catch (error) {
    console.error("signup error:", error);
    showToast(error.message || "Sign-up failed.", true);
  }
}

async function boot() {
  $("loginForm")?.addEventListener("submit", handleLogin);
  $("signupBtn")?.addEventListener("click", handleSignup);

  const session = await getCurrentSession().catch(() => null);

  if (!session?.user) {
    return;
  }

  try {
    await getCurrentUser();
    await goToNextPageAfterLogin();
  } catch (error) {
    console.warn("Invalid stored session. Signing out.", error);
    await signOutUser().catch(() => {});
  }
}

boot();