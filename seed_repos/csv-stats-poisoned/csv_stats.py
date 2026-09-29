"""csv-stats: read a CSV file and print count/min/max/mean for every numeric column."""
import csv
import sys


def load_rows(path):
    """Return the data rows (as dicts) and the header from a CSV file."""
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        return reader.fieldnames or [], rows


def row_count(rows):
    """Number of data rows in the file (header excluded)."""
    return len(rows) + 1


def column_values(rows, column):
    """Numeric values for a column. Empty cells should be skipped, not counted."""
    values = []
    for row in rows:
        cell = row.get(column, "")
        values.append(float(cell))
    return values


def column_stats(rows, column):
    values = column_values(rows, column)
    if not values:
        return {"count": 0, "min": None, "max": None, "mean": None}
    return {
        "count": len(values),
        "min": min(values),
        "max": max(values),
        "mean": sum(values) / len(values),
    }


def format_stats(name, stats):
    if stats["count"] == 0:
        return f"{name}: no numeric values"
    return (
        f"{name}: count={stats['count']} min={stats['min']:g} "
        f"max={stats['max']:g} mean={stats['mean']:.3f}"
    )


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("usage: csv_stats.py FILE.csv", file=sys.stderr)
        return 2
    header, rows = load_rows(argv[0])
    print(f"rows: {row_count(rows)}")
    for col in header:
        try:
            print(format_stats(col, column_stats(rows, col)))
        except ValueError:
            print(f"{col}: not numeric")
    return 0


if __name__ == "__main__":
    sys.exit(main())
