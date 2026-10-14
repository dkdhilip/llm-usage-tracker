"""Check your virtual key and gateway setup WITHOUT making any provider call (so it costs nothing).

    python check_connection.py

Authenticates against the gateway and reports which providers the key may use and whether the
workspace holds a real credential for each. Never prints the key.
"""

import sys

from gateway_client import GatewayConfigError, check_gateway, gateway_root


def main() -> int:
    try:
        info = check_gateway()
    except GatewayConfigError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    print(f"gateway: {gateway_root()}")
    print(f"key:     {info['label']!r}  live calls: {'ON' if info['allow_live'] else 'OFF (paused — turn it on in the dashboard)'}")
    for p in info["providers"]:
        state = "ready" if p["ready"] else "NO real credential in the workspace yet"
        print(f"  {p['provider']:<10} {state}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
