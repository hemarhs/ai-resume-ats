"""
Tiny dependency-free embedder used only if SentenceTransformer can't load
(e.g. first run with no internet to download the model).

Hashed bag of words + character trigrams → L2-normalised vector.
Same `.encode()` interface as SentenceTransformer, so nothing else changes.
"""
import hashlib
import re
from typing import List, Union

import numpy as np

_DIM = 1024


def _features(text: str) -> List[str]:
    text = text.lower()
    words = re.findall(r'[a-z0-9+#.]+', text)
    feats = words[:]
    for w in words:
        padded = f'#{w}#'
        feats.extend(padded[i:i + 3] for i in range(len(padded) - 2))
    return feats


class HashingEmbedder:
    name = 'hashing-fallback'

    def _one(self, text: str) -> np.ndarray:
        vec = np.zeros(_DIM, dtype=np.float32)
        for f in _features(text or ''):
            h = int(hashlib.md5(f.encode()).hexdigest(), 16)
            vec[h % _DIM] += 1.0 if (h >> 20) & 1 else -1.0
        n = np.linalg.norm(vec)
        return vec / n if n else vec

    def encode(self, texts: Union[str, List[str]], convert_to_tensor: bool = False, **_):
        if isinstance(texts, str):
            return self._one(texts)
        return np.stack([self._one(t) for t in texts]) if texts else np.zeros((0, _DIM), dtype=np.float32)
