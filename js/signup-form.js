// Waitlist signup form (the "Get Started" section) — validation, honeypot,
// and the Firestore write live here, kept separate from main.js's Three.js
// scene since they're unrelated concerns.

import { submitSignup } from "./firebase.js";

const EMAIL_MAX_LENGTH = 100; // matches the Firestore rules cap
const DISCORD_MAX_LENGTH = 50; // matches the Firestore rules cap and the input's maxlength
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function initSignupForm() {
  const form = document.getElementById("signup-form");
  if (!form) return;

  const emailInput = document.getElementById("signup-email");
  const discordInput = document.getElementById("signup-discord");
  const honeypotInput = document.getElementById("signup-website");
  const submitButton = document.getElementById("signup-submit");
  const submitLabel = submitButton.querySelector(".signup-form__submit-label");
  const messageEl = document.getElementById("signup-message");

  function setMessage(text, kind) {
    messageEl.textContent = text;
    messageEl.classList.remove("is-error", "is-success");
    if (kind) messageEl.classList.add(kind === "error" ? "is-error" : "is-success");
  }

  function setLoading(isLoading) {
    submitButton.disabled = isLoading;
    submitButton.classList.toggle("is-loading", isLoading);
    submitLabel.textContent = isLoading ? "Sending…" : "Join the waitlist";
  }

  function showSuccess() {
    setLoading(false);
    form.classList.add("is-done"); // hides the submit button; message takes its place
    setMessage("You're on the list ✦", "success");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    // Honeypot: real users never see or reach this field (off-screen,
    // tabindex -1). Anything in it on submit means a bot filled every
    // field it could find — pretend success without touching Firestore.
    if (honeypotInput.value.trim() !== "") {
      showSuccess();
      return;
    }

    const email = emailInput.value.trim();
    const discord = discordInput.value.trim();

    if (!EMAIL_PATTERN.test(email) || email.length > EMAIL_MAX_LENGTH) {
      setMessage("Please enter a valid email address.", "error");
      return;
    }
    if (!discord || discord.length > DISCORD_MAX_LENGTH) {
      setMessage("Please enter your Discord username.", "error");
      return;
    }

    setLoading(true);
    setMessage("", null);

    try {
      await submitSignup(email, discord);
      showSuccess();
    } catch (error) {
      console.error("Signup submission failed:", error);
      setLoading(false);
      setMessage("Something went wrong — try again.", "error");
    }
  });
}

initSignupForm();
