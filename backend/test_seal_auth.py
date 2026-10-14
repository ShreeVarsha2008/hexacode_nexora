import unittest

import seal_auth as sa

KEYS = {"SEAL-001": "a" * 64, "SEAL-002": "b" * 64}
NOW = 1_700_000_000


def fresh():
    return sa.NonceStore()


def make_event(seal="SEAL-001", **extra):
    ev = {"seal_id": seal, "type": "checkpoint", "lat": 13.08, "lng": 80.27}
    ev.update(extra)
    return sa.sign_event(ev, KEYS[seal], now=NOW)


class SealAuthTests(unittest.TestCase):
    def test_valid_event_accepted(self):
        ok, reason = sa.verify_event(make_event(), KEYS, fresh(), now=NOW)
        self.assertTrue(ok)
        self.assertEqual(reason, "ok")

    def test_tampered_field_rejected(self):
        ev = make_event()
        ev["lat"] = 28.61
        ok, reason = sa.verify_event(ev, KEYS, fresh(), now=NOW)
        self.assertFalse(ok)
        self.assertEqual(reason, "bad_signature")

    def test_added_field_rejected(self):
        ev = make_event()
        ev["tamper"] = True
        ok, reason = sa.verify_event(ev, KEYS, fresh(), now=NOW)
        self.assertEqual((ok, reason), (False, "bad_signature"))

    def test_wrong_key_rejected(self):
        ev = sa.sign_event({"seal_id": "SEAL-001", "type": "x"}, KEYS["SEAL-002"], now=NOW)
        ok, reason = sa.verify_event(ev, KEYS, fresh(), now=NOW)
        self.assertEqual((ok, reason), (False, "bad_signature"))

    def test_seal_cannot_pose_as_another(self):
        ev = make_event("SEAL-001")
        ev["seal_id"] = "SEAL-002"
        ok, reason = sa.verify_event(ev, KEYS, fresh(), now=NOW)
        self.assertEqual((ok, reason), (False, "bad_signature"))

    def test_unknown_seal_rejected(self):
        ev = sa.sign_event({"seal_id": "SEAL-999"}, "c" * 64, now=NOW)
        ok, reason = sa.verify_event(ev, KEYS, fresh(), now=NOW)
        self.assertEqual((ok, reason), (False, "unknown_seal"))

    def test_replay_rejected(self):
        store = fresh()
        ev = make_event()
        self.assertTrue(sa.verify_event(ev, KEYS, store, now=NOW)[0])
        ok, reason = sa.verify_event(ev, KEYS, store, now=NOW + 1)
        self.assertEqual((ok, reason), (False, "replay"))

    def test_stale_and_future_rejected(self):
        ev = make_event()
        self.assertEqual(sa.verify_event(ev, KEYS, fresh(), now=NOW + 61)[1], "stale")
        self.assertEqual(sa.verify_event(ev, KEYS, fresh(), now=NOW - 61)[1], "stale")

    def test_within_skew_accepted(self):
        ok, _ = sa.verify_event(make_event(), KEYS, fresh(), now=NOW + 59)
        self.assertTrue(ok)

    def test_missing_fields_rejected(self):
        ev = make_event()
        for field in ("signature", "nonce", "timestamp", "seal_id"):
            bad = {k: v for k, v in ev.items() if k != field}
            self.assertEqual(sa.verify_event(bad, KEYS, fresh(), now=NOW)[1], "malformed")
        self.assertEqual(sa.verify_event("nope", KEYS, fresh(), now=NOW)[1], "malformed")

    def test_bad_timestamp_rejected(self):
        ev = make_event()
        ev["timestamp"] = "yesterday"
        self.assertEqual(sa.verify_event(ev, KEYS, fresh(), now=NOW)[1], "bad_timestamp")

    def test_forged_request_does_not_burn_nonce(self):
        store = fresh()
        good = make_event()
        forged = dict(good, signature="0" * 64)
        self.assertFalse(sa.verify_event(forged, KEYS, store, now=NOW)[0])
        self.assertTrue(sa.verify_event(good, KEYS, store, now=NOW)[0])

    def test_nonce_forgotten_after_ttl(self):
        store = sa.NonceStore(ttl=300)
        self.assertTrue(store.check_and_add("SEAL-001", "n1", NOW))
        self.assertFalse(store.check_and_add("SEAL-001", "n1", NOW + 10))
        self.assertTrue(store.check_and_add("SEAL-001", "n1", NOW + 400))

    def test_same_nonce_different_seals_ok(self):
        store = sa.NonceStore()
        self.assertTrue(store.check_and_add("SEAL-001", "n", NOW))
        self.assertTrue(store.check_and_add("SEAL-002", "n", NOW))

    def test_generated_keys_unique_and_long(self):
        a, b = sa.generate_key(), sa.generate_key()
        self.assertNotEqual(a, b)
        self.assertEqual(len(a), 64)

    def test_signature_survives_json_roundtrip(self):
        import json
        ev = json.loads(json.dumps(make_event()))
        self.assertTrue(sa.verify_event(ev, KEYS, fresh(), now=NOW)[0])


if __name__ == "__main__":
    unittest.main()
