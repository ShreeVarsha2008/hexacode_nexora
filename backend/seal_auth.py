"""
seal_auth.py - per-seal event signing and verification (HMAC-SHA256).

Each seal has its own secret key. Every event a seal sends carries:
    seal_id, signed_at (unix seconds), nonce, signature
The server recomputes the signature with that seal's key and rejects the
event if it does not match, is too old / too far in the future, or reuses
a nonce.

signed_at is the moment of SENDING. It is separate from any event
'timestamp' field, which is event data and is left untouched. Sign every
send, including re-sends of the same event, so each send gets a fresh nonce.

Keys are NEVER stored in the repo. They come from the environment:
    SEAL_KEYS='{"SEAL-001": "<hex key>", "SEAL-002": "<hex key>"}'
or from a local file named by SEAL_KEYS_FILE (JSON, same shape). Put that
file outside the repo or in .gitignore.

Generate keys:
    python seal_auth.py gen SEAL-001 SEAL-002 SEAL-003
"""

import hashlib
import hmac
import json
import os
import secrets
import sys
import threading
import time

SIGNED_FIELDS = ("seal_id", "signed_at", "nonce")
SIGNATURE_FIELD = "signature"
MAX_SKEW_SECONDS = 60          # allowed clock difference between seal and server
NONCE_TTL_SECONDS = 300        # how long a nonce is remembered (must be > 2 * skew)


# ---------------------------------------------------------------- keys

def generate_key():
    """Return a new random 256-bit key as a 64-character hex string."""
    return secrets.token_hex(32)


def load_keys():
    """Load {seal_id: key} from SEAL_KEYS (JSON) or the file in SEAL_KEYS_FILE."""
    raw = os.environ.get("SEAL_KEYS")
    if not raw:
        path = os.environ.get("SEAL_KEYS_FILE")
        if path and os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                raw = f.read()
    if not raw:
        return {}
    keys = json.loads(raw)
    if not isinstance(keys, dict):
        raise ValueError("SEAL_KEYS must be a JSON object of seal_id -> key")
    return keys


# ------------------------------------------------------------- signing

def _canonical_bytes(event):
    """
    Deterministic byte string that gets signed: every field of the event
    except the signature itself, as sorted-key compact JSON. Signing the
    whole event (not a hand-picked subset) means changing ANY field breaks
    the signature.
    """
    body = {k: v for k, v in event.items() if k != SIGNATURE_FIELD}
    return json.dumps(body, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True).encode("utf-8")


def sign_event(event, key, now=None):
    """
    Return a copy of `event` with timestamp, nonce and signature added.
    `event` must already contain seal_id.
    """
    if "seal_id" not in event:
        raise ValueError("event needs a seal_id before signing")
    signed = dict(event)
    signed["signed_at"] = int(time.time() if now is None else now)
    signed["nonce"] = secrets.token_hex(16)
    mac = hmac.new(key.encode("utf-8"), _canonical_bytes(signed), hashlib.sha256)
    signed[SIGNATURE_FIELD] = mac.hexdigest()
    return signed


# --------------------------------------------------------- verification

class NonceStore:
    """In-memory replay protection. Thread-safe; forgets nonces after the TTL."""

    def __init__(self, ttl=NONCE_TTL_SECONDS):
        self.ttl = ttl
        self._seen = {}
        self._lock = threading.Lock()

    def check_and_add(self, seal_id, nonce, now):
        """Return True if the nonce is new (and remember it), False if reused."""
        with self._lock:
            cutoff = now - self.ttl
            for k in [k for k, t in self._seen.items() if t < cutoff]:
                del self._seen[k]
            key = (seal_id, nonce)
            if key in self._seen:
                return False
            self._seen[key] = now
            return True


def verify_event(event, keys, nonce_store, now=None, max_skew=MAX_SKEW_SECONDS):
    """
    Check one incoming event. Returns (ok, reason).
    `reason` is "ok" on success, otherwise a short machine-readable code:
    malformed, unknown_seal, bad_timestamp, stale, bad_signature, replay.
    """
    now = time.time() if now is None else now

    if not isinstance(event, dict):
        return False, "malformed"
    for field in SIGNED_FIELDS + (SIGNATURE_FIELD,):
        if field not in event:
            return False, "malformed"

    seal_id = event["seal_id"]
    key = keys.get(seal_id)
    if key is None:
        return False, "unknown_seal"

    try:
        ts = float(event["signed_at"])
    except (TypeError, ValueError):
        return False, "bad_timestamp"
    if abs(now - ts) > max_skew:
        return False, "stale"

    expected = hmac.new(key.encode("utf-8"), _canonical_bytes(event),
                        hashlib.sha256).hexdigest()
    provided = str(event[SIGNATURE_FIELD])
    if not hmac.compare_digest(expected, provided):
        return False, "bad_signature"

    # Only record the nonce AFTER the signature checks out, so forged
    # requests cannot fill the store.
    if not nonce_store.check_and_add(seal_id, event["nonce"], now):
        return False, "replay"

    return True, "ok"


# ----------------------------------------------------------------- CLI

if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "gen":
        print(json.dumps({sid: generate_key() for sid in sys.argv[2:]}, indent=2))
        print("\nSave this OUTSIDE the repo (or in a git-ignored file) and share it "
              "with teammates over chat, not git.", file=sys.stderr)
    else:
        print("usage: python seal_auth.py gen SEAL-001 SEAL-002 ...")
