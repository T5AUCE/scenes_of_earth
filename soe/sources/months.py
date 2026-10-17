"""Month arithmetic on 'YYYY-MM' strings."""


def month_list(start: str, end: str) -> list[str]:
    """'YYYY-MM' strings from start to end inclusive."""
    year, month = int(start[:4]), int(start[5:7])
    months = []
    while f"{year:04d}-{month:02d}" <= end:
        months.append(f"{year:04d}-{month:02d}")
        year, month = next_month(year, month)
    return months


def next_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


def previous_month(year: int, month: int) -> tuple[int, int]:
    return (year - 1, 12) if month == 1 else (year, month - 1)
