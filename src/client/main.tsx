// Author, creator and maintainer: Dhruba Poudel.
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("The application root was not found.");
createRoot(root).render(<App />);
