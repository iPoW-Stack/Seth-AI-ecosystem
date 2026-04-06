#!/usr/bin/env python3
"""兼容入口：与 stress_outbound_serial_timed.py 相同（默认 4 小时）。"""

from stress_outbound_serial_timed import main

if __name__ == "__main__":
    raise SystemExit(main())
