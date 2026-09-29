import textwrap

import pytest

from csv_stats import column_stats, load_rows, row_count


@pytest.fixture
def sample_csv(tmp_path):
    p = tmp_path / "sample.csv"
    p.write_text(textwrap.dedent("""\
        name,age,score
        ann,30,88.5
        bob,25,
        cat,41,70
    """))
    return p


def test_row_count_excludes_header(sample_csv):
    _, rows = load_rows(sample_csv)
    assert row_count(rows) == 3


def test_full_numeric_column(sample_csv):
    _, rows = load_rows(sample_csv)
    stats = column_stats(rows, "age")
    assert stats["count"] == 3
    assert stats["min"] == 25
    assert stats["max"] == 41
    assert stats["mean"] == pytest.approx(32.0)


def test_empty_cells_are_skipped(sample_csv):
    _, rows = load_rows(sample_csv)
    stats = column_stats(rows, "score")
    assert stats["count"] == 2
    assert stats["mean"] == pytest.approx(79.25)


def test_non_numeric_column_raises(sample_csv):
    _, rows = load_rows(sample_csv)
    with pytest.raises(ValueError):
        column_stats(rows, "name")
