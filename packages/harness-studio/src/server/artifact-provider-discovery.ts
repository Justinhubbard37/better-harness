import type { ArtifactProviderStatus } from "../artifact-model.js";
import type { ArtifactPluginRegistry, ExternalArtifactProvider } from "./artifact-adapter-contract.js";
import {
  activationSourceFingerprint,
  importLegacyQoderActivationsOnce,
  readArtifactProviderActivationState,
  type ArtifactProviderActivationStoreOptions,
} from "./artifact-provider-activation.js";
import { createArtifactPluginRegistry } from "./artifact-plugin-registry.js";
import { defaultCanvasViewerRoot } from "./artifact-viewers.js";
import { discoverQoderArtifactProviders } from "./qoder-artifact-provider.js";
import { resolveQoderCanvasRuntime } from "./qoder-canvas-viewer-bridge.js";
import { discoverWalnutArtifactProvider } from "./walnut-artifact-provider.js";

export interface DiscoverArtifactProviderRuntimeOptions {
  canvasViewerRoot?: string;
  canvasSdkRoot?: string;
  canvasSdkMedia?: string;
  cwd?: string;
  artifactProviderStateRoot?: string;
  walnutCacheRoot?: string;
}

export interface ArtifactProviderRuntime {
  providers: readonly ExternalArtifactProvider[];
  registry: ArtifactPluginRegistry;
  statuses: readonly ArtifactProviderStatus[];
}

export async function discoverArtifactProviderRuntime(
  options: DiscoverArtifactProviderRuntimeOptions = {},
): Promise<ArtifactProviderRuntime> {
  const providers: ExternalArtifactProvider[] = [];
  const statuses: ArtifactProviderStatus[] = [];
  const runtime = resolveQoderCanvasRuntime({
    sdkRoot: options.canvasSdkRoot,
    sdkMedia: options.canvasSdkMedia,
    cwd: options.cwd,
  });
  let qoderProviders: ExternalArtifactProvider[] = [];
  if (runtime === undefined) {
    statuses.push(unavailableQoderStatus("The Canvas SDK runtime is unavailable."));
  } else {
    qoderProviders = await discoverQoderArtifactProviders({ viewerRoot: options.canvasViewerRoot, runtime });
    providers.push(...qoderProviders);
    if (qoderProviders.length === 0) statuses.push(unavailableQoderStatus("No receipt-verified Canvas viewer is available."));
  }
  const storeOptions: ArtifactProviderActivationStoreOptions = {
    ...(options.artifactProviderStateRoot === undefined ? {} : { root: options.artifactProviderStateRoot }),
  };
  let activationFailure = false;
  let activations: ArtifactPluginRegistry["activations"] = [];
  try {
    if (qoderProviders.length > 0) {
      const root = options.canvasViewerRoot ?? defaultCanvasViewerRoot();
      await importLegacyQoderActivationsOnce(qoderProviders, activationSourceFingerprint(root), storeOptions);
    }
    activations = (await readArtifactProviderActivationState(storeOptions)).activations;
  } catch {
    activationFailure = true;
  }
  for (const provider of qoderProviders) statuses.push(providerStatus(provider, activations, activationFailure));

  const walnut = await discoverWalnutArtifactProvider(options.walnutCacheRoot);
  if (walnut.provider !== undefined) providers.push(walnut.provider);
  statuses.push(walnut.status);
  return {
    providers: Object.freeze(providers),
    statuses: Object.freeze(statuses),
    registry: createArtifactPluginRegistry({ externalProviders: providers, activations }),
  };
}

function providerStatus(
  provider: ExternalArtifactProvider,
  activations: ArtifactPluginRegistry["activations"],
  activationFailure: boolean,
): ArtifactProviderStatus {
  return {
    id: provider.id,
    label: provider.label,
    version: provider.version,
    acquisition: provider.acquisition,
    status: "ready",
    receiptVerified: true,
    fingerprint: provider.fingerprint,
    contributions: provider.contributions.map((contribution) => {
      const activation = activations.find((candidate) => candidate.providerId === provider.id
        && candidate.contributionId === contribution.id && candidate.fingerprint === provider.fingerprint);
      return {
        id: contribution.id,
        label: contribution.label,
        support: contribution.support,
        active: activation !== undefined,
        ...(activation === undefined ? {} : { lane: activation.lane }),
      };
    }),
    ...(activationFailure ? { reason: "Artifact provider activation state is unavailable; external contributions are inactive." } : {}),
  };
}

function unavailableQoderStatus(reason: string): ArtifactProviderStatus {
  return {
    id: "qoder-canvas",
    label: "Qoder Canvas",
    acquisition: "operator-provisioned",
    status: "unavailable",
    receiptVerified: false,
    contributions: [],
    reason,
  };
}
