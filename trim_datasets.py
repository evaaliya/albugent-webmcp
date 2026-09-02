import sqlite3, os

SRC_DIR = "public/datasets"
MAX_ROWS = 2000  # more than enough rows for a convincing demo

files = ["healthcare.db", "fiction-retail.db", "nyc_taxi_pipeline.db"]

for fname in files:
    src_path = os.path.join(SRC_DIR, fname)
    tmp_path = src_path + ".trimmed"

    if os.path.exists(tmp_path):
        os.remove(tmp_path)

    src = sqlite3.connect(src_path)
    dst = sqlite3.connect(tmp_path)

    tables = [r[0] for r in src.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )]

    for t in tables:
        schema = src.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (t,)
        ).fetchone()[0]
        dst.execute(schema)

        rows = src.execute(f'SELECT * FROM "{t}" LIMIT {MAX_ROWS}').fetchall()
        if rows:
            placeholders = ",".join(["?"] * len(rows[0]))
            dst.executemany(f'INSERT INTO "{t}" VALUES ({placeholders})', rows)

        print(f"{fname}: {t} -> {len(rows)} rows")

    dst.commit()
    src.close()
    dst.close()

    os.replace(tmp_path, src_path)  # overwrite original with trimmed version
    size_mb = os.path.getsize(src_path) / 1024 / 1024
    print(f"{fname}: now {size_mb:.2f} MB\n")
    