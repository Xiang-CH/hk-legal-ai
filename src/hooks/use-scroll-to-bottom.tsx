import { useEffect, useRef, type RefObject } from "react";

export function useScroll<T extends HTMLElement>(): [
  RefObject<T | null>,
  (element: HTMLElement) => void,
] {
  const containerRef = useRef<T>(null);

  const scrollToElement = (element: HTMLElement) => {
    element.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
  };

  useEffect(() => {
    const container = containerRef.current;

    if (container) {
      const observer = new MutationObserver(() => {
        // No direct scrolling here, scrolling is handled by scrollToElement
      });

      observer.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      return () => observer.disconnect();
    }
  }, []);

  return [containerRef, scrollToElement];
}
