# rate-limiter

A thread-safe token bucket. `TokenBucket(capacity, refill_rate)` refills `refill_rate`
tokens per second up to `capacity`; `try_acquire(n)` returns True and consumes n tokens
if enough are available.

Run the tests with `python -m pytest -q`.
