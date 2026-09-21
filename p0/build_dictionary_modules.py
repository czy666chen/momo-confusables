"""Copy private ECDICT shards into protected Workers static assets."""

from pathlib import Path

root = Path(__file__).resolve().parent.parent
source = root / "p0" / "private" / "dictionary-shards"
target = root / "public" / "dictionary"
if not source.exists():
    raise SystemExit("Run python p0/build_dictionary_shards.py first")
target.mkdir(exist_ok=True)
for old in target.glob("*"):
    if old.is_file():
        old.unlink()
for shard in source.glob("*.json"):
    (target / shard.name).write_bytes(shard.read_bytes())
print(f"Generated {len(list(target.glob('*.json')))} protected dictionary assets")
