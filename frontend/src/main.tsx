import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { AuthGate, AuthProvider } from "./auth/AuthProvider";

// Apply persisted theme before first paint to avoid flash.
const savedTheme = localStorage.getItem("stim-app.theme");
if (savedTheme === "light") document.documentElement.classList.add("light");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </AuthProvider>
  </StrictMode>
);
