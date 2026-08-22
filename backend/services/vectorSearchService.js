import Book from '../models/bookmodels.js';
import * as embeddingService from './embeddingService.js';
import { QDRANT_SEARCH_LIMIT } from '../config.js';
import { isQdrantEnabled, searchBookPoints } from './qdrantService.js';

let lastQdrantFallbackLogAt = 0;
const QDRANT_FALLBACK_LOG_COOLDOWN_MS = 60 * 1000;

const logQdrantFallbackError = (error) => {
  const now = Date.now();
  if (now - lastQdrantFallbackLogAt >= QDRANT_FALLBACK_LOG_COOLDOWN_MS) {
    lastQdrantFallbackLogAt = now;
    console.error('Qdrant search unavailable, falling back to Mongo vector search:', error.message);
  }
};

const applyFilters = (books = [], filters = {}) => {
  return books.filter((book) => {
    if (Array.isArray(filters.genres) && filters.genres.length > 0) {
      const genre = String(book.genre || '').toLowerCase();
      if (!filters.genres.map((g) => String(g || '').toLowerCase()).includes(genre)) {
        return false;
      }
    }

    if (typeof filters.minPrice === 'number' && typeof book.price === 'number' && book.price < filters.minPrice) {
      return false;
    }

    if (typeof filters.maxPrice === 'number' && typeof book.price === 'number' && book.price > filters.maxPrice) {
      return false;
    }

    return true;
  });
};

const mongoFallbackSearch = async (queryEmbedding, filters = {}, limit = 20) => {
  // isPublished is enforced here, not left to the caller: this path feeds
  // customer-facing retrieval and must never leak draft books.
  let query = { embedding: { $exists: true, $ne: null }, isPublished: true };

  // Relaxed: Removed hard genre filter to allow semantic discovery in fallback mode
  // if (filters.genres && filters.genres.length > 0) {
  //   query.genre = { $in: filters.genres };
  // }

  if (filters.minPrice || filters.maxPrice) {
    query.price = {};
    if (filters.minPrice !== undefined) {
      query.price.$gte = filters.minPrice;
    }
    if (filters.maxPrice !== undefined) {
      query.price.$lte = filters.maxPrice;
    }
  }

  const books = await Book.find(query).lean();
  if (books.length === 0) {
    return [];
  }

  return books
    .map((book) => ({
      ...book,
      semanticScore: embeddingService.cosineSimilarity(queryEmbedding, book.embedding),
    }))
    .sort((a, b) => b.semanticScore - a.semanticScore)
    .slice(0, limit);
};

/**
 * Get nearest books by semantic similarity to a query embedding
 * @param {number[]} queryEmbedding - The query embedding vector
 * @param {number} limit - Maximum number of books to return
 * @returns {Promise<Array>} - Array of books sorted by semantic similarity
 */
export const getVectorNearestBooks = async (queryEmbedding, limit = 20) => {
  try {
    if (!queryEmbedding || !Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      return [];
    }

    // Fetch all published books with embeddings
    const books = await Book.find({ embedding: { $exists: true, $ne: null }, isPublished: true }).lean();

    if (books.length === 0) {
      return [];
    }

    // Calculate similarity scores
    const resultsWithSimilarity = books
      .map((book) => ({
        ...book,
        semanticScore: embeddingService.cosineSimilarity(queryEmbedding, book.embedding),
      }))
      .sort((a, b) => b.semanticScore - a.semanticScore)
      .slice(0, limit);

    return resultsWithSimilarity;
  } catch (error) {
    console.error('Error in getVectorNearestBooks:', error.message);
    return [];
  }
};

/**
 * Get average embedding of user's liked books (preference profile embedding)
 * @param {string} userId - User ID
 * @returns {Promise<number[]>} - Averaged embedding vector for user preferences
 */
export const aggregateUserPreferenceVector = async (userId) => {
  try {
    if (!userId) {
      return new Array(384).fill(0);
    }

    // Fetch user's liked books
    const likedBooks = await Book.find({
      _id: { $in: [] }, // Would be populated from user.feedbackProfile.likedBookIds
      embedding: { $exists: true, $ne: null },
    }).lean();

    if (likedBooks.length === 0) {
      return new Array(384).fill(0);
    }

    const embeddings = likedBooks.map((book) => book.embedding);
    return embeddingService.averageEmbeddings(embeddings);
  } catch (error) {
    console.error('Error in aggregateUserPreferenceVector:', error.message);
    return new Array(384).fill(0);
  }
};

/**
 * Get books by vector similarity with optional pre-filtering
 * @param {number[]} queryEmbedding - Query embedding
 * @param {Object} filters - Optional filters: { genres: [], minPrice, maxPrice }
 * @param {number} limit - Max results
 * @returns {Promise<Array>} - Filtered and sorted books
 */
export const getUnifiedVectorSearch = async (queryEmbedding, filters = {}, limit = 20) => {
  try {
    if (!queryEmbedding || !Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      return [];
    }

    if (!isQdrantEnabled()) {
      return mongoFallbackSearch(queryEmbedding, filters, limit);
    }

    const qdrantLimit = Math.max(limit, QDRANT_SEARCH_LIMIT);
    const vectorHits = await searchBookPoints(queryEmbedding, {
      limit: qdrantLimit,
      filters,
    });

    if (!vectorHits.length) {
      return mongoFallbackSearch(queryEmbedding, filters, limit);
    }

    const idList = vectorHits.map((hit) => hit.id);
    // Second line of defence behind the Qdrant isPublished filter: a point whose
    // payload is stale must still not surface an unpublished book.
    const books = await Book.find({ _id: { $in: idList }, isPublished: true }).lean();
    const booksById = new Map(books.map((book) => [String(book._id), book]));

    const hydrated = vectorHits
      .map((hit) => {
        const book = booksById.get(hit.id);
        if (!book) {
          return null;
        }

        return {
          ...book,
          semanticScore: hit.score,
        };
      })
      .filter(Boolean);

    return applyFilters(hydrated, filters).slice(0, limit);
  } catch (error) {
    logQdrantFallbackError(error);
    return mongoFallbackSearch(queryEmbedding, filters, limit);
  }
};

export default {
  getVectorNearestBooks,
  aggregateUserPreferenceVector,
  getUnifiedVectorSearch,
};
