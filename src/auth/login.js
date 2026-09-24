import { clearSession, saveSession, savedSession, unlock } from "./credentials.js";

export function signIn() {
  const saved = savedSession();
  const screen = document.getElementById("loginScreen");
  if (saved) {
    screen.remove();
    return Promise.resolve(saved);
  }
  const form = document.getElementById("loginForm");
  const error = document.getElementById("loginError");
  const button = form.querySelector("button");
  screen.hidden = false;
  document.getElementById("loginUser").focus();

  // Some embedded browsers do not submit on Enter without an explicit handler.
  for (const input of form.querySelectorAll("input")) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !button.disabled) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
  }

  return new Promise((resolve) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true;
      button.disabled = true;
      button.textContent = "Checking…";
      try {
        const session = await unlock(document.getElementById("loginUser").value.trim(), document.getElementById("loginPassword").value);
        saveSession(session);
        screen.classList.add("done");
        window.setTimeout(() => {
          screen.remove();
          resolve(session);
        }, 250);
      } catch {
        error.hidden = false;
        form.classList.remove("shake");
        void form.offsetWidth;
        form.classList.add("shake");
        document.getElementById("loginPassword").select();
        button.disabled = false;
        button.textContent = "Sign in";
      }
    });
  });
}

export function bindSignOut() {
  document.getElementById("signOut").addEventListener("click", () => {
    clearSession();
    window.location.reload();
  });
}
