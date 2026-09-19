import type { Message } from "./types.ts";

export function MessageItem(props: { message: Message; own: boolean }) {
  const { message, own } = props;
  return (
    <li class={`flex py-[7px] ${own ? "justify-end" : ""}`}>
      <div
        class={`max-w-[84%] px-[11px] py-[9px] ${
          own
            ? "rounded-[13px_4px_13px_13px] bg-person-a-bg"
            : "rounded-[4px_13px_13px_13px] bg-bubble"
        }`}
      >
        <div class="mb-[3px] flex items-baseline gap-[9px]">
          <strong class="text-[13px]">{own ? "You" : message.displayName}</strong>
          <time class="text-[10px] text-meta" dateTime={message.createdAt}>
            {new Intl.DateTimeFormat(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(message.createdAt))}
          </time>
        </div>
        <p class="m-0 text-sm leading-[1.48] whitespace-pre-wrap text-body [overflow-wrap:anywhere]">
          {message.body}
        </p>
      </div>
    </li>
  );
}
