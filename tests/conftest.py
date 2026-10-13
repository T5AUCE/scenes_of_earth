"""Shared test helpers: a real-mode source that reads synthetic data (no network)."""
import pytest

from soe.sources import RealSource, SourceUnavailable, SyntheticSource


class RevisionSource(RealSource):
    """A real-mode backend (so revisions are stored) that reads synthetic data and no network."""

    def __init__(self):
        super().__init__(latest="2026-08")
        self.data = SyntheticSource()
        self.revision = "first"
        self.down = False
        self.revision_calls = 0

    def current_revision(self, month):
        self.revision_calls += 1
        if self.down:
            raise SourceUnavailable("down")
        return self.revision

    def read_rain(self, month, window):
        return self.data.read_rain(month, window)

    def terrain(self, bounds, res):
        return self.data.terrain(bounds, res)


@pytest.fixture
def revision_source():
    return RevisionSource()
