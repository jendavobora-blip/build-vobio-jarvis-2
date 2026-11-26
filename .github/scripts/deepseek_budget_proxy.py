import argparse
import hmac
import json
import os
import secrets
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


BALANCE_URL = "https://api.deepseek.com/user/balance"
CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions"
INPUT_USD_PER_MILLION_TOKENS = Decimal("0.30")
OUTPUT_USD_PER_MILLION_TOKENS = Decimal("1.20")
MAX_BODY_BYTES = 2_000_000
MAX_RESPONSE_BYTES = 4_000_000
MAX_OUTPUT_TOKENS = 4096
MAX_API_CALLS = 40
MAX_RUN_SECONDS = 900
PROMPT_TOKEN_OVERHEAD = 4096
PER_MESSAGE_TOKEN_OVERHEAD = 256
RESERVATION_SAFETY_MULTIPLIER = Decimal(2)
MILLION = Decimal(1_000_000)


class BudgetError(ValueError):
    pass


def parse_usd(value: str) -> Decimal:
    try:
        amount = Decimal(value)
    except InvalidOperation as error:
        raise BudgetError("Rozpočet musí být kladná částka v USD.") from error
    if not amount.is_finite() or amount <= 0:
        raise BudgetError("Rozpočet musí být kladná částka v USD.")
    return amount


def format_usd(amount: Decimal) -> str:
    return format(amount.normalize(), "f") if amount else "0"


def parse_balance(payload: Any, limit: Decimal | None = None) -> Decimal:
    if not isinstance(payload, dict) or payload.get("is_available") is not True:
        raise BudgetError("DeepSeek nepotvrdil dostupný zůstatek.")
    balance_infos = payload.get("balance_infos")
    if not isinstance(balance_infos, list):
        raise BudgetError("Odpověď zůstatku DeepSeek má neplatný formát.")

    balances: list[Decimal] = []
    for item in balance_infos:
        if not isinstance(item, dict) or item.get("currency") != "USD":
            continue
        try:
            balance = Decimal(str(item.get("topped_up_balance")))
        except InvalidOperation as error:
            raise BudgetError("USD zůstatek DeepSeek má neplatný formát.") from error
        if not balance.is_finite() or balance < 0:
            raise BudgetError("USD zůstatek DeepSeek má neplatnou hodnotu.")
        balances.append(balance)

    if not balances:
        raise BudgetError("DeepSeek nevrátil USD zůstatek; běh se zastavuje.")
    available = sum(balances, Decimal(0))
    if limit is not None and available < limit:
        raise BudgetError("Dostupný USD zůstatek je nižší než limit tohoto běhu.")
    return available


