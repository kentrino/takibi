import { render } from "hono/jsx/dom";
import "./style.css";
import { ChatGrid } from "./chat-grid.tsx";

const grid = document.getElementById("chat-grid");
if (!grid) throw new Error("Missing #chat-grid");
render(<ChatGrid />, grid);
