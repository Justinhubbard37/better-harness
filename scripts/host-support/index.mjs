import { HOST_PROFILES, HOST_SUPPORT_SCHEMA_VERSION } from "./profiles.mjs";
import { validateHostProfileRegistry } from "./profile-model.mjs";

export function validateHostProfiles(profiles = HOST_PROFILES) {
  return validateHostProfileRegistry(profiles);
}

validateHostProfiles();

export function listHostProfiles() {
  return HOST_PROFILES;
}

export function resolveHostId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const profile = HOST_PROFILES.find((entry) => (
    entry.hostId === normalized || entry.aliases.includes(normalized)
  ));
  return profile?.hostId;
}

export function getHostProfile(value) {
  const hostId = resolveHostId(value);
  return hostId ? HOST_PROFILES.find((entry) => entry.hostId === hostId) : undefined;
}

export function getHostSurface(host, surfaceId) {
  const profile = getHostProfile(host);
  if (!profile) return undefined;
  if (surfaceId) return profile.surfaces.find((surface) => surface.surfaceId === surfaceId);
  return profile.surfaces.length === 1 ? profile.surfaces[0] : undefined;
}

export function supportedHostIds({ managedOnly = false } = {}) {
  return HOST_PROFILES
    .filter((profile) => !managedOnly || profile.managed)
    .map((profile) => profile.hostId);
}

export { HOST_PROFILES, HOST_SUPPORT_SCHEMA_VERSION } from "./profiles.mjs";
