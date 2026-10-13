import threading
import time

import pytest

from token_bucket import TokenBucket


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_starts_full():
    clock = FakeClock()
    b = TokenBucket(capacity=3, refill_rate=1, clock=clock)
    assert b.try_acquire()
    assert b.try_acquire()
    assert b.try_acquire()
    assert not b.try_acquire()


def test_refills_over_time():
    clock = FakeClock()
    b = TokenBucket(capacity=2, refill_rate=1, clock=clock)
    assert b.try_acquire(2)
    assert not b.try_acquire()
    clock.now = 1.5
    assert b.tokens == pytest.approx(1.5)
    assert b.try_acquire()
    assert not b.try_acquire()


def test_never_exceeds_capacity():
    clock = FakeClock()
    b = TokenBucket(capacity=2, refill_rate=10, clock=clock)
    clock.now = 100
    assert b.tokens == 2


def test_rejects_bad_args():
    with pytest.raises(ValueError):
        TokenBucket(0, 1)
    with pytest.raises(ValueError):
        TokenBucket(1, 1).try_acquire(0)


def test_concurrent_acquires_never_overspend():
    def slow_clock():
        time.sleep(0.01)
        return 0.0

    capacity = 2
    b = TokenBucket(capacity=capacity, refill_rate=0, clock=slow_clock)
    results = []
    start = threading.Barrier(6)

    def worker():
        start.wait()
        results.append(b.try_acquire())

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(results) == capacity
    assert b.tokens >= 0
