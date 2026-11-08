/** Submit and poll scene jobs while the panel owns cancellation and entry coordination. */
import { ApiError, getSceneStatus, postScene } from "./api";
import type { SceneRequest, SceneStatus } from "./types";

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_FAILURES = 3;
const DEFAULT_RETRY_SECS = 30;
const MS_PER_SECOND = 1000;

const SERVER_BUSY = 503;
const NOT_FOUND = 404;

/** Submit once with the existing retry policy and return null when the panel run is stale. */
export async function submitAndPoll(
  captureRequest: () => SceneRequest,
  isCurrent: () => boolean,
  showStatus: (text: string) => void,
): Promise<SceneStatus | null> {
  const submitted = await submit(captureRequest, isCurrent, showStatus);
  if (!submitted || !isCurrent()) return null;

  let current = submitted;
  let failures = 0;

  while (current.status === "queued" || current.status === "running") {
    showProgress(current, showStatus);
    await wait(POLL_INTERVAL_MS);
    if (!isCurrent()) return null;

    try {
      current = await getSceneStatus(current.id);
      failures = 0;
    } catch (error) {
      const isMissing = error instanceof ApiError && error.status === NOT_FOUND;
      if (isMissing || ++failures >= MAX_POLL_FAILURES) throw error;
    }
  }

  return isCurrent() ? current : null;
}

// The same captured request must be reused for the single automatic busy-server retry.
async function submit(
  captureRequest: () => SceneRequest,
  isCurrent: () => boolean,
  showStatus: (text: string) => void,
): Promise<SceneStatus | null> {
  const body = captureRequest();

  try {
    return await postScene(body);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== SERVER_BUSY) throw error;
    if (!isCurrent()) return null;

    const retrySeconds = error.retryAfterSecs ?? DEFAULT_RETRY_SECS;
    showStatus(`${error.message} Retrying in ${retrySeconds} s…`);
    await wait(retrySeconds * MS_PER_SECOND);

    return isCurrent() ? postScene(body) : null;
  }
}

function showProgress(sceneStatus: SceneStatus, showStatus: (text: string) => void) {
  if (sceneStatus.status !== "running") {
    showStatus(`Scene ${sceneStatus.status}…`);
    return;
  }

  const percent = Math.round(sceneStatus.progress * 100);
  showStatus(sceneStatus.stage
    ? `Building… ${percent}% (${sceneStatus.stage})`
    : `Building… ${percent}%`);
}

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
