"""Build private ECDICT shards for the Worker R2 binding."""

import csv
import json
from pathlib import Path

root = Path(__file__).resolve().parent
output = root / "private" / "dictionary-shards"
output.mkdir(parents=True, exist_ok=True)
shards = {chr(code): {} for code in range(ord("a"), ord("z") + 1)}
shards["_"] = {}
with (root / "ecdict.csv").open(encoding="utf-8-sig", newline="") as source:
    for row in csv.DictReader(source):
        word = (row.get("word") or "").strip().lower()
        meaning = (row.get("translation") or "").strip()
        if not word or not any("\u3400" <= char <= "\u9fff" for char in meaning):
            continue
        key = word[0] if "a" <= word[0] <= "z" else "_"
        shards[key][word] = meaning
for key, words in shards.items():
    (output / f"{key}.json").write_text(json.dumps(words, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(json.dumps({"shards": len(shards), "entries": sum(map(len, shards.values()))}))
