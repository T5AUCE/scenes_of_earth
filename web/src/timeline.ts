const PLAY_MS = 700;

export const unionTimes = (axes: string[][]) => [...new Set(axes.flat())].sort();

// Index of the last value at or before t, or -1 when t lies outside the axis.
export function stepAt(values: string[], t: string) {
  if (!values.length || t < values[0] || t > values[values.length - 1]) return -1;

  let index = 0;
  while (index + 1 < values.length && values[index + 1] <= t) index++;
  return index;
}

// Shows only as much of the date as the finest step needs.
export function formatTime(t: string, steps: string[]) {
  if (steps.some((s) => s.endsWith("D") || s.endsWith("W"))) return t;
  if (steps.some((s) => s.endsWith("M"))) return t.slice(0, 7);
  return t.slice(0, 4);
}

export function createTimeline(times: string[], steps: string[], onChange: (t: string) => void) {
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
    const t = times[Number(slider.value)];
    label.textContent = formatTime(t, steps);
    onChange(t);
  };
  slider.oninput = () => {
    stop();
    show();
  };
  play.onclick = () => {
    if (timer !== undefined) return stop();

    play.textContent = "Pause";
    timer = setInterval(() => {
      slider.value = String((Number(slider.value) + 1) % times.length);
      show();
    }, PLAY_MS);
  };

  show();
  return { element, destroy: stop };
}
