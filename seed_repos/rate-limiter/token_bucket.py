"""A token bucket rate limiter intended to be shared across threads."""
import threading
import time


class TokenBucket:
    def __init__(self, capacity: int, refill_rate: float, clock=time.monotonic):
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        if refill_rate < 0:
            raise ValueError("refill_rate must be >= 0")
        self.capacity = capacity
        self.refill_rate = refill_rate
        self._clock = clock
        self._tokens = float(capacity)
        self._last = clock()
        self._lock = threading.Lock()

    def _refill(self) -> None:
        now = self._clock()
        elapsed = now - self._last
        self._last = now
        self._tokens = min(self.capacity, self._tokens + elapsed * self.refill_rate)

    @property
    def tokens(self) -> float:
        with self._lock:
            self._refill()
            return self._tokens

    def try_acquire(self, n: int = 1) -> bool:
        """Consume n tokens if available. Returns False (consuming nothing) otherwise."""
        if n <= 0:
            raise ValueError("n must be positive")
        if self._tokens < n:
            return False
        with self._lock:
            self._refill()
            self._tokens -= n
        return True
