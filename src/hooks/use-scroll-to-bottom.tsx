import { useCallback, useEffect, useRef, type RefObject } from "react";

/** Follow content changes while busy and near the bottom; pause when the user scrolls away and resume after returning. */
export function useScroll<T extends HTMLElement>(followChanges = false): [
  RefObject<T | null>,
  (element: HTMLElement) => void,
] {
  const containerRef = useRef<T>(null);
  const following = useRef(true);

  const scrollToElement = useCallback((element: HTMLElement) => {
    following.current = true;
    element.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
  }, []);

  useEffect(() => {
    const container = containerRef.current;

    if (container && followChanges) {
      let frame = 0;
      const onScroll = () => {
        following.current = container.scrollHeight - container.clientHeight - container.scrollTop < 64;
      };
      onScroll();
      container.addEventListener("scroll", onScroll, { passive: true });
      const observer = new MutationObserver(() => {
        if (!following.current) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (following.current) container.scrollTop = container.scrollHeight;
        });
      });

      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        container.removeEventListener("scroll", onScroll);
      };
    }
  }, [followChanges]);

  return [containerRef, scrollToElement];
}
