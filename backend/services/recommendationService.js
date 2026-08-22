import Book from '../models/bookmodels.js';
import Order from '../models/ordermodel.js';
import User from '../models/usermodel.js';
import { buildHistorySignals, rankBooks } from '../utils/recommendationScoring.js';
import { getUnifiedVectorSearch } from './vectorSearchService.js';

export const getRankedRecommendations = async ({ userId, query = '', queryEmbedding, limit = 5, mergedMemoryProfile = {} }) => {
  const [user, books, orders] = await Promise.all([
    User.findById(userId).lean(),
    Book.find({ isPublished: true }).select('-chunkEmbeddings').lean(),
    Order.find({ customerId: userId }).lean(),
  ]);

  const historySignals = buildHistorySignals(orders, books, user?.feedbackProfile || {});

  // Use mergedMemoryProfile (from conversation) if provided, otherwise fall back to database preferences
  const userPreferences = mergedMemoryProfile && Object.keys(mergedMemoryProfile).length > 0
    ? mergedMemoryProfile
    : user?.preferences || {};

  const orderedBookIds = new Set(
    orders
      .map((order) => String(order.bookRef || order.bookId || ''))
      .filter(Boolean)
  );

  const candidates = books.filter((book) => !orderedBookIds.has(String(book._id)));

  let semanticCandidates = [];
  if (Array.isArray(queryEmbedding) && queryEmbedding.length > 0) {
    const vectorFilters = {
      genres: userPreferences.preferredGenres || [],
      minPrice: userPreferences.budgetMin,
      maxPrice: userPreferences.budgetMax,
    };

    semanticCandidates = await getUnifiedVectorSearch(
      queryEmbedding,
      vectorFilters,
      Math.max(limit * 8, 40)
    );
  }

  const semanticIds = new Set(
    semanticCandidates
      .map((book) => String(book._id || ''))
      .filter(Boolean)
  );

  const inputBooks = semanticIds.size > 0
    ? candidates.filter((book) => semanticIds.has(String(book._id)))
    : (candidates.length > 0 ? candidates : books);

  const ranked = rankBooks({
    books: inputBooks,
    query,
    queryEmbedding,
    userPreferences,
    historySignals,
    limit,
  });

  return {
    user,
    recommendations: ranked.map(({ book, score, breakdown }) => ({
      ...book,
      score,
      scoreBreakdown: breakdown,
    })),
  };
};
