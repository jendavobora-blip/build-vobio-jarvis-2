import http.client
import json
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from deepseek_budget_proxy import (
    BudgetError,
    BudgetLedger,
    estimate_cost,
    normalize_request_payload,
    parse_balance,
    parse_usd,
    run_aider,
    start_proxy,
)


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit=-1):
        return self.body


class BudgetProxyTests(unittest.TestCase):
    def test_balance_requires_available_usd_covering_limit(self):
        payload = {
            "is_available": True,
            "balance_infos": [
                {"currency": "USD", "total_balance": "2.00", "granted_balance": "1.50", "topped_up_balance": "0.50"}
            ],
        }
        self.assertEqual(parse_balance(payload, Decimal("0.25")), Decimal("0.50"))
        with self.assertRaises(BudgetError):
            parse_balance(payload, Decimal("0.51"))

    def test_balance_fails_closed_without_usd_balance(self):
        with self.assertRaises(BudgetError):
            parse_balance(
                {"is_available": True, "balance_infos": [{"currency": "CNY", "total_balance": "10"}]}
            )

    def test_limit_requires_positive_finite_usd(self):
        self.assertEqual(parse_usd("0.01"), Decimal("0.01"))
        for value in ("0", "-1", "NaN", "Infinity", "invalid"):
            with self.subTest(value=value), self.assertRaises(BudgetError):
                parse_usd(value)

    def test_request_reserves_for_full_body_and_maximum_output(self):
        payload = {
            "model": "deepseek-flash",
            "messages": [{"role": "user", "content": "test"}],
            "max_tokens": 16,
            "stream": False,
        }
        raw = json.dumps(payload).encode()
        estimate = estimate_cost(raw, payload)
        self.assertGreater(
            estimate,
            Decimal(16) * Decimal("1.20") / Decimal(1_000_000),
        )

    def test_request_rejects_unbounded_or_unsupported_options(self):
        base = {
            "model": "deepseek-flash",
            "messages": [{"role": "user", "content": "test"}],
            "max_tokens": 16,
            "stream": False,
        }
        cases = [
            {**base, "model": "deepseek-reasoner"},
            {**base, "stream": True},
            {**base, "n": 2},
            {**base, "n": True},
            {**base, "max_tokens": 0},
            {**base, "max_tokens": True},
            {**base, "max_completion_tokens": 0},
        ]
        for payload in cases:
            with self.subTest(payload=payload), self.assertRaises(BudgetError):
                estimate_cost(json.dumps(payload).encode(), payload)

    def test_request_clamps_aider_output_to_the_proxy_limit(self):
        base = {
            "model": "deepseek/deepseek-flash",
            "messages": [{"role": "user", "content": "test"}],
            "stream": False,
        }
        cases = [
            ({**base, "max_tokens": 16_384}, 4096),
            ({**base, "max_completion_tokens": 16_384}, 4096),
            ({**base, "max_tokens": 16, "max_completion_tokens": 8_192}, 16),
            (base, 4096),
        ]
        for payload, expected in cases:
            with self.subTest(payload=payload):
                normalized = normalize_request_payload(payload)
                self.assertEqual(normalized["max_tokens"], expected)
                self.assertNotIn("max_completion_tokens", normalized)
                self.assertGreater(
                    estimate_cost(json.dumps(payload).encode(), payload),
                    Decimal(expected) * Decimal("1.20") / Decimal(1_000_000),
                )

    def test_reservations_stop_concurrent_calls_from_exceeding_limit(self):
        ledger = BudgetLedger(Decimal("0.01"))
        ledger.reserve(Decimal("0.006"))
        with self.assertRaises(BudgetError):
            ledger.reserve(Decimal("0.005"))
        snapshot = ledger.snapshot()
        self.assertEqual(snapshot["denied_calls"], 1)
        self.assertTrue(snapshot["blocked"])

    def test_failed_calls_consume_their_worst_case_reservation(self):
        ledger = BudgetLedger(Decimal("0.01"))
        reservation_id = ledger.reserve(Decimal("0.004"))
        ledger.settle(reservation_id, Decimal("0.004"), failed=True)
        snapshot = ledger.snapshot()
        self.assertTrue(snapshot["failed"])
        self.assertTrue(snapshot["all_reservations_settled"])
        with self.assertRaises(BudgetError):
            ledger.reserve(Decimal("0.007"))

    def test_programmer_run_without_api_calls_is_failed_and_audited(self):
        with tempfile.TemporaryDirectory() as directory:
            audit_path = Path(directory) / "audit.json"
            result = run_aider(
                Decimal("0.01"),
                "provider-secret",
                audit_path,
                [sys.executable, "-c", "pass"],
            )
            audit = json.loads(audit_path.read_text())
        self.assertEqual(result, 1)
        self.assertEqual(audit["api_calls"], 0)
        self.assertTrue(audit["failed"])

    def test_proxy_forwards_only_authorized_requests_and_tracks_usage(self):
        server, _thread = start_proxy(Decimal("0.01"), "provider-secret", "local-token")
        ledger = server.ledger
        response_body = json.dumps({
            "choices": [{"message": {"content": "OK"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 2},
        }).encode()
        try:
            with patch("deepseek_budget_proxy.urllib.request.urlopen", return_value=FakeResponse(response_body)) as upstream:
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
                body = json.dumps({
                    "model": "deepseek/deepseek-flash",
                    "messages": [{"role": "user", "content": "test"}],
                    "max_tokens": 16,
                    "stream": False,
                })
                connection.request(
                    "POST",
                    "/chat/completions",
                    body,
                    {"Authorization": "Bearer local-token", "Content-Type": "application/json"},
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), json.loads(response_body))
                connection.close()

            forwarded = upstream.call_args.args[0]
            self.assertEqual(forwarded.full_url, "https://api.deepseek.com/chat/completions")
            self.assertEqual(forwarded.get_header("Authorization"), "Bearer provider-secret")
            self.assertEqual(json.loads(forwarded.data)["model"], "deepseek-flash")
            snapshot = ledger.snapshot()
            self.assertEqual(snapshot["prompt_tokens"], 50)
            self.assertEqual(snapshot["completion_tokens"], 2)
            self.assertEqual(snapshot["spent_usd"], "0.0000174")
            self.assertEqual(snapshot["reserved_usd"], "0")
            self.assertTrue(snapshot["all_reservations_settled"])
        finally:
            server.shutdown()
            server.server_close()

    def test_proxy_rejects_bad_local_token_without_forwarding(self):
        server, _thread = start_proxy(Decimal("0.01"), "provider-secret", "local-token")
        ledger = server.ledger
        try:
            with patch("deepseek_budget_proxy.urllib.request.urlopen") as upstream:
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
                connection.request("POST", "/chat/completions", "{}", {"Authorization": "Bearer wrong"})
                response = connection.getresponse()
                self.assertEqual(response.status, 401)
                connection.close()
                upstream.assert_not_called()
            self.assertEqual(ledger.snapshot()["api_calls"], 0)
        finally:
            server.shutdown()
            server.server_close()

    def test_proxy_fails_closed_when_provider_omits_usage(self):
        server, _thread = start_proxy(Decimal("0.01"), "provider-secret", "local-token")
        ledger = server.ledger
        try:
            with patch(
                "deepseek_budget_proxy.urllib.request.urlopen",
                return_value=FakeResponse(b'{"choices":[{"message":{"content":"OK"}}]}'),
            ):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
                body = json.dumps({
                    "model": "deepseek-flash",
                    "messages": [{"role": "user", "content": "test"}],
                    "max_tokens": 16,
                    "stream": False,
                })
                connection.request(
                    "POST",
                    "/chat/completions",
                    body,
                    {"Authorization": "Bearer local-token", "Content-Type": "application/json"},
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 502)
                connection.close()
            snapshot = ledger.snapshot()
            self.assertTrue(snapshot["failed"])
            self.assertTrue(snapshot["all_reservations_settled"])
        finally:
            server.shutdown()
            server.server_close()

    def test_proxy_clamps_aider_output_before_forwarding(self):
        server, _thread = start_proxy(Decimal("0.02"), "provider-secret", "local-token")
        try:
            response_body = json.dumps({
                "choices": [{"message": {"content": "OK"}}],
                "usage": {"prompt_tokens": 50, "completion_tokens": 2},
            }).encode()
            with patch(
                "deepseek_budget_proxy.urllib.request.urlopen",
                return_value=FakeResponse(response_body),
            ) as upstream:
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
                body = json.dumps({
                    "model": "deepseek/deepseek-flash",
                    "messages": [{"role": "user", "content": "test"}],
                    "max_tokens": 16_384,
                    "stream": False,
                })
                connection.request(
                    "POST",
                    "/chat/completions",
                    body,
                    {"Authorization": "Bearer local-token", "Content-Type": "application/json"},
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                connection.close()

            forwarded = json.loads(upstream.call_args.args[0].data)
            self.assertEqual(forwarded["max_tokens"], 4096)
            self.assertNotIn("max_completion_tokens", forwarded)
            self.assertEqual(server.ledger.snapshot()["api_calls"], 1)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
