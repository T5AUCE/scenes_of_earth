/** Creates an element holding text, appended to parent when given. */
export function makeHtmlElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  parent?: HTMLElement,
) {
  const element = document.createElement(tag);
  element.textContent = text;
  parent?.append(element);
  return element;
}
