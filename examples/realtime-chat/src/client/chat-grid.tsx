import { useState } from "hono/jsx";
import { isRoom, ROOM_LABELS, ROOMS, type Room } from "../shared.ts";
import { ChatPane } from "./chat-pane.tsx";
import { PEOPLE } from "./types.ts";

export function ChatGrid() {
  const [room, setRoom] = useState<Room>("lobby");
  return (
    <>
      <section
        class="mb-3.5 flex items-end gap-[22px] rounded-[14px] border border-line bg-controls px-[18px] py-[15px] max-[580px]:flex-col"
        aria-label="Chat settings"
      >
        <label class="grid gap-[7px] text-[11px] font-bold tracking-[0.07em] text-label uppercase">
          <span>Room</span>
          <select
            class="min-h-[39px] rounded-[9px] border border-field-line bg-field px-3 text-select outline-none focus:border-ember focus:shadow-[0_0_0_3px_#e45d2b18]"
            value={room}
            onChange={(event) => {
              if (event.target instanceof HTMLSelectElement && isRoom(event.target.value)) {
                setRoom(event.target.value);
              }
            }}
          >
            {ROOMS.map((value) => (
              <option key={value} value={value}>
                {ROOM_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <p class="m-0 pb-2.5 text-xs text-help">
          Two visitors, one public room. Send from either side to see Takibi snapshots update both.
        </p>
      </section>
      <div class="grid grid-cols-2 gap-3.5 max-[580px]:grid-cols-1">
        {PEOPLE.map((person) => (
          <ChatPane key={person} person={person} room={room} />
        ))}
      </div>
    </>
  );
}
