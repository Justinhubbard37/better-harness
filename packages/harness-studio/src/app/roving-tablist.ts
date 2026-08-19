import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Shared WAI-ARIA tabs keyboard behaviour so every Studio tab strip is one Tab
 * stop and Arrow/Home/End move the active tab with focus following selection.
 * Each strip used to ship a partial pattern (role="tab" without roving focus),
 * which the DESIGN.md interaction model forbids.
 */
export interface RovingTablist<T extends string> {
  tablistProps: {
    role: "tablist";
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  };
  getTabProps: (id: T) => {
    ref: (node: HTMLButtonElement | null) => void;
    role: "tab";
    tabIndex: 0 | -1;
    "aria-selected": boolean;
    "aria-controls": string | undefined;
  };
}

export function useRovingTablist<T extends string>(options: {
  ids: readonly T[];
  active: T;
  onSelect: (id: T) => void;
  orientation?: "horizontal" | "vertical";
  panelId?: string;
}): RovingTablist<T> {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const { ids, active, onSelect, panelId } = options;
  const nextKey = options.orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  const previousKey = options.orientation === "vertical" ? "ArrowUp" : "ArrowLeft";

  return {
    tablistProps: {
      role: "tablist",
      onKeyDown: (event) => {
        if (![nextKey, previousKey, "Home", "End"].includes(event.key)) return;
        if (ids.length === 0) return;
        event.preventDefault();
        const current = Math.max(0, ids.indexOf(active));
        const target = event.key === "Home"
          ? 0
          : event.key === "End"
            ? ids.length - 1
            : event.key === nextKey
              ? (current + 1) % ids.length
              : (current - 1 + ids.length) % ids.length;
        const id = ids[target]!;
        onSelect(id);
        globalThis.requestAnimationFrame(() => refs.current.get(id)?.focus());
      },
    },
    getTabProps: (id) => ({
      ref: (node) => { if (node) refs.current.set(id, node); else refs.current.delete(id); },
      role: "tab",
      tabIndex: active === id ? 0 : -1,
      "aria-selected": active === id,
      "aria-controls": panelId,
    }),
  };
}
