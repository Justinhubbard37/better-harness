import {
  ARTIFACT_SURFACE_MOUNTS,
  resolveArtifactSurfaceMount,
} from "./artifacts/ArtifactSurfaceRegistry.js";
import type {
  ArtifactSurfaceMount,
  ArtifactSurfaceMountContext,
} from "./artifacts/ArtifactSurface.js";
import type { ArtifactDescriptor } from "../artifact-model.js";

export {
  ARTIFACT_SURFACE_MOUNTS,
  normalizeArtifactSurfaceKind,
  resolveArtifactSurfaceMount,
} from "./artifacts/ArtifactSurfaceRegistry.js";
export type {
  ArtifactSurfaceKind,
  ArtifactSurfaceMount,
  ArtifactSurfaceMountContext,
} from "./artifacts/ArtifactSurface.js";

/** @deprecated V2 source compatibility; new code uses Artifact Surface terminology. */
export type ArtifactViewProviderContext = ArtifactSurfaceMountContext;
/** @deprecated V2 source compatibility; new code uses Artifact Surface terminology. */
export type ArtifactViewProvider = ArtifactSurfaceMount;
/** @deprecated V2 source compatibility; new code uses Artifact Surface terminology. */
export const ARTIFACT_VIEW_PROVIDERS = ARTIFACT_SURFACE_MOUNTS;
/** @deprecated V2 source compatibility; new code uses Artifact Surface terminology. */
export const resolveArtifactViewProvider = resolveArtifactSurfaceMount;

/** Host-owned dispatch; the server-selected renderer remains authoritative. */
export function ArtifactView(props: ArtifactSurfaceMountContext): React.JSX.Element {
  if (props.artifact.renderer.status === "ready") {
    const mount = resolveArtifactSurfaceMount(props.artifact);
    if (mount !== undefined) {
      const Component = mount.Component;
      const key = artifactSurfaceInstanceKey(mount, props.artifact);
      return <Component key={key} {...props} />;
    }
  }
  return <p className="artifact-status" role="status">{props.artifact.renderer.reason ?? `No renderer is available for this artifact (${props.artifact.renderer.id}).`}</p>;
}

/** Remount whenever the server-selected adapter or renderer binding changes. */
export function artifactSurfaceInstanceKey(mount: ArtifactSurfaceMount, artifact: ArtifactDescriptor): string {
  return [
    mount.id,
    artifact.id,
    artifact.revision.digest,
    artifact.adapter.snapshotId,
    artifact.renderer.provider,
    artifact.renderer.id,
    artifact.renderer.type,
    artifact.renderer.viewUri ?? "",
  ].join(":");
}
