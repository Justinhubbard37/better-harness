import { Component, createElement, type ErrorInfo, type ReactNode } from "react";
import * as React from "react";
import { createRoot } from "react-dom/client";

/**
 * Artifact host runtime.
 *
 * This bundle runs inside the sandboxed artifact iframe, never in the Studio
 * shell. It is built as an IIFE and loaded with a classic `<script>` tag: the
 * iframe carries `sandbox="allow-scripts"` without `allow-same-origin`, so it
 * has an opaque origin, and classic scripts load from an opaque origin without
 * CORS while module scripts would not.
 *
 * The compiled artifact module is lowered to `React.createElement` and relies on
 * the `React` global installed here, so one React instance is shared with the
 * host and the artifact needs no import map.
 */

interface BoundaryProps {
  children: ReactNode;
}

interface BoundaryState {
  message: string | undefined;
}

class ArtifactErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { message: undefined };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep the failure observable for browser verification without letting a
    // throwing artifact take the frame down silently.
    console.error("[artifact] render failed", error, info.componentStack);
  }

  override render(): ReactNode {
    const { message } = this.state;
    if (message === undefined) return this.props.children;
    return failureElement("This artifact failed while rendering.", message);
  }
}

function failureElement(headline: string, detail: string): ReactNode {
  return createElement(
    "div",
    { className: "artifact-failure", role: "alert" },
    createElement("strong", null, headline),
    createElement("pre", null, detail),
  );
}

/**
 * Only same-origin artifact module paths are accepted. Without this the host
 * would import whatever URL a query string names.
 */
export function resolveModuleUrl(raw: string | null): string {
  const candidate = (raw ?? "").trim();
  if (candidate === "") throw new Error("No artifact module was requested.");
  if (!/^\/?api\/artifacts\/[A-Za-z0-9_-]+\/module\.js$/u.test(candidate)) {
    throw new Error(`Refusing to load an artifact module from '${candidate}'.`);
  }
  return new URL(candidate, document.baseURI).href;
}

export async function mount(rawModule: string | null): Promise<void> {
  const root = document.getElementById("artifact-root");
  if (!(root instanceof HTMLElement)) {
    console.error("[artifact] host root element is missing");
    return;
  }

  // The compiled artifact calls `React.createElement`, so the namespace has to
  // land on the global before the module is imported.
  (globalThis as unknown as { React: unknown }).React = React;

  let url: string;
  try {
    url = resolveModuleUrl(rawModule);
  } catch (error) {
    createRoot(root).render(failureElement("This artifact could not be loaded.", messageOf(error)));
    return;
  }

  try {
    const loaded = (await import(url)) as { default?: unknown };
    const Artifact = loaded.default;
    if (typeof Artifact !== "function") {
      throw new Error("Artifact modules must default-export a React component.");
    }
    createRoot(root).render(
      createElement(ArtifactErrorBoundary, null, createElement(Artifact as React.ComponentType)),
    );
  } catch (error) {
    // A failed module import reports only a generic fetch failure, so ask the
    // server directly for the diagnostic it already produced.
    const detail = (await serverDiagnostic(url)) ?? messageOf(error);
    createRoot(root).render(failureElement("This artifact could not be compiled or loaded.", detail));
  }
}

/**
 * Recover the server's error body for a module the browser refused to import.
 * Returns undefined when the request succeeded or carried no readable reason.
 */
async function serverDiagnostic(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    if (response.ok) return undefined;
    const body = await response.text();
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      return typeof parsed.error === "string" && parsed.error !== "" ? parsed.error : undefined;
    } catch {
      return body.trim() === "" ? undefined : body.trim();
    }
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
