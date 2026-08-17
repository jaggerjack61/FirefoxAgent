import { createRoot } from "react-dom/client";
import { App } from "./components/App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
createRoot(container).render(<App />);
