const store = new Map();

const nowMs = () => Date.now();

/**
 * Rate-limit key.
 *
 * Authenticated requests are keyed on the user id. This matters: the previous
 * implementation read `x-forwarded-for` directly, a client-controlled header,
 * so anyone could randomise it and send unlimited requests to the LLM-backed
 * assistant routes.
 *
 * Anonymous requests fall back to req.ip. Express only derives req.ip from
 * X-Forwarded-For when `trust proxy` is enabled, which index.js gates behind
 * the TRUST_PROXY env var — so the header is honoured only where a proxy we
 * control is actually in front of the app.
 */
const defaultKey = (req) => {
  const userId = req.user?.id;
  if (userId) {
    return `user:${userId}`;
  }

  return `ip:${req.ip || 'unknown-ip'}`;
};

const cleanupExpiredEntries = () => {
  const current = nowMs();
  for (const [key, state] of store.entries()) {
    if (state.resetAt <= current) {
      store.delete(key);
    }
  }
};

export const createRateLimiter = ({
  windowMs,
  max,
  message = 'Too many requests. Please try again later.',
  keyGenerator = defaultKey,
}) => {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('windowMs must be a positive number');
  }

  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('max must be a positive number');
  }

  return (req, res, next) => {
    cleanupExpiredEntries();

    const key = `${req.path}:${keyGenerator(req)}`;
    const current = nowMs();
    const existing = store.get(key);

    if (!existing || existing.resetAt <= current) {
      store.set(key, {
        count: 1,
        resetAt: current + windowMs,
      });

      return next();
    }

    existing.count += 1;

    if (existing.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - current) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ message });
    }

    return next();
  };
};
