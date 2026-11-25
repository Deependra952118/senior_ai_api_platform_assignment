// Consecutive-failure breaker. Simple on purpose: the upstreams here are low
// volume, so a rolling error-rate window would mostly be noise.
export class CircuitBreaker {
  constructor(name, { failureThreshold = 5, cooldownMs = 10000, now = Date.now } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }

  // Returns true if a call may go through. In half-open only one probe is allowed.
  allow() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.cooldownMs) return false;
      this.state = 'half_open';
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  success() {
    this.state = 'closed';
    this.failures = 0;
    this.probeInFlight = false;
  }

  failure() {
    this.probeInFlight = false;
    if (this.state === 'half_open') return this.trip();
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  trip() {
    this.state = 'open';
    this.openedAt = this.now();
  }

  retryAfterSeconds() {
    if (this.state !== 'open') return 0;
    return Math.max(1, Math.ceil((this.cooldownMs - (this.now() - this.openedAt)) / 1000));
  }
}
