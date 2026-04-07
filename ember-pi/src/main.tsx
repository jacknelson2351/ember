import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

// StrictMode intentionally removed — it double-invokes effects in dev,
// which spawns duplicate Docker/pi processes and corrupts shared state.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