def verify_balance(api_key: str, limit: Decimal | None = None) -> Decimal:
    request = urllib.request.Request(
        BALANCE_URL,
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read(65_537)
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise BudgetError("Kontrola zůstatku DeepSeek selhala.") from error
    if len(raw) > 65_536:
        raise BudgetError("Odpověď zůstatku DeepSeek je příliš velká.")
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BudgetError("Odpověď zůstatku DeepSeek není platný JSON.") from error
    return parse_balance(payload, limit)


def normalize_request_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise BudgetError("Tělo API požadavku musí být objekt.")
    normalized = dict(payload)
    requested_limits = [
        normalized[field]
        for field in ("max_tokens", "max_completion_tokens")
        if field in normalized
    ]
    for value in requested_limits:
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise BudgetError("Výstupní limit tokenů musí být kladné celé číslo.")
    max_tokens = min(requested_limits, default=MAX_OUTPUT_TOKENS)
    normalized.pop("max_completion_tokens", None)
    normalized["max_tokens"] = min(max_tokens, MAX_OUTPUT_TOKENS)
    return normalized


def estimate_cost(raw_body: bytes, payload: Any) -> Decimal:
    if len(raw_body) > MAX_BODY_BYTES:
        raise BudgetError("Požadavek překračuje maximální velikost.")
    normalized = normalize_request_payload(payload)
    serialized_payload = json.dumps(normalized, separators=(",", ":")).encode("utf-8")
    if len(serialized_payload) > MAX_BODY_BYTES:
        raise BudgetError("Normalizovaný požadavek překračuje maximální velikost.")
    model = normalized.get("model")
    if model not in ("deepseek-flash", "deepseek/deepseek-flash"):
        raise BudgetError("Povolen je pouze model deepseek-flash.")
    if normalized.get("stream", False) is not False:
        raise BudgetError("Streamované odpovědi nejsou rozpočtovým proxy podporovány.")
    count = normalized.get("n", 1)
    if isinstance(count, bool) or not isinstance(count, int) or count != 1:
        raise BudgetError("Požadavek musí vytvářet právě jednu odpověď.")
    messages = normalized.get("messages")
    if not isinstance(messages, list) or not messages or not all(isinstance(item, dict) for item in messages):
        raise BudgetError("Požadavek musí obsahovat platné zprávy.")
    max_tokens = normalized["max_tokens"]

    prompt_token_upper_bound = (
        max(len(raw_body), len(serialized_payload))
        + PROMPT_TOKEN_OVERHEAD
        + PER_MESSAGE_TOKEN_OVERHEAD * len(messages)
    )
    return (
        Decimal(prompt_token_upper_bound) * INPUT_USD_PER_MILLION_TOKENS
        + Decimal(max_tokens) * OUTPUT_USD_PER_MILLION_TOKENS
    ) * RESERVATION_SAFETY_MULTIPLIER / MILLION


class BudgetLedger:
    def __init__(self, limit: Decimal, state_path: Path | None = None):
        self.limit = limit
        self.state_path = state_path
        self.spent = Decimal(0)
        self.actual_spent = Decimal(0)
        self.failed_reserved = Decimal(0)
        self.reserved = Decimal(0)
        self.calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.denied_calls = 0
        self.provider_http_errors: dict[str, int] = {}
        self.provider_transport_errors = 0
        self.provider_response_errors: dict[str, int] = {}
        self.failed = False
        self.blocked = False
        self._reservations: dict[str, Decimal] = {}
        self._lock = threading.Lock()
        self._persist_lock = threading.Lock()

    def reserve(self, amount: Decimal) -> str:
        denied = False
        with self._lock:
            if self.failed or self.blocked or self.calls >= MAX_API_CALLS or self.spent + self.reserved + amount > self.limit:
                self.denied_calls += 1
                self.blocked = True
                denied = True
            else:
                reservation_id = secrets.token_hex(16)
                self._reservations[reservation_id] = amount
                self.reserved += amount
                self.calls += 1
        self._persist()
        if denied:
            raise BudgetError("Požadavek se nevejde do zbývajícího rozpočtu.")
        return reservation_id

    def settle(
        self,
        reservation_id: str,
        charge: Decimal,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        failed: bool = False,
    ) -> None:
        with self._lock:
            reservation = self._reservations.pop(reservation_id)
            self.reserved -= reservation
            self.spent += charge
            if failed:
                self.failed_reserved += charge
            else:
                self.actual_spent += charge
            self.prompt_tokens += prompt_tokens
            self.completion_tokens += completion_tokens
            self.failed = self.failed or failed or charge > reservation
            self.blocked = self.blocked or charge > reservation
        self._persist()

    def record_provider_http_error(self, status_code: int) -> None:
        with self._lock:
            status = str(status_code)
            self.provider_http_errors[status] = self.provider_http_errors.get(status, 0) + 1
            self.failed = True
        self._persist()

    def record_provider_transport_error(self) -> None:
        with self._lock:
            self.provider_transport_errors += 1
            self.failed = True
        self._persist()

    def record_provider_response_error(self, category: str) -> None:
        if category not in ("oversized", "invalid_json", "usage_missing"):
            raise ValueError("Unsupported provider response error category.")
        with self._lock:
            self.provider_response_errors[category] = self.provider_response_errors.get(category, 0) + 1
            self.failed = True
        self._persist()

    def mark_failed(self) -> None:
        with self._lock:
            self.failed = True
        self._persist()

    def _persist(self) -> None:
        if self.state_path is not None:
            with self._persist_lock:
                write_audit(self.state_path, self)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "api_calls": self.calls,
                "denied_calls": self.denied_calls,
                "budget_limit_usd": format_usd(self.limit),
                "spent_usd": format_usd(self.spent),
                "actual_spent_usd": format_usd(self.actual_spent),
                "failed_reserved_usd": format_usd(self.failed_reserved),
                "reserved_usd": format_usd(self.reserved),
                "prompt_tokens": self.prompt_tokens,
                "completion_tokens": self.completion_tokens,
                "provider_http_errors": dict(self.provider_http_errors),
                "provider_transport_errors": self.provider_transport_errors,
                "provider_response_errors": dict(self.provider_response_errors),
                "failed": self.failed,
                "blocked": self.blocked,
                "all_reservations_settled": self.reserved == 0,
            }


