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

function setupPasswordToggle() {
  const passwordInput = $("loginPassword");
  const toggleBtn = $("togglePassword");

  if (!passwordInput || !toggleBtn) return;

  const eyeOpenIcon = `
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M2.75 12C3.9 8.84 7.32 5.75 12 5.75C16.68 5.75 20.1 8.84 21.25 12C20.1 15.16 16.68 18.25 12 18.25C7.32 18.25 3.9 15.16 2.75 12Z" stroke="currentColor" stroke-width="1.9" />
      <circle cx="12" cy="12" r="2.7" stroke="currentColor" stroke-width="1.9" />
    </svg>
  `;

  const eyeOffIcon = `
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M3 3L21 21" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />
      <path d="M10.6 10.6C10.23 10.96 10 11.46 10 12C10 13.1 10.9 14 12 14C12.54 14 13.04 13.77 13.4 13.4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />
      <path d="M9.9 5.08C10.57 4.86 11.27 4.75 12 4.75C16 4.75 19.1 8.2 20.25 10.06C20.57 10.58 20.73 10.84 20.82 11.23C20.89 11.53 20.89 12.47 20.82 12.77C20.73 13.16 20.57 13.42 20.25 13.94C19.8 14.65 18.99 15.78 17.83 16.82M6.23 6.23C4.97 7.1 4.03 8.26 3.75 8.71C3.43 9.22 3.27 9.48 3.18 9.88C3.11 10.17 3.11 11.12 3.18 11.41C3.27 11.81 3.43 12.07 3.75 12.58C4.91 14.44 8 17.9 12 17.9C13.61 17.9 15.05 17.33 16.25 16.59" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />
    </svg>
  `;

  toggleBtn.addEventListener("click", () => {
    const isHidden = passwordInput.type === "password";

    passwordInput.type = isHidden ? "text" : "password";
    toggleBtn.innerHTML = isHidden ? eyeOpenIcon : eyeOffIcon;
    toggleBtn.setAttribute(
      "aria-label",
      isHidden ? "Hide password" : "Show password"
    );
  });
}

async function boot() {
  $("loginForm")?.addEventListener("submit", handleLogin);
  $("signupBtn")?.addEventListener("click", handleSignup);
  setupPasswordToggle();

  const session = await getCurrentSession().catch(() => null);
  if (!session?.user) return;

  try {
    await getCurrentUser();
    await goToNextPageAfterLogin();
  } catch (error) {
    console.warn("Invalid stored session. Signing out.", error);
    await signOutUser().catch(() => {});
  }
}

boot();
