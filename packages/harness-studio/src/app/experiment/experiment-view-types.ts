import type {
  ExperimentSetupPreview,
  ExperimentLockReceipt,
} from "../../contracts/experiment-setup.js";
import type {
  CanonicalToolEvent,
  ExperimentToolCall,
} from "../../contracts/experiment-stream-contract.js";

export interface LaneDefinition {
  id: string;
  origin: "observed" | "execute";
  trials?: number;
  startCheckpointDigest?: string;
  harnessId?: string;
  runtime?: { profile: string; model: string };
  identity?: { harnessId?: string; profile?: string; model?: string };
}

export interface ExperimentPreview {
  manifest: {
    runtime?: { host: "qoder" | "acp" };
    lanes: LaneDefinition[];
    contrasts: Array<{ id: string; lanes: string[] }>;
    task: { prompt: string };
  };
  checkpoint: { digest: string; plan: string };
  contrasts: Array<{
    id: string;
    lanes: string[];
    attribution: { mode: string; axis?: string; detail: string };
  }>;
  setup: ExperimentSetupPreview;
  observedCalls: Record<string, ExperimentToolCall[]>;
  acpAgents?: {
    agents: Array<{
      id: string;
      label: string;
      available: boolean;
      modelPolicy: "lane" | "agent-default";
      detail: string;
    }>;
    defaultAgentId?: string;
  };
  observedCallPages?: Record<string, {
    nextCursor?: string;
    complete: boolean;
    parsedLines: number;
    malformedLines: number;
  }>;
  lock?: ExperimentLockReceipt;
}

export interface LaneTrace {
  status: "history" | "idle" | "preparing" | "running" | "finished" | "failed" | "cancelled";
  calls: ExperimentToolCall[];
  eventCount: number;
  protocolFrameCount: number;
  acpSessionIds: string[];
  pendingPermissions: PendingAcpPermission[];
  activities: LaneActivity[];
  detail?: string;
  nextCursor?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
}

export type LaneActivity =
  | { kind: "assistant"; id: string; text: string; complete: boolean }
  | { kind: "tool"; id: string; runId: string; toolCallId: string };

export interface PendingAcpPermission {
  runId: string;
  requestId: string;
  toolCallId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
}

export interface ContrastResult {
  id: string;
  lanes: string[];
  status: string;
  reason: string;
}

export interface StreamEvent {
  type: string;
  experimentId: string;
  laneId: string | null;
  runId: string | null;
  detail?: string;
  event?: CanonicalToolEvent;
  result?: { classification?: "passed" | "failed"; executorError?: string };
  compareSet?: { contrasts: ContrastResult[] };
}

export interface Selection { laneId: string; callId: string }
export type CompareView = "summary" | "trace" | "evidence";
export type TraceLens = "calls" | "resources";
export type EvidenceRole = "Reference" | "Baseline" | "Candidate";
export type ComparabilityLevel = "Controlled" | "Partial" | "Observational" | "Incomparable";
export interface Comparability { level: ComparabilityLevel; detail: string; axis?: string }