def write_audit(path: Path, ledger: BudgetLedger) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as audit_file:
        audit_file.write(json.dumps(ledger.snapshot(), sort_keys=True))
        audit_file.flush()
        os.fsync(audit_file.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def create_handler(ledger: BudgetLedger, api_key: str, local_token: str):
    class BudgetHandler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _json(self, status: int, payload: dict[str, str]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path != "/health":
                self._json(404, {"error": "Not found"})
                return
            self._json(200, {"status": "ready"})

        def do_POST(self) -> None:
            if self.path not in ("/chat/completions", "/v1/chat/completions"):
                self._json(404, {"error": "Not found"})
                return
            expected = f"Bearer {local_token}"
            provided = self.headers.get("Authorization", "")
            if not hmac.compare_digest(provided, expected):
                self._json(401, {"error": "Unauthorized"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > MAX_BODY_BYTES:
                    raise BudgetError("Neplatná velikost požadavku.")
                raw_body = self.rfile.read(length)
                payload = normalize_request_payload(json.loads(raw_body))
                reservation = estimate_cost(raw_body, payload)
                reservation_id = ledger.reserve(reservation)
            except (ValueError, json.JSONDecodeError, BudgetError):
                self._json(400, {"error": "Požadavek odmítnut rozpočtovým proxy."})
                return

            payload["model"] = "deepseek-flash"
            upstream_body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            upstream = urllib.request.Request(
                CHAT_COMPLETIONS_URL,
                data=upstream_body,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
            try:
                with urllib.request.urlopen(upstream, timeout=60) as response:
                    response_body = response.read(MAX_RESPONSE_BYTES + 1)
            except urllib.error.HTTPError as error:
                try:
                    error.close()
                except OSError:
                    pass
                ledger.record_provider_http_error(error.code)
                ledger.settle(reservation_id, reservation, failed=True)
                self._json(
                    502,
                    {
                        "error": "Volání DeepSeek selhalo; rezervovaný limit byl započten.",
                        "provider_status": str(error.code),
                    },
                )
                return
            except (OSError, urllib.error.URLError):
                ledger.record_provider_transport_error()
                ledger.settle(reservation_id, reservation, failed=True)
                self._json(502, {"error": "Přenos k DeepSeek selhal; rezervovaný limit byl započten."})
                return

            if len(response_body) > MAX_RESPONSE_BYTES:
                ledger.record_provider_response_error("oversized")
                ledger.settle(reservation_id, reservation, failed=True)
                self._json(502, {"error": "Odpověď DeepSeek překročila limit."})
                return
            try:
                result = json.loads(response_body)
                usage = result.get("usage")
                prompt_tokens = usage.get("prompt_tokens") if isinstance(usage, dict) else None
                completion_tokens = usage.get("completion_tokens") if isinstance(usage, dict) else None
                choices = result.get("choices")
                if (
                    not isinstance(prompt_tokens, int)
                    or isinstance(prompt_tokens, bool)
                    or prompt_tokens < 0
                    or not isinstance(completion_tokens, int)
                    or isinstance(completion_tokens, bool)
                    or completion_tokens < 0
                    or not isinstance(choices, list)
                    or not choices
                ):
                    raise ValueError("Missing or invalid provider usage.")
            except (UnicodeDecodeError, json.JSONDecodeError):
                ledger.record_provider_response_error("invalid_json")
                ledger.settle(reservation_id, reservation, failed=True)
                self._json(502, {"error": "Odpověď DeepSeek není platný JSON."})
                return
            except (AttributeError, ValueError):
                ledger.record_provider_response_error("usage_missing")
                ledger.settle(reservation_id, reservation, failed=True)
                self._json(502, {"error": "Odpověď DeepSeek nemá ověřitelné údaje o spotřebě."})
                return

            charge = (
                Decimal(prompt_tokens) * INPUT_USD_PER_MILLION_TOKENS
                + Decimal(completion_tokens) * OUTPUT_USD_PER_MILLION_TOKENS
            ) / MILLION
            ledger.settle(reservation_id, charge, prompt_tokens, completion_tokens)
            if charge > reservation:
                self._json(502, {"error": "Skutečná spotřeba překročila rezervaci; běh je zastaven."})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)

    return BudgetHandler


def start_proxy(
    limit: Decimal,
    api_key: str,
    local_token: str,
    state_path: Path | None = None,
) -> tuple[ThreadingHTTPServer, threading.Thread]:
    ledger = BudgetLedger(limit, state_path)
    handler = create_handler(ledger, api_key, local_token)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server.ledger = ledger
    return server, thread


def run_smoke_test(limit: Decimal, api_key: str, state_path: Path) -> int:
    local_token = secrets.token_urlsafe(32)
    server, _thread = start_proxy(limit, api_key, local_token, state_path)
    request_body = json.dumps(
        {
            "model": "deepseek-flash",
            "messages": [{"role": "user", "content": "Reply OK."}],
            "max_tokens": 16,
            "stream": False,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{server.server_port}/chat/completions",
        data=request_body,
        headers={"Authorization": f"Bearer {local_token}", "Content-Type": "application/json"},
    )
    exit_code = 1
    try:
        with urllib.request.urlopen(request, timeout=75) as response:
            result = json.loads(response.read(MAX_RESPONSE_BYTES + 1))
        content = result["choices"][0]["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise BudgetError("DeepSeek vrátil prázdnou odpověď.")
        exit_code = 0
    except (OSError, urllib.error.URLError, urllib.error.HTTPError, KeyError, TypeError, json.JSONDecodeError, BudgetError):
        print("Test DeepSeek Chat Completions selhal nebo byl zastaven rozpočtovým limitem.", file=sys.stderr)
    finally:
        server.shutdown()
        server.server_close()
        snapshot = server.ledger.snapshot()
        if exit_code != 0 or snapshot["api_calls"] == 0:
            server.ledger.mark_failed()
        write_audit(state_path, server.ledger)
        print_audit(server.ledger)
    snapshot = server.ledger.snapshot()
    return exit_code if not snapshot["failed"] and not snapshot["blocked"] else 1


def run_aider(limit: Decimal, api_key: str, state_path: Path, command: list[str]) -> int:
    if not command:
        raise BudgetError("Chybí příkaz Aider.")
    local_token = secrets.token_urlsafe(32)
    server, _thread = start_proxy(limit, api_key, local_token, state_path)
    env = os.environ.copy()
    env["DEEPSEEK_API_KEY"] = local_token
    env["DEEPSEEK_API_BASE"] = f"http://127.0.0.1:{server.server_port}"
    env["AIDER_ENV_FILE"] = "/dev/null"
    env.pop("OPENAI_API_KEY", None)
    env.pop("OPENAI_API_BASE", None)
    exit_code = 1
    try:
        completed = subprocess.run(command, env=env, timeout=MAX_RUN_SECONDS, check=False)
        exit_code = completed.returncode
    except subprocess.TimeoutExpired:
        print("DeepSeek programovací běh překročil časový limit.", file=sys.stderr)
        exit_code = 124
    finally:
        server.shutdown()
        server.server_close()
        snapshot = server.ledger.snapshot()
        if (
            exit_code != 0
            or snapshot["api_calls"] == 0
            or snapshot["failed"]
            or snapshot["blocked"]
            or snapshot["denied_calls"] > 0
            or not snapshot["all_reservations_settled"]
        ):
            server.ledger.mark_failed()
        write_audit(state_path, server.ledger)
        print_audit(server.ledger)
    snapshot = server.ledger.snapshot()
    if (
        snapshot["api_calls"] == 0
        or snapshot["failed"]
        or snapshot["blocked"]
        or snapshot["denied_calls"] > 0
        or not snapshot["all_reservations_settled"]
    ):
        return 1
    return exit_code


def print_audit(ledger: BudgetLedger) -> None:
    snapshot = ledger.snapshot()
    print(
        "DeepSeek rozpočtový audit: "
        f"volání={snapshot['api_calls']}, "
        f"odmítnutá_volání={snapshot['denied_calls']}, "
        f"celkem_započteno_usd={snapshot['spent_usd']}, "
        f"skutečná_spotřeba_usd={snapshot['actual_spent_usd']}, "
        f"rezervace_při_chybe_usd={snapshot['failed_reserved_usd']}, "
        f"vstupní_tokeny={snapshot['prompt_tokens']}, "
        f"výstupní_tokeny={snapshot['completion_tokens']}, "
        f"HTTP_chyby={snapshot['provider_http_errors']}, "
        f"transportní_chyby={snapshot['provider_transport_errors']}, "
        f"chyby_odpovědi={snapshot['provider_response_errors']}, "
        f"selhání={snapshot['failed']}, "
        f"všechna_rezervování_vypořádána={snapshot['all_reservations_settled']}"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    balance_parser = subparsers.add_parser("check-balance")
    balance_parser.add_argument("--limit-usd")
    balance_parser.add_argument("--require-positive", action="store_true")

    smoke_parser = subparsers.add_parser("smoke-test")
    smoke_parser.add_argument("--limit-usd", required=True)
    smoke_parser.add_argument("--state-file", required=True)

    aider_parser = subparsers.add_parser("run-aider")
    aider_parser.add_argument("--limit-usd", required=True)
    aider_parser.add_argument("--state-file", required=True)
    aider_parser.add_argument("aider_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key or any(char.isspace() or not char.isprintable() for char in api_key):
        print("Chybí platný Secret DEEPSEEK_API_KEY.", file=sys.stderr)
        return 1

    try:
        if args.command == "check-balance":
            limit = parse_usd(args.limit_usd) if args.limit_usd else None
            available = verify_balance(api_key, limit)
            if args.require_positive and available <= 0:
                raise BudgetError("DeepSeek nepotvrdil kladný USD zůstatek.")
            if limit is None:
                print("DeepSeek potvrdil předplacený USD kredit; přesná částka není vypisována.")
            else:
                print("Předplacený USD kredit pokrývá limit tohoto běhu; přesná částka není vypisována.")
            return 0
        limit = parse_usd(args.limit_usd)
        state_path = Path(args.state_file)
        if args.command == "smoke-test":
            return run_smoke_test(limit, api_key, state_path)
        command = args.aider_args
        if command and command[0] == "--":
            command = command[1:]
        return run_aider(limit, api_key, state_path, command)
    except BudgetError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
