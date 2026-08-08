import { contract } from "@takibi/contracts";
import { fn } from "@takibi/utils";
import { implement } from "@orpc/server";

export type RouterContext = {
  env: {
    GREETING_PREFIX: string;
  };
};

const os = implement(contract).$context<RouterContext>();

const greet = os.greet.handler(({ input, context }) => {
  const name = input.name || "World";
  const prefix = context.env.GREETING_PREFIX;
  return { message: `${prefix}, ${name}! (${fn()})` };
});

export const router = os.router({ greet });

export type Router = typeof router;
