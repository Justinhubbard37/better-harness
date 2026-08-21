import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { isArtifactDataSnapshot, type ArtifactDescriptor, type PptxArtifactPayload } from "../src/artifact-model.js";
import { describeArtifactCatalog, indexArtifactDirectory } from "../src/server/artifact-catalog.js";
import { adaptPptxArtifact, readPptxSnapshotResource, resetPptxArtifactCache } from "../src/server/pptx-artifact-adapter.js";
import { presentArtifact } from "../src/server/artifact-viewers.js";
import { createPptxFixture, TINY_PNG } from "./pptx-fixture.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  resetPptxArtifactCache();
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PPTX ArtifactDataAdapter", () => {
  it("creates a revision-bound snapshot with text, images, notes, and semantic addresses", async () => {
    const { entry, descriptor } = await writeFixture("01");

    const snapshot = await adaptPptxArtifact(entry, descriptor);

    expect(isArtifactDataSnapshot(snapshot)).toBe(true);
    expect(snapshot).toMatchObject({
      artifactId: descriptor.id,
      revisionId: descriptor.revision.id,
      snapshotId: descriptor.adapter.snapshotId,
      adapter: { id: "studio.pptx-ooxml", version: "1" },
      schemaId: "pptx/v1",
    });
    const payload = snapshot.payload as PptxArtifactPayload;
    expect(payload.kind).toBe("pptx/v1");
    expect(payload).toMatchObject({ width: 12_192_000, height: 6_858_000 });
    expect(payload.slides).toHaveLength(1);
    expect(payload.slides[0]?.elements).toHaveLength(2);
    expect(payload.slides[0]?.elements[0]).toMatchObject({
      kind: "shape",
      name: "Title 1",
      address: "pptx:slide/1/shape/Title-1",
      paragraphs: [{ runs: [{ text: "01", fontSizePoints: 32, bold: true }] }],
    });
    expect(payload.slides[0]).toMatchObject({
      notesPresent: true,
      notesText: "Source <local-path>/secret.md",
    });
    expect(snapshot.structure[0]).toMatchObject({ address: "pptx:slide/1", kind: "slide" });
    expect(snapshot.semanticIndex.map((item) => item.address)).toContain("pptx:slide/1/shape/Title-1");
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: "PPTX_BASELINE_RENDERER", level: "info" }));

    const resource = snapshot.resources[0]!;
    expect(resource).toMatchObject({ mediaType: "image/png", size: TINY_PNG.length });
    expect(resource.uri).toBe(`/api/artifacts/${descriptor.id}/resources/${resource.id}`);
    expect(await readPptxSnapshotResource(entry, descriptor, resource.id)).toMatchObject({
      mediaType: "image/png",
      label: "image1.png",
    });
    expect((await readPptxSnapshotResource(entry, descriptor, resource.id))?.bytes).toEqual(TINY_PNG);
    expect(await readPptxSnapshotResource(entry, descriptor, "../image1")).toBeUndefined();
  });

  it("invalidates both artifact and snapshot revisions when the deck bytes change", async () => {
    const first = await writeFixture("01");
    const firstSnapshot = await adaptPptxArtifact(first.entry, first.descriptor);

    await writeFile(first.entry.path, createPptxFixture("02"));
    const entries = await indexArtifactDirectory(first.directory, { includeDigests: true });
    const secondDescriptor = describeArtifactCatalog(entries, (entry) => presentArtifact(entry, [])).artifacts[0]!;
    const secondSnapshot = await adaptPptxArtifact(entries[0]!, secondDescriptor);

    expect(secondDescriptor.revision.id).not.toBe(first.descriptor.revision.id);
    expect(secondDescriptor.adapter.snapshotId).not.toBe(first.descriptor.adapter.snapshotId);
    expect(secondSnapshot.revisionId).not.toBe(firstSnapshot.revisionId);
    expect(((secondSnapshot.payload as PptxArtifactPayload).slides[0]?.elements[0] as { paragraphs: Array<{ runs: Array<{ text: string }> }> }).paragraphs[0]?.runs[0]?.text).toBe("02");
  });

  it("rejects malformed archives instead of returning a partial snapshot", async () => {
    const directory = await makeTempDirectory();
    await writeFile(join(directory, "broken.pptx"), "not a zip archive");
    const entries = await indexArtifactDirectory(directory, { includeDigests: true });
    const descriptor = describeArtifactCatalog(entries, (entry) => presentArtifact(entry, [])).artifacts[0]!;

    await expect(adaptPptxArtifact(entries[0]!, descriptor)).rejects.toThrow();
  });

  it("rejects unsafe package paths and oversized expanded entries", async () => {
    await expectRejectedArchive(zipSync({ "../outside.xml": strToU8("escape") }), /unsafe entry path/u);
    await expectRejectedArchive(zipSync({ "ppt/media/huge.bin": new Uint8Array(32 * 1024 * 1024 + 1) }, { level: 9 }), /entry exceeds the expansion limit/u);
  });
});

async function writeFixture(text: string): Promise<{ directory: string; entry: Awaited<ReturnType<typeof indexArtifactDirectory>>[number]; descriptor: ArtifactDescriptor }> {
  const directory = await makeTempDirectory();
  await writeFile(join(directory, "deck.pptx"), createPptxFixture(text));
  const entries = await indexArtifactDirectory(directory, { includeDigests: true });
  const descriptor = describeArtifactCatalog(entries, (entry) => presentArtifact(entry, [])).artifacts[0]!;
  return { directory, entry: entries[0]!, descriptor };
}

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "studio-pptx-adapter-"));
  tempDirectories.push(directory);
  return directory;
}

async function expectRejectedArchive(bytes: Uint8Array, error: RegExp): Promise<void> {
  const directory = await makeTempDirectory();
  await writeFile(join(directory, "hostile.pptx"), bytes);
  const entries = await indexArtifactDirectory(directory, { includeDigests: true });
  const descriptor = describeArtifactCatalog(entries, (entry) => presentArtifact(entry, [])).artifacts[0]!;
  await expect(adaptPptxArtifact(entries[0]!, descriptor)).rejects.toThrow(error);
}
