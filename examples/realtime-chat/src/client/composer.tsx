import { MESSAGE_BODY_MAX_LENGTH } from "../shared.ts";
import type { Person } from "./types.ts";

export function Composer(props: {
  person: Person;
  draft: string;
  error: string;
  sending: boolean;
  bodyRef: { current: HTMLTextAreaElement | null };
  onDraftChange: (value: string) => void;
  onSubmit: (event: Event) => void;
}) {
  const { person, draft, error, sending, bodyRef, onDraftChange, onSubmit } = props;
  return (
    <form
      class="mx-[22px] mb-[22px] rounded-[13px] border border-line bg-white"
      onSubmit={onSubmit}
    >
      <textarea
        ref={bodyRef}
        class="block min-h-[70px] w-full resize-y border-0 bg-transparent px-[15px] pt-3.5 pb-1.5 text-select outline-none"
        rows={2}
        maxLength={MESSAGE_BODY_MAX_LENGTH}
        placeholder={`Message as ${person}…`}
        aria-label={`Message as ${person}`}
        value={draft}
        onInput={(event) => {
          if (event.target instanceof HTMLTextAreaElement) onDraftChange(event.target.value);
        }}
      />
      <div class="flex min-h-[47px] items-center gap-3 px-2 pt-1.5 pr-2 pb-2 pl-[15px]">
        <p class="m-0 flex-1 text-[11px] text-error" role="alert">
          {error}
        </p>
        <span class="text-[10px] text-meta">
          {draft.length} / {MESSAGE_BODY_MAX_LENGTH}
        </span>
        <button
          class="cursor-pointer rounded-[9px] border-0 bg-ember px-[15px] py-[9px] text-xs font-bold text-white disabled:cursor-wait disabled:opacity-55"
          type="submit"
          disabled={sending}
        >
          Send ↗
        </button>
      </div>
    </form>
  );
}
