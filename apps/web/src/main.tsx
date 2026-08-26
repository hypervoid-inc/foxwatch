import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { OpsApp } from "./ops/OpsApp.tsx";

function swallowFileDrop(e: DragEvent) {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
}
window.addEventListener("dragover", swallowFileDrop);
window.addEventListener("drop", swallowFileDrop);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OpsApp />
  </StrictMode>,
);
