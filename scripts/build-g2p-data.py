"""Offline G2P for a private missing-word list. Never writes to public/ or dist/."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import unicodedata

# Small matrix inference is faster and reproducible with one BLAS thread.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data" / "g2p"))
MODEL_VERSION = "g2p-en-2.1.0-checkpoint20"
MODEL_SHA256 = "b8af35e4596d8dd5836dfd3fe9b2ba4f97b9c311efe8879544cbcfcbd566d8c6"
DICTIONARY_VERSION = "74790861f652b15e4ac49015a90074ad62a27690"
DICTIONARY_SHA256 = "81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22"
PIPELINE_VERSION = "g2p-private-v1"
VOWELS = set("AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW".split())
CONSONANTS = set("B CH D DH F G HH JH K L M N NG P R S SH T TH V W Y Z ZH".split())


def normalize(word):
    word = unicodedata.normalize("NFKC", word).strip().lower().replace("’", "'").replace("‘", "'")
    return re.sub(r"\s*-\s*", "-", word)


def encode(tokens):
    phones, stress = [], []
    if not tokens:
        raise ValueError("empty prediction")
    for token in tokens:
        match = re.fullmatch(r"([A-Z]+)([012]?)", token)
        if not match:
            raise ValueError("invalid phoneme")
        phone, accent = match.groups()
        if not ((phone in VOWELS and accent) or (phone in CONSONANTS and not accent)):
            raise ValueError("invalid ARPAbet/stress")
        phones.append(phone)
        stress.append(accent or "-")
    return [" ".join(phones), "".join(stress)]


def predict_words(words, predict, dictionary):
    entries, failures = {}, []
    for word in words:
        try:
            # The neural alphabet has no punctuation. Predict components separately;
            # preserve the original lookup key and label the entire result predicted.
            tokens = []
            for part in re.split("['-]", word):
                tokens.extend(dictionary.get(part) or predict(part))
            entries[word] = [encode(tokens)]
        except (ValueError, RuntimeError, FloatingPointError):
            failures.append(word)
    return entries, failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path, default=ROOT / "p0/private/pronunciation-missing.txt")
    args = parser.parse_args()
    words = sorted(set(normalize(line) for line in args.input.read_text(encoding="utf-8-sig").splitlines() if line.strip()))
    if not words or any(not re.fullmatch("[a-z]+(?:['-][a-z]+)*", word) or len(word) > 100 for word in words):
        raise ValueError("Input must contain non-empty English words, one per line (maximum 100 letters)")
    dictionary = {}
    dictionary_bytes = (ROOT / "data/cmudict/cmudict.dict").read_bytes()
    if hashlib.sha256(dictionary_bytes).hexdigest() != DICTIONARY_SHA256:
        raise ValueError("CMUdict checksum mismatch")
    for line in dictionary_bytes.decode("utf-8").splitlines():
        fields = line.split("#", 1)[0].split()
        if fields and not fields[0].startswith(";;;"):
            dictionary.setdefault(re.sub(r"\(\d+\)$", "", fields[0]).lower(), fields[1:])
    words = [word for word in words if word not in dictionary]
    model_path = ROOT / "data/g2p/checkpoint20.npz"
    if hashlib.sha256(model_path.read_bytes()).hexdigest() != MODEL_SHA256:
        raise ValueError("G2P checkpoint checksum mismatch")
    from inference import G2p
    model = G2p()
    entries, failures = predict_words(words, model.predict, dictionary)
    asset = {
        "schemaVersion": 1, "source": "prediction", "dictionaryVersion": DICTIONARY_VERSION,
        "scoringVersion": "phoneme-unit-edit-v1", "pipelineVersion": PIPELINE_VERSION,
        "modelVersion": MODEL_VERSION, "modelSha256": MODEL_SHA256,
        "entries": entries,
    }
    payload = json.dumps(asset, ensure_ascii=False, separators=(",", ":"))
    version = hashlib.sha256(payload.encode()).hexdigest()
    output_dir = ROOT / "p0/private"
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / f"pronunciation-predictions-{version[:16]}.json"
    temporary = output.with_suffix(".tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(output)
    report = {"modelVersion": MODEL_VERSION, "modelSha256": MODEL_SHA256, "assetSha256": version,
              "requested": len(words), "predicted": len(entries), "failed": len(failures),
              "failedWords": failures, "output": str(output.relative_to(ROOT))}
    (output_dir / "pronunciation-g2p-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "failedWords"}))
    if failures:
        sys.exit(1)  # Partial output remains usable, but the build is never reported as complete.


if __name__ == "__main__":
    main()
