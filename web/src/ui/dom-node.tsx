/** Mount a DOM node built outside React and move it when the host changes. */
import { useLayoutEffect, useRef } from "react";

interface DomNodeProps {
  node: HTMLElement | null;
  className?: string;
}

/** Hold a node owned by the map renderers, such as a legend or a menu section. */
export function DomNode({ node, className }: DomNodeProps): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !node) return;

    element.replaceChildren(node);

    return () => {
      node.remove();
    };
  }, [node]);

  return <div ref={host} className={className} />;
}
