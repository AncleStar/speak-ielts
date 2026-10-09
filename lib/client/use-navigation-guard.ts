"use client";
import { useEffect } from "react";

/** Next links do not unload the document, so unsaved work needs its own warning. */
export function useNavigationGuard(active: boolean, message: string) {
  useEffect(() => {
    if (!active) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
      const target = new URL(anchor.href, window.location.href);
      // Full document navigations already trigger beforeunload. Hash changes keep the editor.
      if (target.origin !== window.location.origin || (target.pathname === location.pathname && target.search === location.search)) return;
      if (!window.confirm(message)) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [active, message]);
}
