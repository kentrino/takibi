import type { Child } from "hono/jsx";

const favicon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23e45d2b'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-size='16' fill='%23fff8ec'%3E火%3C/text%3E%3C/svg%3E";

export function Document(props: { children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta
          name="description"
          content="A public realtime chat powered by Takibi watch snapshots."
        />
        <title>Takibi Fireside</title>
        <link rel="icon" href={favicon} />
        <link rel="stylesheet" href="/main.css" />
      </head>
      <body class="m-0 min-h-dvh min-w-[320px] bg-paper font-sans text-ink antialiased [font-synthesis:none]">
        {props.children}
        <script type="module" src="/main.js" />
      </body>
    </html>
  );
}
