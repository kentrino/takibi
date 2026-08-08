import { z } from "zod";

export const GreetInput = z.object({
  name: z.string().optional(),
});

export const GreetOutput = z.object({
  message: z.string(),
});
