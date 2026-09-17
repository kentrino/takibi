import { useEffect, useState } from "hono/jsx";
import { isRoom, type Room } from "../shared.ts";
import { ChatPane } from "./chat-pane.tsx";
import { PEOPLE } from "./types.ts";

function requireElement<T>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as T;
}

const roomSelect = requireElement<HTMLSelectElement>("room");

function selectedRoom(): Room {
  return isRoom(roomSelect.value) ? roomSelect.value : "lobby";
}

export function ChatGrid() {
  const [room, setRoom] = useState<Room>(selectedRoom);
  useEffect(() => {
    const onChange = () => setRoom(selectedRoom());
    roomSelect.addEventListener("change", onChange);
    return () => roomSelect.removeEventListener("change", onChange);
  }, []);
  return (
    <>
      {PEOPLE.map((person) => (
        <ChatPane key={person} person={person} room={room} />
      ))}
    </>
  );
}
