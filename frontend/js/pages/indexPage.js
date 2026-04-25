import {
  signInWithEmail,
  signUpWithEmail,
  getCurrentSession,
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
  await ensureAppUser();

  const profileData = await getUserProfile().catch(() => null);
  const profile = profileData?.profile || null;

  if (!isProfileComplete(profile)) {
    window.location.href = "onboarding.html";
    return;
  }

  window.location.href = "dashboard.html";
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
    await signInWithEmail(email, password);
    await goToNextPageAfterLogin();
  } catch (error) {
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
    await signUpWithEmail(email, password);
    showToast("Sign-up successful. Please confirm your email, then login.");
  } catch (error) {
    showToast(error.message || "Sign-up failed.", true);
  }
}

async function boot() {
  const session = await getCurrentSession().catch(() => null);

  if (session?.user) {
    await goToNextPageAfterLogin();
    return;
  }

  $("loginForm")?.addEventListener("submit", handleLogin);
  $("signupBtn")?.addEventListener("click", handleSignup);
}

boot();