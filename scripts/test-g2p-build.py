"""Offline model and failure-path regression; contains no private vocabulary."""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("builder", Path(__file__).with_name("build-g2p-data.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuildTests(unittest.TestCase):
    def test_normalization(self):
        self.assertEqual(builder.normalize("  Mother - IN - law  "), "mother-in-law")
        self.assertEqual(builder.normalize("DON’T"), "don't")

    def test_model_failure_and_invalid_output_are_missing(self):
        def predict(word):
            if word == "failed":
                raise RuntimeError("model failed")
            return {"empty": [], "invalid": ["<unk>"], "unstressed": ["UW"], "good": ["G", "UH1", "D"]}[word]
        entries, failed = builder.predict_words(["empty", "failed", "invalid", "unstressed", "good"], predict, {})
        self.assertEqual(list(entries), ["good"])
        self.assertEqual(failed, ["empty", "failed", "invalid", "unstressed"])
        self.assertEqual(entries["good"], [["G UH D", "-1-"]])

    def test_compounds_preserve_key_and_use_dictionary_parts(self):
        entries, failed = builder.predict_words(["cat-like"], lambda word: ["L", "AY1", "K"], {"cat": ["K", "AE1", "T"]})
        self.assertFalse(failed)
        self.assertEqual(entries["cat-like"], [["K AE T L AY K", "-1--1-"]])

    def test_pinned_neural_model_smoke(self):
        self.assertEqual(hashlib.sha256((builder.ROOT / "data/g2p/checkpoint20.npz").read_bytes()).hexdigest(), builder.MODEL_SHA256)
        from inference import G2p
        model = G2p()
        self.assertEqual(model.predict("cat"), ["K", "AE1", "T"])
        self.assertEqual(model.predict("ship"), ["SH", "IH1", "P"])
        first = builder.predict_words(["flourz", "zorbulate"], model.predict, {})
        self.assertFalse(first[1])
        self.assertEqual(first, builder.predict_words(["flourz", "zorbulate"], model.predict, {}))
        # Public regression samples are a smoke check, not an independent accuracy set.
        dictionary = {}
        for line in (builder.ROOT / "data/cmudict/cmudict.dict").read_text(encoding="utf-8").splitlines():
            fields = line.split("#", 1)[0].split()
            if fields:
                dictionary.setdefault(fields[0].split("(")[0], []).append(fields[1:])
        samples = json.loads((builder.ROOT / "data/pronunciation-samples.json").read_text(encoding="utf-8"))
        words = sorted({pair[key] for pair in samples for key in ["left", "right"] if pair[key] in dictionary})
        mismatches = []
        for word in words:
            tokens = model.predict(word)
            builder.encode(tokens)
            if tokens not in dictionary[word]:
                mismatches.append(word)
        print(json.dumps({"publicSmokeWords": len(words), "exactVariantMatches": len(words) - len(mismatches), "mismatches": mismatches}))


if __name__ == "__main__":
    unittest.main()
