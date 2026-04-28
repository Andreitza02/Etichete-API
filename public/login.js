const loginForm = document.querySelector("#loginForm");
const loginError = document.querySelector("#loginError");
const forgotPasswordButton = document.querySelector("#forgotPassword");
const resetModal = document.querySelector("#resetModal");
const cancelResetButton = document.querySelector("#cancelResetButton");
const resetPasswordButton = document.querySelector("#resetPasswordButton");
const usernameInput = document.querySelector("#username");

async function checkExistingSession() {
  try {
    const response = await fetch("/api/session");
    const data = await response.json();

    if (data.authenticated) {
      window.location.href = "/";
    }
  } catch {
    // The form remains available if the session check cannot complete.
  }
}

function showError() {
  if (!loginError) {
    return;
  }

  loginError.hidden = false;
  loginError.textContent = "Invalid username or password.";
}

function hideError() {
  if (loginError) {
    loginError.hidden = true;
  }
}

function openResetPanel() {
  if (resetModal) {
    resetModal.hidden = false;
  }
}

function closeResetPanel() {
  if (resetModal) {
    resetModal.hidden = true;
  }
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideError();

  const formData = new FormData(loginForm);
  const payload = {
    username: String(formData.get("username") ?? ""),
    password: String(formData.get("password") ?? "")
  };

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      showError();
      return;
    }

    sessionStorage.setItem("showLoginSuccess", "true");
    window.location.href = "/";
  } catch {
    showError();
  }
});

forgotPasswordButton?.addEventListener("click", openResetPanel);
cancelResetButton?.addEventListener("click", closeResetPanel);

resetPasswordButton?.addEventListener("click", () => {
  closeResetPanel();
});

resetModal?.addEventListener("click", (event) => {
  if (event.target === resetModal) {
    closeResetPanel();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeResetPanel();
  }
});

usernameInput?.focus();
void checkExistingSession();
