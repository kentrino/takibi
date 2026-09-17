import { ROOM_LABELS, ROOMS } from "./shared.ts";

export function HomePage() {
  return (
    <main class="mx-auto w-[min(920px,calc(100%-32px))] pt-11 pb-7 max-[580px]:w-[min(calc(100%-20px),920px)] max-[580px]:pt-5">
      <header class="mb-[30px] flex items-center gap-3.5">
        <div
          class="grid size-12 place-items-center rounded-[15px] bg-ember text-[25px] text-ember-ink shadow-[0_8px_24px_#a7361728]"
          aria-hidden="true"
        >
          火
        </div>
        <div>
          <p class="mb-1.5 text-[10px] font-extrabold tracking-[0.19em] text-eyebrow">
            TAKIBI REALTIME
          </p>
          <h1 class="m-0 font-serif text-[30px] leading-none">Fireside</h1>
        </div>
      </header>

      <section
        class="mb-3.5 flex items-end gap-[22px] rounded-[14px] border border-line bg-controls px-[18px] py-[15px] max-[580px]:flex-col"
        aria-label="Chat settings"
      >
        <label class="grid gap-[7px] text-[11px] font-bold tracking-[0.07em] text-label uppercase">
          <span>Room</span>
          <select
            id="room"
            class="min-h-[39px] rounded-[9px] border border-field-line bg-field px-3 text-select outline-none focus:border-ember focus:shadow-[0_0_0_3px_#e45d2b18]"
          >
            {ROOMS.map((room) => (
              <option key={room} value={room}>
                {ROOM_LABELS[room]}
              </option>
            ))}
          </select>
        </label>
        <p class="m-0 pb-2.5 text-xs text-help">
          Two visitors, one public room. Send from either side to see Takibi snapshots update both.
        </p>
      </section>

      <div id="chat-grid" class="grid grid-cols-2 gap-3.5 max-[580px]:grid-cols-1" />
      <p class="mt-3.5 text-center text-[11px] text-note">
        Public demo · Latest 50 messages · Visible to everyone in this room · No login
      </p>
    </main>
  );
}
