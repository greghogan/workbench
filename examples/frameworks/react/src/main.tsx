import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Counter } from "./Counter.js";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root application container");
export const root = createRoot(container);
root.render(
  <StrictMode>
    <Counter />
  </StrictMode>,
);
