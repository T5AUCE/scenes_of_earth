/** Remember the viewer's area-name language and pick the displayed name. */

/** The area-name language shown across search and scene titles. */
export type NamePreference = "english" | "local";

/** The browser key holding the area-name language. */
export const NAME_PREFERENCE_KEY = "soe.name-preference.v1";

// The visit's choice when saving failed, so open scenes still match it.
let unsavedPreference: NamePreference | null = null;

/** The viewer's name language for this visit, falling back to English when nothing was saved. */
export function loadNamePreference(): NamePreference {
  if (unsavedPreference) return unsavedPreference;

  try {
    const stored = localStorage.getItem(NAME_PREFERENCE_KEY);
    return stored === "local" || stored === "english" ? stored : "english";
  } catch {
    return "english";
  }
}

/** Remember the viewer's name language for this browser only, never for the share link. */
export function storeNamePreference(preference: NamePreference): void {
  try {
    localStorage.setItem(NAME_PREFERENCE_KEY, preference);
    unsavedPreference = null;
  } catch {
    // Blocked storage must not prevent this visit's display change.
    unsavedPreference = preference;
  }
}

/** Pick the displayed name, falling back to English when the local one is missing. */
export function preferredName(
  english: string,
  local: string | null | undefined,
  preference: NamePreference,
): string {
  return preference === "local" && local ? local : english;
}
