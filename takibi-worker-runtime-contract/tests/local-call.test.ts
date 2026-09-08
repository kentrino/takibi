import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  decodeLocalCallRequest,
  getLocalCallWireInvocation,
  getLocalCallWireInvocations,
  localBatchCall,
  localSingleCall,
  resolveLocalCallContext,
  TakibiContractConfigurationError,
  type LocalCallRequest,
  type LocalCallTypeMap,
} from "../src";

type Ctx = { readonly tenantId: string };
type Wire = { readonly id: string };
type Envelope = LocalCallRequest<Ctx, Wire>;

test("local envelope constructors and default adapters unwrap a decoded call", () => {
  const context = { tenantId: "tenant-1" };
  const invocation = { id: "patient-1" };
  const single = localSingleCall(context, invocation);
  const batch = localBatchCall(context, [invocation]);

  expect(decodeLocalCallRequest(single)).toBe(single);
  expect(resolveLocalCallContext({ decoded: single })).toEqual(context);
  expect(getLocalCallWireInvocation({ decoded: single })).toEqual(invocation);
  expect(getLocalCallWireInvocations({ decoded: batch })).toEqual([invocation]);
});

test("local wire getters reject the opposite envelope kind", () => {
  const single = localSingleCall({ tenantId: "tenant-1" }, { id: "patient-1" });
  const batch = localBatchCall({ tenantId: "tenant-1" }, [{ id: "patient-1" }]);

  expect(() => getLocalCallWireInvocations({ decoded: single })).toThrow(
    TakibiContractConfigurationError,
  );
  expect(() => getLocalCallWireInvocation({ decoded: batch })).toThrow(
    TakibiContractConfigurationError,
  );
});

test("LocalCallTypeMap pins request and decoded to the local envelope", () => {
  type Spec = {
    wireInvocation: Wire;
    invocation: Wire;
    collections: unknown;
    storage: unknown;
    registry: unknown;
    context: Ctx;
    logger: unknown;
    services: unknown;
    rawInput: unknown;
    input: unknown;
    noneWork: unknown;
    applyWork: unknown;
    fullWork: unknown;
    nonePrepared: unknown;
    applyPrepared: unknown;
    result: unknown;
    failure: unknown;
  };

  expectTypeOf<LocalCallTypeMap<Spec, string>["request"]>().toEqualTypeOf<Envelope>();
  expectTypeOf<LocalCallTypeMap<Spec, string>["decoded"]>().toEqualTypeOf<Envelope>();
  expectTypeOf<LocalCallTypeMap<Spec, string>["context"]>().toEqualTypeOf<Ctx>();
});
