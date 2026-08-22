import 'dotenv/config';

export const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

export const mongoDBURL = process.env.MONGODB_URL || 'mongodb://localhost:27017/blog';

export const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-env';
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d';

export const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

export const GROQ_API_KEY = String(process.env.GROQ_API_KEY || '').trim();
export const REQUIRE_GROQ_API_KEY = String(process.env.REQUIRE_GROQ_API_KEY || '').trim().startsWith('1');
export const RATE_LIMIT_ASSISTANT_CHAT_PER_MINUTE = Number(process.env.RATE_LIMIT_ASSISTANT_CHAT_PER_MINUTE || 20);
export const RATE_LIMIT_ASSISTANT_FEEDBACK_PER_MINUTE = Number(process.env.RATE_LIMIT_ASSISTANT_FEEDBACK_PER_MINUTE || 40);
export const RATE_LIMIT_AUTH_LOGIN_PER_MINUTE = Number(process.env.RATE_LIMIT_AUTH_LOGIN_PER_MINUTE || 20);

// Only enable when a proxy you control (Vercel, nginx, a load balancer) sits in
// front of the app. With it off, Express ignores X-Forwarded-For, so a client
// cannot spoof its way past the IP-keyed rate limit.
export const TRUST_PROXY = String(process.env.TRUST_PROXY || (process.env.VERCEL === '1' ? '1' : '')).trim().startsWith('1');

// Embedding configuration
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';

// Retrieval configuration.
// RAG_SEMANTIC_FLOOR is a cosine-similarity cutoff (0..1) applied to candidates
// BEFORE ranking. It is the real noise filter.
// RAG_RELEVANCE_THRESHOLD is a normalised (0..1) cutoff on the final composite
// ranking score, applied AFTER ranking.
export const RAG_SEMANTIC_FLOOR = Number(process.env.RAG_SEMANTIC_FLOOR ?? 0.28);
export const RAG_RELEVANCE_THRESHOLD = Number(process.env.RAG_RELEVANCE_THRESHOLD ?? 0.12);
export const REC_SEMANTIC_WEIGHT = Number(process.env.REC_SEMANTIC_WEIGHT || 2.5);
export const ENABLE_EMBEDDING_ON_WRITE = String(
	process.env.ENABLE_EMBEDDING_ON_WRITE || (isProduction ? '0' : '1')
)
	.trim()
	.startsWith('1');

// Qdrant configuration
export const QDRANT_ENABLED = String(process.env.QDRANT_ENABLED || '').trim().startsWith('1');
export const QDRANT_URL = String(process.env.QDRANT_URL || '').trim();
export const QDRANT_API_KEY = String(process.env.QDRANT_API_KEY || '').trim();
export const QDRANT_COLLECTION = String(process.env.QDRANT_COLLECTION || 'books').trim();
export const QDRANT_SEARCH_LIMIT = Number(process.env.QDRANT_SEARCH_LIMIT || 40);
export const QDRANT_CHECK_COMPATIBILITY = String(process.env.QDRANT_CHECK_COMPATIBILITY || '0').trim().startsWith('1');

const isBcryptHash = (value) => /^\$2[aby]\$\d{2}\$/.test(String(value || ''));

export const validateEnvironment = () => {
	if (!mongoDBURL) {
		throw new Error('MONGODB_URL is required');
	}

	if (!JWT_SECRET || JWT_SECRET === 'change-me-in-env') {
		if (isProduction) {
			throw new Error('JWT_SECRET must be configured in production');
		}
	}

	if (isProduction && !isBcryptHash(ADMIN_PASSWORD)) {
		throw new Error('ADMIN_PASSWORD must be a bcrypt hash in production');
	}

	if (REQUIRE_GROQ_API_KEY && !GROQ_API_KEY) {
		throw new Error('GROQ_API_KEY is required when REQUIRE_GROQ_API_KEY=1');
	}

	if (QDRANT_ENABLED && !QDRANT_URL) {
		throw new Error('QDRANT_URL is required when QDRANT_ENABLED=1');
	}

	const numericLimits = [
		['RATE_LIMIT_ASSISTANT_CHAT_PER_MINUTE', RATE_LIMIT_ASSISTANT_CHAT_PER_MINUTE],
		['RATE_LIMIT_ASSISTANT_FEEDBACK_PER_MINUTE', RATE_LIMIT_ASSISTANT_FEEDBACK_PER_MINUTE],
		['RATE_LIMIT_AUTH_LOGIN_PER_MINUTE', RATE_LIMIT_AUTH_LOGIN_PER_MINUTE],
		['QDRANT_SEARCH_LIMIT', QDRANT_SEARCH_LIMIT],
		['REC_SEMANTIC_WEIGHT', REC_SEMANTIC_WEIGHT],
	];

	for (const [name, value] of numericLimits) {
		if (!Number.isFinite(value) || value <= 0) {
			throw new Error(`${name} must be a positive number`);
		}
	}

	const unitIntervalLimits = [
		['RAG_SEMANTIC_FLOOR', RAG_SEMANTIC_FLOOR],
		['RAG_RELEVANCE_THRESHOLD', RAG_RELEVANCE_THRESHOLD],
	];

	for (const [name, value] of unitIntervalLimits) {
		if (!Number.isFinite(value) || value < 0 || value >= 1) {
			throw new Error(`${name} must be a number in [0, 1)`);
		}
	}
};