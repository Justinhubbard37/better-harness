import { describe, expect, it } from "vitest";
import {
  ARTIFACT_PROVIDER_API_VERSION,
  defineArtifactProvider,
  isArtifactDataSnapshot,
  type ArtifactDataSnapshot,
  type ExternalArtifactProvider,
} from "../src/artifacts/index.js";

const DIGEST = `sha256:${"a".repeat(64)}` as const;

describe("Artifact provider SDK", () => {
  it("preserves provider literal types without importing a Studio host", () => {
    const receipt: ExternalArtifactProvider["receipt"] = {
      kind: "HarnessStudioExternalArtifactProviderReceiptV1",
      providerId: "fixture",
      providerVersion: "1",
      providerDescriptorDigest: DIGEST,
      assets: [],
      driverVersions: {},
    };
    const provider = defineArtifactProvider({
      id: "fixture",
      label: "Fixture",
      version: "1",
      acquisition: "operator-provisioned",
      fingerprint: DIGEST,
      receipt,
      contributions: [],
    });

    expect(ARTIFACT_PROVIDER_API_VERSION).toBe("1");
    expect(provider.id).toBe("fixture");
  });

  it("keeps custom provider payloads forward compatible inside the common envelope", () => {
    const snapshot: ArtifactDataSnapshot = {
      kind: "ArtifactDataSnapshotV1",
      artifactId: "diagram",
      revisionId: DIGEST,
      snapshotId: DIGEST,
      adapter: { id: "fixture", version: "1" },
      schemaId: "fixture/v1",
      summary: { label: "diagram.dsl", family: "images-diagrams", format: "dsl" },
      structure: [],
      semanticIndex: [],
      resources: [],
      diagnostics: [],
      payload: { kind: "external:homology/structurizr-v1", viewKey: "SystemContext" },
    };
    expect(isArtifactDataSnapshot(snapshot)).toBe(true);
  });
});
