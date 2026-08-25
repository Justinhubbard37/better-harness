import type { IntentCorrelationPacketV1 } from "../contracts/intent-correlation.js";

/** Optional semantic claim provider. Results are accepted only after local contract validation. */
export interface StudioIntentAnalyzer {
  analyze(packet: IntentCorrelationPacketV1): Promise<unknown>;
}
