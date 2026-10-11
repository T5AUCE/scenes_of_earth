const PLAY_INTERVAL_MS = 700;

export const unionTimes = (axes: string[][]) => [...new Set(axes.flat())].sort();

// Index of the last value at or before time, or -1 when time lies outside the axis.
export function stepAt(values: string[], time: string) {
  const isOutsideAxis = !values.length || time < values[0] || time > values[values.length - 1];
  if (isOutsideAxis) return -1;

  let index = 0;
  while (index + 1 < values.length && values[index + 1] <= time) index++;

  return index;
}

// Shows only as much of the date as the finest step needs.
export function formatTime(time: string, steps: string[]) {
  if (steps.some((step) => step.endsWith("D") || step.endsWith("W"))) return time;
  if (steps.some((step) => step.endsWith("M"))) return time.slice(0, 7);

  return time.slice(0, 4);
}

// Only the latest queued value runs, so scrubbing skips stale steps; the task must catch errors.
export function latestOnly<T>(task: (value: T) => Promise<void>) {
  let waiting: { value: T } | null = null;
  let isRunning = false;

  return async (value: T) => {
    waiting = { value };
    if (isRunning) return;

    isRunning = true;
    try {
      while (waiting) {
        const { value: latest } = waiting;
        waiting = null;
        await task(latest);
      }
    } finally {
      isRunning = false;
    }
  };
}

export function createTimeline(
  times: string[],
  steps: string[],
  onChange: (time: string) => void,
) {
  const element = document.createElement("div");
  element.className = "timeline";

  const play = document.createElement("button");
  play.textContent = "Play";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(times.length - 1);
  slider.value = "0";

  const label = document.createElement("span");
  element.append(play, slider, label);

  let timer: number | undefined;

  const stop = () => {
    clearInterval(timer);
    timer = undefined;
    play.textContent = "Play";
  };

  const show = () => {
    const time = times[Number(slider.value)];
    label.textContent = formatTime(time, steps);
    onChange(time);
  };

  const advance = () => {
    slider.value = String((Number(slider.value) + 1) % times.length);
    show();
  };

  slider.oninput = () => {
    stop();
    show();
  };

  play.onclick = () => {
    if (timer !== undefined) return stop();

    play.textContent = "Pause";
    timer = setInterval(advance, PLAY_INTERVAL_MS);
  };

  show();

  return { element, destroy: stop };
}
