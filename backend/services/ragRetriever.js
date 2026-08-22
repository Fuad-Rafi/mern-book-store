import Book from '../models/bookmodels.js';
import Order from '../models/ordermodel.js';
import * as embeddingService from './embeddingService.js';
import { getUnifiedVectorSearch } from './vectorSearchService.js';
import { extractPreferenceSignals } from './memoryService.js';
import User from '../models/usermodel.js';
import { rankBooks, buildHistorySignals } from '../utils/recommendationScoring.js';
import { RAG_RELEVANCE_THRESHOLD, RAG_SEMANTIC_FLOOR } from '../config.js';

// Two distinct cutoffs, both on a 0..1 scale:
//  - SEMANTIC_FLOOR runs on raw cosine similarity BEFORE ranking. This is the
//    real noise filter: it drops books the embedding says are unrelated.
//  - RELEVANCE_THRESHOLD runs on the normalised composite score AFTER ranking.
// Previously a single threshold was compared against the unbounded composite
// score, which made it a no-op (any rated book already scored ~0.9).
const SEMANTIC_FLOOR = RAG_SEMANTIC_FLOOR;
const DEFAULT_RELEVANCE_THRESHOLD = RAG_RELEVANCE_THRESHOLD;

// Chunk vectors are only needed by the indexer; loading them into every
// retrieval query would pull N x 384 floats per book for nothing.
const WITHOUT_CHUNK_VECTORS = '-chunkEmbeddings';
const AUTHOR_SEARCH_LIMIT = 20;

const isFiniteNumber = (value) => Number.isFinite(value);

export const classifyQueryIntent = (userQuery = '') => {
  const text = String(userQuery || '').trim();
  const lowered = text.toLowerCase();

  const isGreeting = /^(hi|hello|hey|yo|hola|assalamualaikum|good\s(morning|afternoon|evening))\b/i.test(text);
  const isClarification = /^(what do you mean|can you explain|explain that|i did not understand|what\?)\b/i.test(lowered);
  const isEmpty = text.length === 0;
  const constraints = extractPreferenceSignals(text);

  return {
    isGreeting,
    isClarification,
    isEmpty,
    constraints,
  };
};

/**
 * Build a MongoDB price query object from budget constraints.
 * Applies a 10% tolerance buffer on both ends.
 */
const buildPriceQuery = (budgetMin, budgetMax) => {
  const price = {};
  if (isFiniteNumber(budgetMin)) price.$gte = Math.floor(budgetMin * 0.9);
  if (isFiniteNumber(budgetMax)) price.$lte = Math.ceil(budgetMax * 1.1);
  return Object.keys(price).length > 0 ? price : null;
};

/**
 * Search books directly by author name using MongoDB regex.
 * This is the "hard guarantee" path when an author is detected in the query.
 * Semantic search cannot reliably find books by author name alone — this fixes that.
 */
const searchByAuthor = async (preferredAuthors, budgetMin, budgetMax, excludeBookIds) => {
  if (!preferredAuthors || preferredAuthors.length === 0) return [];

  const orClauses = preferredAuthors.map((name) => ({
    author: { $regex: name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
  }));

  // Never surface unpublished/draft books to customers.
  const query = { $or: orClauses, isPublished: true };

  const priceQuery = buildPriceQuery(budgetMin, budgetMax);
  if (priceQuery) query.price = priceQuery;

  // Capped: a loose author match (a common surname, or a bad extraction) used to
  // pull the entire catalogue in at a fixed 0.92, outranking real matches.
  const books = await Book.find(query)
    .select(WITHOUT_CHUNK_VECTORS)
    .limit(AUTHOR_SEARCH_LIMIT)
    .lean();

  return books
    .filter((book) => !excludeBookIds.has(String(book._id)))
    .map((book) => ({
      ...book,
      // Give author-matched books a high fixed relevance so they surface at the top
      semanticScore: 0.92,
      isAuthorMatch: true,
    }));
};

/**
 * Keyword/searchText fallback: when semantic search returns nothing,
 * use the pre-built searchText index to find basic matches.
 */
const searchByKeyword = async (query, budgetMin, budgetMax, excludeBookIds, limit) => {
  // Build keyword query from the user query words
  const keywords = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (keywords.length === 0) return [];

  // Build OR-style regex patterns for each meaningful word
  const regexPatterns = keywords.map((kw) => ({
    searchText: { $regex: kw, $options: 'i' },
  }));

  // Never surface unpublished/draft books to customers.
  const mongoQuery = { $or: regexPatterns, isPublished: true };
  const priceQuery = buildPriceQuery(budgetMin, budgetMax);
  if (priceQuery) mongoQuery.price = priceQuery;

  const books = await Book.find(mongoQuery).select(WITHOUT_CHUNK_VECTORS).limit(limit * 3).lean();

  return books
    .filter((book) => !excludeBookIds.has(String(book._id)))
    .map((book) => ({
      ...book,
      // Medium confidence score — these are keyword matches, not semantic
      semanticScore: 0.55,
      isKeywordMatch: true,
    }));
};

/**
 * Merge two book arrays by _id, preventing duplicates.
 * Priority list comes first (author matches), then remainder.
 */
const mergeDeduped = (priority = [], secondary = []) => {
  const seen = new Set();
  const merged = [];

  for (const book of [...priority, ...secondary]) {
    const id = String(book._id);
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(book);
    }
  }

  return merged;
};

