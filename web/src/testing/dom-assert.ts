/** Assertions whose failures stay short because node:assert would print whole DOM graphs. */
import assert from "node:assert/strict";

const DESCRIPTION_LIMIT_CHARS = 40;

/** Compare node identity without letting assertion diffs inspect the DOM graph. */
export function assertSameNode(
  actual: Node | null | undefined,
  expected: Node | null | undefined,
  message?: string,
): void {
  if (actual === expected) return;

  const descriptions = `${describeNode(actual)} !== ${describeNode(expected)}`;
  assert.fail(message ? `${message}: ${descriptions}` : descriptions);
}

function describeNode(node: Node | null | undefined): string {
  if (node == null) return String(node);

  const element = node as Element;
  const id = element.getAttribute?.("id")?.slice(0, DESCRIPTION_LIMIT_CHARS) ?? "";
  const classes = element.getAttribute?.("class")?.slice(0, DESCRIPTION_LIMIT_CHARS) ?? "";
  const text = (node.textContent ?? "").slice(0, DESCRIPTION_LIMIT_CHARS);
  return `${node.nodeName.toLowerCase()} id=${JSON.stringify(id)}`
    + ` class=${JSON.stringify(classes)} text=${JSON.stringify(text)}`;
}
