import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Silenzia e ignora gli errori WebSocket di Vite HMR dovuti all'iframe sandboxed
if (typeof window !== "undefined") {
  const isWsError = (msg: string) => {
    return (
      msg.includes("WebSocket") || 
      msg.includes("websocket") || 
      msg.includes("failed to connect to websocket") ||
      msg.includes("WebSocket closed")
    );
  };

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const msg = reason?.message || String(reason || "");
    if (isWsError(msg)) {
      event.preventDefault();
      event.stopPropagation();
      console.warn("[Vite-WS-Silence] Suppressed unhandled websocket rejection:", msg);
    }
  });

  window.addEventListener("error", (event) => {
    const msg = event.message || "";
    if (isWsError(msg)) {
      event.preventDefault();
      event.stopPropagation();
      console.warn("[Vite-WS-Silence] Suppressed windows webpack/vite error:", msg);
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
