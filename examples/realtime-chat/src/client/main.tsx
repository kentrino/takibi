import { render } from "hono/jsx/dom";
import "./style.css";
import { ChatGrid } from "./chat-grid.tsx";

const root = document.getElementById("chat");
if (!root) throw new Error("Missing #chat");
render(<ChatGrid />, root);
