// The option that arrow keys move to; -1 means none is active yet. Moves wrap around.
export function nextOptionIndex(key: string, current: number, count: number) {
  if (!count) return -1;
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return current <= 0 ? count - 1 : current - 1;

  return current;
}
