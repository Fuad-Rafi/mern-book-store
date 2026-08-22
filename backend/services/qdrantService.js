import { QdrantClient } from '@qdrant/js-client-rest';
import crypto from 'crypto';
import {
  EMBEDDING_MODEL,
  QDRANT_API_KEY,
  QDRANT_CHECK_COMPATIBILITY,
  QDRANT_COLLECTION,
  QDRANT_ENABLED,
  QDRANT_URL,
} from '../config.js';

let client;
let collectionReady = false;

const isEnabled = () => Boolean(QDRANT_ENABLED && QDRANT_URL);

const getClient = () => {
  if (!isEnabled()) {
    return null;
  }

  if (!client) {
    client = new QdrantClient({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY || undefined,
      checkCompatibility: QDRANT_CHECK_COMPATIBILITY,
    });
  }

  return client;
};

const toQdrantPointId = (mongoId) => {
  const raw = String(mongoId || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(/[^a-f0-9]/g, '').padEnd(24, '0').slice(0, 24);
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  const hex32 = `${normalized}${hash}`;

  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-4${hex32.slice(13, 16)}-a${hex32.slice(17, 20)}-${hex32.slice(20, 32)}`;
};

export const ensureQdrantCollection = async () => {
  const qdrant = getClient();
  if (!qdrant) {
    return false;
  }

  if (collectionReady) {
    return true;
  }

  try {
    await qdrant.getCollection(QDRANT_COLLECTION);
    collectionReady = true;
  } catch {
    await qdrant.createCollection(QDRANT_COLLECTION, {
      vectors: {
        size: 384,
        distance: 'Cosine',
      },
    });
    collectionReady = true;
  }

  await ensurePayloadIndexes(qdrant);
  return true;
};

// mongoId and isPublished are filtered on every search and every delete, so they
// need payload indexes. Creating an existing index is a no-op error we ignore.
const PAYLOAD_INDEXES = [
  ['mongoId', 'keyword'],
  ['isPublished', 'bool'],
  ['price', 'float'],
];

let payloadIndexesReady = false;

const ensurePayloadIndexes = async (qdrant) => {
  if (payloadIndexesReady) {
    return;
  }

  for (const [field_name, field_schema] of PAYLOAD_INDEXES) {
    try {
      await qdrant.createPayloadIndex(QDRANT_COLLECTION, {
        field_name,
        field_schema,
        wait: true,
      });
    } catch {
      // Index already exists, or the server rejected a duplicate. Both are fine.
    }
  }

  payloadIndexesReady = true;
};

const byMongoId = (bookId) => ({
  must: [{ key: 'mongoId', match: { value: String(bookId) } }],
});

const toBookPayload = (book = {}) => ({
  mongoId: String(book._id || ''),
  title: String(book.title || ''),
  author: String(book.author || ''),
  genre: String(book.genre || ''),
  language: String(book.language || ''),
  audience: String(book.audience || ''),
  tags: Array.isArray(book.tags) ? book.tags : [],
  themes: Array.isArray(book.themes) ? book.themes : [],
  subjects: Array.isArray(book.subjects) ? book.subjects : [],
  price: typeof book.price === 'number' ? book.price : null,
  rating: typeof book.rating === 'number' ? book.rating : null,
  isPublished: Boolean(book.isPublished),
  modelVersion: EMBEDDING_MODEL,
  updatedAt: new Date().toISOString(),
});

export const upsertBookPoint = async (book = {}) => {
  const qdrant = getClient();
  if (!qdrant || !book._id) {
    return false;
  }

  await ensureQdrantCollection();

  const points = [];
  const payload = toBookPayload(book);

  if (Array.isArray(book.chunkEmbeddings) && book.chunkEmbeddings.length > 0) {
    book.chunkEmbeddings.forEach((vector, idx) => {
      const pointId = toQdrantPointId(`${book._id}_chunk${idx}`);
      if (pointId && vector.length > 0) {
        points.push({
          id: pointId,
          vector,
          payload,
        });
      }
    });
  } else if (Array.isArray(book.embedding) && book.embedding.length > 0) {
    const pointId = toQdrantPointId(book._id);
    if (pointId) {
      points.push({
        id: pointId,
        vector: book.embedding,
        payload,
      });
    }
  }

  if (points.length === 0) return false;

  // Write first (wait, so the delete below cannot race it)...
  await qdrant.upsert(QDRANT_COLLECTION, {
    wait: true,
    points,
  });

  // ...then drop every other point still carrying this mongoId. Without this,
  // a book that used to be indexed as N chunks and is now indexed as 1 (or as
  // fewer chunks) leaves orphans behind holding stale vectors and stale payload
  // — including a stale price, which the range filter would then match on.
  await qdrant.delete(QDRANT_COLLECTION, {
    wait: false,
    filter: {
      ...byMongoId(book._id),
      must_not: [{ has_id: points.map((point) => point.id) }],
    },
  });

  return true;
};

export const deleteBookPoint = async (bookId) => {
  const qdrant = getClient();
  if (!qdrant || !String(bookId || '').trim()) {
    return false;
  }

  await ensureQdrantCollection();

  // Delete by payload, not by point id: a book may be stored as many chunk
  // points (`<id>_chunk0..N`), and deleting only toQdrantPointId(bookId) left
  // all of those behind.
  await qdrant.delete(QDRANT_COLLECTION, {
    wait: true,
    filter: byMongoId(bookId),
  });

  // Belt and braces for any legacy point written without a mongoId payload.
  const pointId = toQdrantPointId(bookId);
  if (pointId) {
    await qdrant.delete(QDRANT_COLLECTION, {
      wait: false,
      points: [pointId],
    });
  }

  return true;
};

export const resetQdrantCollection = async () => {
  const qdrant = getClient();
  if (!qdrant) {
    return false;
  }

  try {
    await qdrant.deleteCollection(QDRANT_COLLECTION);
  } catch {
    // Ignore if the collection does not exist yet.
  }

  collectionReady = false;
  payloadIndexesReady = false;
  await ensureQdrantCollection();
  return true;
};

const buildQdrantFilter = (filters = {}) => {
  // Unpublished books must never reach a customer-facing search.
  const must = [{ key: 'isPublished', match: { value: true } }];

  // Remove hard genre filter from vector search to allow semantic discovery.
  // We will instead BOOST genre matches during the ranking phase.

  if (typeof filters.minPrice === 'number' || typeof filters.maxPrice === 'number') {
    const range = {};
    if (typeof filters.minPrice === 'number') {
      // 10% buffer lower for minPrice
      range.gte = filters.minPrice * 0.9;
    }
    if (typeof filters.maxPrice === 'number') {
      // 10% buffer higher for maxPrice to catch "close matches"
      range.lte = filters.maxPrice * 1.1;
    }

    must.push({
      key: 'price',
      range,
    });
  }

  return { must };
};

export const searchBookPoints = async (queryEmbedding = [], { limit = 20, filters = {} } = {}) => {
  const qdrant = getClient();
  if (!qdrant || !Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    return [];
  }

  await ensureQdrantCollection();

  // Search a bit more to account for deduping
  const results = await qdrant.search(QDRANT_COLLECTION, {
    vector: queryEmbedding,
    limit: limit * 3,
    with_payload: true,
    filter: buildQdrantFilter(filters),
  });

  // Deduplicate by mongoId, keeping highest score
  const dedupedMap = new Map();
  for (const item of (results || [])) {
    const bookId = String(item.payload?.mongoId || item.id);
    if (!dedupedMap.has(bookId) || dedupedMap.get(bookId).score < item.score) {
      dedupedMap.set(bookId, {
        id: bookId,
        score: Number(item.score || 0),
        payload: item.payload || {},
      });
    }
  }

  return Array.from(dedupedMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

export const isQdrantEnabled = () => isEnabled();
