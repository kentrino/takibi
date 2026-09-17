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
      <div id="chat" />
      <p class="mt-3.5 text-center text-[11px] text-note">
        Public demo · Latest 50 messages · Visible to everyone in this room · No login
      </p>
    </main>
  );
}
