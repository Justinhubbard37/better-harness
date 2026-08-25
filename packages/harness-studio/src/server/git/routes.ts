import { GitCommitDetail } from "../../contracts/git-history.js";
import { GitHistoryError, readGitCommitAtRoot, readGitFilePatchAtRoot, readGitLog, readGitRefsAtRoot } from "../git-history.js";
import { open } from "node:fs/promises";
import { ServerResponse } from "node:http";
import { respondJson } from "../http-utils.js";
import { HarnessStudioState } from "../studio-types.js";

function gitWorkspaceRoot(state: HarnessStudioState): string {
  const workspace = state.workspace;
  if (workspace?.gitRoot === undefined) {
    throw new GitHistoryError("The open workspace is not a Git repository.", 404, "NOT_GIT_REPOSITORY");
  }
  return workspace.gitRoot;
}
export async function serveGitRefs(response: ServerResponse, state: HarnessStudioState): Promise<void> {
  try {
    const refs = await readGitRefsAtRoot(gitWorkspaceRoot(state));
    if (state.workspace !== undefined) state.workspace.gitRefs = refs;
    respondJson(response, 200, refs, { "Cache-Control": "no-store" });
  } catch (error) {
    respondGitError(response, error);
  }
}
export async function serveGitLog(response: ServerResponse, state: HarnessStudioState, url: URL): Promise<void> {
  try {
    const limitText = url.searchParams.get("limit");
    const root = gitWorkspaceRoot(state);
    const refs = state.workspace?.gitRefs ?? await readGitRefsAtRoot(root);
    if (state.workspace !== undefined) state.workspace.gitRefs = refs;
    respondJson(response, 200, await readGitLog(root, {
      refs: url.searchParams.getAll("ref"),
      search: url.searchParams.get("search") ?? undefined,
      limit: limitText === null ? undefined : Number(limitText),
      cursor: url.searchParams.get("cursor") ?? undefined,
    }, refs), { "Cache-Control": "no-store" });
  } catch (error) {
    respondGitError(response, error);
  }
}
export async function serveGitCommit(response: ServerResponse, state: HarnessStudioState, sha: string): Promise<void> {
  try {
    respondJson(response, 200, await cachedGitCommit(state, sha), { "Cache-Control": "no-store" });
  } catch (error) {
    respondGitError(response, error);
  }
}
export async function serveGitFilePatch(
  response: ServerResponse,
  state: HarnessStudioState,
  sha: string,
  path: string | null,
): Promise<void> {
  try {
    if (path === null) throw new GitHistoryError("File path is required.", 400, "INVALID_PATH");
    const detail = await cachedGitCommit(state, sha);
    respondJson(response, 200, await readGitFilePatchAtRoot(gitWorkspaceRoot(state), sha, path, detail), { "Cache-Control": "no-store" });
  } catch (error) {
    respondGitError(response, error);
  }
}
async function cachedGitCommit(state: HarnessStudioState, sha: string): Promise<GitCommitDetail> {
  const workspace = state.workspace;
  const cached = workspace?.gitCommitCache?.get(sha);
  if (cached !== undefined) return cached;
  const detail = await readGitCommitAtRoot(gitWorkspaceRoot(state), sha);
  if (workspace?.gitCommitCache !== undefined) {
    workspace.gitCommitCache.set(sha, detail);
    if (workspace.gitCommitCache.size > 64) {
      const oldest = workspace.gitCommitCache.keys().next().value as string | undefined;
      if (oldest !== undefined) workspace.gitCommitCache.delete(oldest);
    }
  }
  return detail;
}
function respondGitError(response: ServerResponse, error: unknown): void {
  if (error instanceof GitHistoryError) {
    respondJson(response, error.status, { error: error.message, code: error.code });
    return;
  }
  respondJson(response, 500, { error: "Git history is unavailable.", code: "GIT_HISTORY_FAILED" });
}
