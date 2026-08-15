/**
 * Realization facts of the adapters this package ships.
 *
 * Callers that let a bundle pick its own target still need the right descriptor
 * for whichever runtime is selected, and guessing is exactly the dishonesty the
 * descriptor exists to remove: a runtime with no shipped adapter resolves
 * against prompt-only facts and fails closed on anything stronger.
 */
import type { AdapterRealizationDescriptor } from "../resolver/adapter-descriptor.js";
import { PiSdkAdapter } from "./pi-sdk.js";
import { QoderSdkAdapter } from "./qoder-sdk.js";

/** `undefined` for a runtime this package has no adapter for. */
export function describeBuiltInAdapter(
  runtimeId: string,
): AdapterRealizationDescriptor | undefined {
  switch (runtimeId) {
    case "qoder":
      return new QoderSdkAdapter().describe();
    case "pi":
      return new PiSdkAdapter().describe();
    default:
      return undefined;
  }
}
