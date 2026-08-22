import { EMBEDDING_MODEL } from '../config.js';
import { safeLogError } from '../utils/securityLogger.js';
import * as embeddingService from './embeddingService.js';
import { upsertBookPoint } from './qdrantService.js';

// One embedding path for every writer: the admin create/update routes, the
// backfill script, and the Qdrant sync. Previously each had its own version —
// the script chunked, the routes did not — so editing a book silently degraded
// it from a chunk-level index to a single vector.
export const CHUNK_MAX_WORDS = 200;
export const CHUNK_OVERLAP_WORDS = 40;

const EMBEDDING_DIMENSIONS = 384;

/**
 * Text that represents a book to the embedding model: metadata first (so short
 * books still carry title/author/genre signal), then the prose.
 */
export const buildEmbeddingText = (book = {}) => {
  const metadata = [
    book.title,
    book.author,
    book.genre,
    ...(Array.isArray(book.tags) ? book.tags : []),
    ...(Array.isArray(book.themes) ? book.themes : []),
    ...(Array.isArray(book.subjects) ? book.subjects : []),
  ]
    .filter(Boolean)
    .map((part) => String(part).trim())
    .filter(Boolean)
    .join(' ');

  const prose = String(book.synopsis || book.description || '').trim();

  return prose ? `${metadata}. ${prose}`.trim() : metadata;
};

const isValidVector = (vector) => Array.isArray(vector) && vector.length === EMBEDDING_DIMENSIONS;

/**
 * Chunk a book and embed every chunk.
 *
 * Returns both the per-chunk vectors and a single whole-book vector. The single
 * vector is the mean of the chunks, not the first chunk: chunk 0 is only the
 * opening ~200 words, which made the Mongo fallback blind to everything after
 * it.
 *
 * @returns {Promise<{chunkEmbeddings: number[][], embedding: number[], chunkCount: number} | null>}
 */
export const computeBookEmbeddings = async (book = {}) => {
  const text = buildEmbeddingText(book);
  const chunks = embeddingService.chunkText(text, CHUNK_MAX_WORDS, CHUNK_OVERLAP_WORDS);

  if (chunks.length === 0) {
    const fallbackText = String(book.title || '').trim();
    if (!fallbackText) {
      return null;
    }
    chunks.push(fallbackText);
  }

  const vectors = await embeddingService.batchEmbed(chunks);
  const chunkEmbeddings = vectors.filter(isValidVector);

  if (chunkEmbeddings.length === 0) {
    return null;
  }

  const embedding = chunkEmbeddings.length === 1
    ? chunkEmbeddings[0]
    : embeddingService.averageEmbeddings(chunkEmbeddings);

  return {
    chunkEmbeddings,
    embedding,
    chunkCount: chunkEmbeddings.length,
  };
};

/**
 * Embed a Mongoose book document, persist the vectors, then push them to Qdrant.
 *
 * Persisting is critical; the Qdrant push is best-effort. A vector store outage
 * must not fail an admin's save or abort a backfill run — Mongo now holds the
 * chunks, so a later `npm run qdrant:sync` fully reconstructs the index.
 *
 * @returns {Promise<{embedded: boolean, synced: boolean, chunkCount: number}>}
 */
export const embedAndSyncBook = async (bookDoc) => {
  if (!bookDoc) {
    return { embedded: false, synced: false, chunkCount: 0 };
  }

  const computed = await computeBookEmbeddings(bookDoc);
  if (!computed) {
    return { embedded: false, synced: false, chunkCount: 0 };
  }

  bookDoc.embedding = computed.embedding;
  bookDoc.chunkEmbeddings = computed.chunkEmbeddings;
  bookDoc.semanticMetadata = {
    embeddedAt: new Date(),
    modelVersion: EMBEDDING_MODEL,
    chunkCount: computed.chunkCount,
  };

  await bookDoc.save();

  let synced = false;
  try {
    synced = Boolean(await upsertBookPoint(bookDoc));
  } catch (error) {
    safeLogError('Qdrant sync failed after embedding', error, { bookId: bookDoc._id });
  }

  return { embedded: true, synced, chunkCount: computed.chunkCount };
};