/**
 * Main retrieval function.
 * 
 * Flow:
 *  1. Extract signals (genre, author, price) from the user query.
 *  2. If specific author(s) detected → direct MongoDB author search (guaranteed recall).
 *  3. Always run semantic vector search in parallel (for conceptual matching).
 *  4. Merge: author matches first, then semantic results (deduped).
 *  5. Drop anything below the cosine semantic floor (author matches exempt).
 *  6. If nothing survived → keyword fallback on searchText field.
 *  7. If a budget emptied the pool, retry unpriced and flag the results.
 *  8. Enforce the stated budget as a hard cap on the candidate pool.
 *  9. Rank, then filter on the normalised composite score.
 */
export const retrieveRelevantBooks = async ({
  userId,
  userQuery,
  limit = 5,
  constraints: providedConstraints,
}) => {
  const query = String(userQuery || '').trim();
  if (!query) {
    return {
      query,
      relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
      semanticFloor: SEMANTIC_FLOOR,
      retrievedBooks: [],
      constraints: {},
    };
  }

  // Callers that already analysed the message (assistantchat, via the single
  // structured LLM call) pass their constraints in rather than paying for a
  // second, weaker regex extraction here.
  const constraints = providedConstraints || extractPreferenceSignals(query);
  const preferredAuthors = constraints.preferredAuthors || [];
  const preferredGenres = constraints.preferredGenres || [];
  const { budgetMin, budgetMax } = constraints;

  // Run order lookup, user fetch, and query embedding in parallel
  const [orders, user, queryEmbedding] = await Promise.all([
    Order.find({ customerId: userId }).lean(),
    User.findById(userId).lean(),
    embeddingService.embedText(query),
  ]);

  const excludeBookIds = new Set(
    orders.map((o) => String(o.bookRef || o.bookId || '')).filter(Boolean)
  );

  // ── Step 1: Author-specific search (HIGH CONFIDENCE) ──────────────────
  // Runs when user explicitly mentions an author (e.g., "Iris Moore books under 300 tk")
  const [authorBooks, semanticResults] = await Promise.all([
    searchByAuthor(preferredAuthors, budgetMin, budgetMax, excludeBookIds),

    // ── Step 2: Semantic vector search ─────────────────────────────────
    // No genre hard-filter — let the embedding handle concept matching
    getUnifiedVectorSearch(
      queryEmbedding,
      {
        // Only pass price as a hard filter (with buffer already in qdrantService)
        minPrice: isFiniteNumber(budgetMin) ? budgetMin : undefined,
        maxPrice: isFiniteNumber(budgetMax) ? budgetMax : undefined,
      },
      Math.max(limit * 6, 40)
    ),
  ]);

  // ── Step 3: Merge — author matches sit above semantic results ─────────
  const semanticWithScores = semanticResults
    .filter((book) => !excludeBookIds.has(String(book._id)))
    .map((book) => ({
      ...book,
      relevanceScore: Number(book.semanticScore ?? 0),
    }));

  const authorWithScores = authorBooks.map((book) => ({
    ...book,
    relevanceScore: Number(book.semanticScore ?? 0.92),
  }));

  let merged = mergeDeduped(authorWithScores, semanticWithScores);

  // ── Step 4: Semantic floor — the actual noise filter ──────────────────
  // Runs on raw cosine similarity, before ranking. Author matches bypass it:
  // the user named the author explicitly, so recall beats similarity there.
  merged = merged.filter(
    (book) => book.isAuthorMatch || Number(book.semanticScore ?? 0) >= SEMANTIC_FLOOR
  );

  // ── Step 5: Keyword fallback if nothing survived ──────────────────────
  let candidates = merged;
  if (candidates.length === 0) {
    const keywordResults = await searchByKeyword(query, budgetMin, budgetMax, excludeBookIds, limit);
    candidates = keywordResults.map((book) => ({
      ...book,
      relevanceScore: Number(book.semanticScore ?? 0.55),
    }));
  }

  // ── Step 6: Budget rescue ─────────────────────────────────────────────
  // The price filter runs inside the vector search, so an unmeetable budget
  // ("mystery under Tk 100" against a catalogue that starts at Tk 200) empties
  // the pool before anything can be flagged, and the user just gets told there
  // are no matches. Retry unpriced so we can show the closest books and say
  // outright that they cost more.
  if (candidates.length === 0 && (isFiniteNumber(budgetMin) || isFiniteNumber(budgetMax))) {
    const [unpricedAuthorBooks, unpricedSemantic] = await Promise.all([
      searchByAuthor(preferredAuthors, null, null, excludeBookIds),
      getUnifiedVectorSearch(queryEmbedding, {}, Math.max(limit * 6, 40)),
    ]);

    candidates = mergeDeduped(unpricedAuthorBooks, unpricedSemantic)
      .filter((book) => !excludeBookIds.has(String(book._id)))
      .filter((book) => book.isAuthorMatch || Number(book.semanticScore ?? 0) >= SEMANTIC_FLOOR)
      .map((book) => ({ ...book, relevanceScore: Number(book.semanticScore ?? 0) }));
  }

  // ── Step 7: Hard budget cap ───────────────────────────────────────────
  // The 10% buffer applied during search is a recall widener for the candidate
  // pool only. Someone who said "under Tk 300" must not be handed a Tk 330 book
  // as though it met their limit. Applied before ranking so the ranker still
  // fills `limit` slots from books that actually qualify.
  let budgetExceeded = false;
  if (isFiniteNumber(budgetMin) || isFiniteNumber(budgetMax)) {
    const withinBudget = (book) => {
      if (typeof book.price !== 'number') {
        return true;
      }
      if (isFiniteNumber(budgetMax) && book.price > budgetMax) {
        return false;
      }
      if (isFiniteNumber(budgetMin) && book.price < budgetMin) {
        return false;
      }
      return true;
    };

    const inBudget = candidates.filter(withinBudget);

    if (inBudget.length > 0) {
      candidates = inBudget;
    } else if (candidates.length > 0) {
      // Nothing qualifies. Still answer, but flag every pick so the reply says
      // outright that it is over budget instead of quietly ignoring the limit.
      budgetExceeded = true;
      candidates = candidates.map((book) => ({ ...book, exceedsBudget: true }));
    }
  }

  // ── Step 8: Personalized recommendation scoring ────────────────────────
  let finalBooks = candidates;
  if (candidates.length > 0) {
    const historySignals = buildHistorySignals(orders, candidates, user?.feedbackProfile || {});
    const prefs = user?.preferences || {};
    
    // Merge extracted constraints with user preferences
    const mergedPreferences = {
      ...prefs,
      preferredAuthors: [...new Set([...(prefs.preferredAuthors || []), ...preferredAuthors])],
      preferredGenres:  [...new Set([...(prefs.preferredGenres || []), ...preferredGenres])],
    };

    const ranked = rankBooks({
      books: candidates,
      query,
      queryEmbedding,
      userPreferences: mergedPreferences,
      historySignals,
      limit,
    });
    
    const toBook = (r) => ({
      ...r.book,
      // Normalised 0..1, same scale as the semantic floor, so the number the
      // client and the LLM prompt see is actually interpretable.
      relevanceScore: r.normalizedScore,
    });

    const aboveThreshold = ranked.filter((r) => r.normalizedScore >= DEFAULT_RELEVANCE_THRESHOLD);

    // Every candidate already cleared the semantic floor, so if the composite
    // threshold rejects all of them, keep the single best rather than telling
    // the user we found nothing.
    finalBooks = aboveThreshold.length > 0
      ? aboveThreshold.map(toBook)
      : ranked.slice(0, 1).map(toBook);
  }

  return {
    query,
    relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
    semanticFloor: SEMANTIC_FLOOR,
    budgetExceeded,
    constraints: {
      preferredGenres,
      dislikedGenres: constraints.dislikedGenres || [],
      preferredAuthors,
      budgetMin,
      budgetMax,
    },
    retrievedBooks: finalBooks,
  };
};
