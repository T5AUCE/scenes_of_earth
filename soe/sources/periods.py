"""Period arithmetic on ISO dates and ISO 8601 durations (PnY, PnM, PnD)."""
import re
from datetime import date, timedelta

REQUEST_STEP = "P1M"  # granularity of a scene request's start and end

DURATION_PATTERN = re.compile(r"P([0-9]+)([YMD])")
REQUEST_PATTERNS = {
    "P1Y": re.compile(r"[0-9]{4}"),
    "P1M": re.compile(r"[0-9]{4}-(0[1-9]|1[0-2])"),  # ASCII digits only
}
REQUEST_FORMATS = {"P1Y": "YYYY", "P1M": "YYYY-MM"}
FIRST_DAY_TEMPLATE = "0000-01-01"  # its tail completes a short label to the period's first day


def add_duration(iso_date: str, duration: str, sign: int = 1) -> str:
    """The ISO date `duration` after (sign 1) or before (-1) `iso_date`.

    Only whole years, months and days; a month or year step needs the day to exist in the
    target month, which period starts on the 1st always do.
    """
    parsed = DURATION_PATTERN.fullmatch(duration)
    if parsed is None:
        raise ValueError(f"unsupported duration {duration}")

    count, unit = sign * int(parsed[1]), parsed[2]
    start = date.fromisoformat(iso_date)
    if unit == "D":
        return (start + timedelta(days=count)).isoformat()

    months = count * 12 if unit == "Y" else count
    year, month_index = divmod(start.year * 12 + start.month - 1 + months, 12)
    return date(year, month_index + 1, start.day).isoformat()


def is_request_label(value: object, step: str) -> bool:
    """Whether `value` names one request period of `step`, such as 'YYYY-MM' for P1M."""
    pattern = REQUEST_PATTERNS.get(step)
    return pattern is not None and isinstance(value, str) and pattern.fullmatch(value) is not None


def request_range(start: str, end: str, step: str) -> tuple[str, str]:
    """ISO dates (first day, day after the last) of the request periods start..end inclusive."""
    return _period_start(start, step), add_duration(_period_start(end, step), step)


def request_label(iso_date: str, step: str) -> str:
    """The request period holding `iso_date`, such as '2015-06' for P1M."""
    return iso_date[:len(REQUEST_FORMATS[step])]


def _period_start(label: str, step: str) -> str:
    if not is_request_label(label, step):
        raise ValueError(f"{label!r} does not name a {step} period")

    return label + FIRST_DAY_TEMPLATE[len(label):]


def previous_month(year: int, month: int) -> tuple[int, int]:
    return (year - 1, 12) if month == 1 else (year, month - 1)
