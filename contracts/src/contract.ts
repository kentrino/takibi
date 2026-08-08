import { oc } from "@orpc/contract";
import { GreetInput, GreetOutput } from "./schemas";

export const greetContract = oc
  .route({ method: "GET", path: "/greet" })
  .input(GreetInput)
  .output(GreetOutput);

export const contract = {
  greet: greetContract,
};
