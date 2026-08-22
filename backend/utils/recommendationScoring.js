const DEFAULT_WEIGHTS = {
  queryMatch: Number(process.env.REC_QUERY_WEIGHT ?? 3),
  popularityPrior: Number(process.env.REC_POPULARITY_WEIGHT ?? 1.1),
  diversityBoost: Number(process.env.REC_DIVERSITY_WEIGHT ?? 0.6),
  preferenceMatch: Number(process.env.REC_PREFERENCE_WEIGHT ?? 2.2),
  historyMatch: Number(process.env.REC_HISTORY_WEIGHT ?? 0.8),
  dislikePenalty: Number(process.env.REC_DISLIKE_WEIGHT ?? 3),
  feedbackMatch: Number(process.env.REC_FEEDBACK_WEIGHT ?? 2.1),
  feedbackPenalty: Number(process.env.REC_FEEDBACK_PENALTY_WEIGHT ?? 3.3),
  semanticMatch: Number(process.env.REC_SEMANTIC_WEIGHT ?? 2.5),
  authorMatch: Number(process.env.REC_AUTHOR_WEIGHT ?? 2.5),
};

// Sum of every positive weight. Used to map the raw composite score onto 0..1
// so that a relevance threshold means something. Penalties are not included:
// they can only push the score down, and the result is clamped at 0.
export const computeMaxScore = (weights = DEFAULT_WEIGHTS) => {
  return (
    weights.queryMatch
    + weights.popularityPrior
    + weights.diversityBoost
    + weights.preferenceMatch
    + weights.historyMatch
    + weights.feedbackMatch
    + weights.semanticMatch
    + weights.authorMatch
  );
};

// Inline cosine similarity (to avoid circular dependency with embeddingService)
const cosineSimilarity = (emb1, emb2) => {
  if (!emb1 || !emb2 || emb1.length !== emb2.length) {
    return 0;
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < emb1.length; i++) {
    dotProduct += emb1[i] * emb2[i];
    norm1 += emb1[i] * emb1[i];
    norm2 += emb2[i] * emb2[i];
  }

  norm1 = Math.sqrt(norm1);
  norm2 = Math.sqrt(norm2);

  if (norm1 === 0 || norm2 === 0) {
    return 0;
  }

  return dotProduct / (norm1 * norm2);
};

const normalizeText = (value) => String(value ?? '').toLowerCase();

export const tokenize = (value) => {
  const text = normalizeText(value).replace(/[^a-z0-9]+/g, ' ');
  return [...new Set(text.split(' ').map((token) => token.trim()).filter(Boolean))];
};

export const getBookSearchText = (book) => {
  return normalizeText([
    book.title,
    book.author,
    book.description,
    book.synopsis,
    book.genre,
    ...(Array.isArray(book.tags) ? book.tags : []),
    ...(Array.isArray(book.themes) ? book.themes : []),
    ...(Array.isArray(book.subjects) ? book.subjects : []),
    book.language,
    book.audience,
  ].join(' '));
};

const calculateOverlapScore = (tokens, text) => {
  if (!tokens.length) {
    return 0;
  }

  const haystack = tokenize(text);
  const overlap = tokens.filter((token) => haystack.includes(token)).length;
  return overlap / tokens.length;
};

const priceFromQuery = (query) => {
  const normalized = normalizeText(query);
  const explicitMatch = normalized.match(/(?:under|below|less than|max(?:imum)?|up to)\s*(\d{2,4})/i);

  if (explicitMatch) {
    return Number(explicitMatch[1]);
  }

  if (/(cheap|cheaper|affordable|budget|low cost)/i.test(normalized)) {
    return 300;
  }

  return null;
};

const priceMatchScore = (bookPrice, targetPrice) => {
  if (!targetPrice || typeof bookPrice !== 'number') {
    return 0;
  }

  if (bookPrice <= targetPrice) {
    return 1 - (bookPrice / Math.max(targetPrice, 1)) * 0.35;
  }

  const overshoot = (bookPrice - targetPrice) / Math.max(targetPrice, 1);
  return Math.max(0, 1 - overshoot);
};

const entitySet = (values) => new Set((Array.isArray(values) ? values : [values])
  .flat()
  .map((value) => normalizeText(value).trim())
  .filter(Boolean));

const intersectCount = (leftValues, rightValues) => {
  const leftSet = entitySet(leftValues);
  const rightSet = entitySet(rightValues);
  let count = 0;

  for (const value of leftSet) {
    if (rightSet.has(value)) {
      count += 1;
    }
  }

  return count;
};

export const buildCandidateScore = ({
  book,
  queryTokens,
  query,
  userPreferences,
  historySignals,
  genreCounts,
  queryEmbedding,
  weights = DEFAULT_WEIGHTS,
}) => {
  const searchText = getBookSearchText(book);
  const titleText = normalizeText(book.title);
  const authorText = normalizeText(book.author);
  const targetPrice = priceFromQuery(query);

  const queryMatchBase = calculateOverlapScore(queryTokens, searchText);
  const queryMatchPrice = priceMatchScore(book.price, targetPrice);
  const queryMatch = Math.min(1, queryMatchBase + (targetPrice ? queryMatchPrice * 0.35 : 0));

  // NEW: Semantic similarity score
  const semanticMatch = (queryEmbedding && Array.isArray(book.embedding))
    ? Math.max(0, Math.min(1, cosineSimilarity(queryEmbedding, book.embedding)))
    : 0;

  // NEW: Author preference matching
  const preferredAuthors = userPreferences?.preferredAuthors || userPreferences?.favoriteAuthors || [];
  const authorMatch = preferredAuthors.length > 0
    ? preferredAuthors.some(author =>
        String(book.author || '').toLowerCase().includes(author.toLowerCase())
      ) ? 1 : 0
    : 0;

  const preferenceHits = [
    intersectCount(userPreferences?.preferredGenres, [book.genre]),
    intersectCount(preferredAuthors, [book.author]),
    intersectCount(userPreferences?.favoriteThemes, book.themes),
    intersectCount(userPreferences?.tonePreferences, book.tags),
    intersectCount(userPreferences?.readingGoals, book.subjects),
    intersectCount(userPreferences?.preferredLanguage ? [userPreferences.preferredLanguage] : [], [book.language]),
  ].reduce((sum, value) => sum + value, 0);

  const preferenceMatch = Math.min(1, preferenceHits / 3);

  const historyHits = [
    intersectCount(historySignals?.genres, [book.genre]),
    intersectCount(historySignals?.authors, [book.author]),
    intersectCount(historySignals?.themes, book.themes),
    intersectCount(historySignals?.tags, book.tags),
    intersectCount(historySignals?.subjects, book.subjects),
  ].reduce((sum, value) => sum + value, 0);

  const historyMatch = Math.min(1, historyHits / 3);

  const dislikedGenrePenalty = intersectCount(userPreferences?.dislikedGenres, [book.genre]) > 0 ? 1 : 0;
  const dislikedThemePenalty = intersectCount(userPreferences?.dislikedGenres, book.tags) > 0 ? 1 : 0;
  const dislikePenalty = Math.min(1, dislikedGenrePenalty + dislikedThemePenalty);

  const likedBookIds = new Set((historySignals?.likedBookIds || []).map((id) => String(id)));
  const dislikedBookIds = new Set((historySignals?.dislikedBookIds || []).map((id) => String(id)));
  const clickedBookIds = new Set((historySignals?.clickedBookIds || []).map((id) => String(id)));

  const feedbackHits = [
    intersectCount(historySignals?.feedbackLikedGenres, [book.genre]),
    intersectCount(historySignals?.feedbackLikedAuthors, [book.author]),
    intersectCount(historySignals?.feedbackLikedThemes, book.themes),
    intersectCount(historySignals?.feedbackClickedGenres, [book.genre]),
    intersectCount(historySignals?.feedbackClickedAuthors, [book.author]),
  ].reduce((sum, value) => sum + value, 0);

  const likedBookBoost = likedBookIds.has(String(book._id)) ? 1 : 0;
  const clickedBookBoost = clickedBookIds.has(String(book._id)) ? 0.5 : 0;
  const feedbackMatch = Math.min(1, (feedbackHits / 3) + likedBookBoost + clickedBookBoost);

  const feedbackPenaltyHits = [
    intersectCount(historySignals?.feedbackDislikedGenres, [book.genre]),
    intersectCount(historySignals?.feedbackDislikedThemes, book.themes),
  ].reduce((sum, value) => sum + value, 0);

  const dislikedBookPenalty = dislikedBookIds.has(String(book._id)) ? 1 : 0;
  const feedbackPenalty = Math.min(1, (feedbackPenaltyHits / 2) + dislikedBookPenalty);

  const popularityPrior = typeof book.rating === 'number'
    ? Math.max(0, Math.min(1, book.rating / 5))
    : 0.5;

  const genreFrequency = genreCounts.get(normalizeText(book.genre)) ?? 0;
  const diversityBoost = 1 / (1 + genreFrequency);

  const score = (
    weights.queryMatch * queryMatch
    + weights.popularityPrior * popularityPrior
    + weights.diversityBoost * diversityBoost
    + weights.preferenceMatch * preferenceMatch
    + weights.historyMatch * historyMatch
    + weights.feedbackMatch * feedbackMatch
    + weights.semanticMatch * semanticMatch
    + weights.authorMatch * authorMatch  // High weight for explicit author preference
    - weights.dislikePenalty * dislikePenalty
    - weights.feedbackPenalty * feedbackPenalty
  );

  // 0..1 view of the same score, so callers can apply a meaningful cutoff.
  const maxScore = computeMaxScore(weights);
  const normalizedScore = maxScore > 0
    ? Math.max(0, Math.min(1, score / maxScore))
    : 0;

  return {
    score,
    normalizedScore,
    breakdown: {
      queryMatch,
      semanticMatch,
      authorMatch,
      popularityPrior,
      diversityBoost,
      preferenceMatch,
      historyMatch,
      feedbackMatch,
      dislikePenalty,
      feedbackPenalty,
      targetPrice,
      titleText,
      authorText,
    },
  };
};

export const buildGenreCounts = (books = []) => {
  const counts = new Map();

  for (const book of books) {
    const genre = normalizeText(book.genre);
    if (!genre) {
      continue;
    }

    counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }

  return counts;
};

export const buildHistorySignals = (orders = [], books = [], feedbackProfile = {}) => {
  const bookMap = new Map(books.map((book) => [String(book._id), book]));
  const genres = [];
  const authors = [];
  const themes = [];
  const tags = [];
  const subjects = [];
  const feedbackLikedGenres = [];
  const feedbackLikedAuthors = [];
  const feedbackLikedThemes = [];
  const feedbackDislikedGenres = [];
  const feedbackDislikedThemes = [];
  const feedbackClickedGenres = [];
  const feedbackClickedAuthors = [];

  for (const order of orders) {
    const orderedBook = order.bookRef ? bookMap.get(String(order.bookRef)) : null;
    const fallbackBook = !orderedBook && order.bookId ? bookMap.get(String(order.bookId)) : null;
    const sourceBook = orderedBook || fallbackBook;

    if (!sourceBook) {
      continue;
    }

    if (sourceBook.genre) genres.push(sourceBook.genre);
    if (sourceBook.author) authors.push(sourceBook.author);
    if (Array.isArray(sourceBook.themes)) themes.push(...sourceBook.themes);
    if (Array.isArray(sourceBook.tags)) tags.push(...sourceBook.tags);
    if (Array.isArray(sourceBook.subjects)) subjects.push(...sourceBook.subjects);
  }

  const mapFeedbackBooks = (bookIds = []) => {
    return (bookIds || [])
      .map((bookId) => bookMap.get(String(bookId)))
      .filter(Boolean);
  };

  const likedBooks = mapFeedbackBooks(feedbackProfile.likedBookIds);
  const dislikedBooks = mapFeedbackBooks(feedbackProfile.dislikedBookIds);
  const clickedBooks = mapFeedbackBooks(feedbackProfile.clickedBookIds);

  for (const book of likedBooks) {
    if (book.genre) feedbackLikedGenres.push(book.genre);
    if (book.author) feedbackLikedAuthors.push(book.author);
    if (Array.isArray(book.themes)) feedbackLikedThemes.push(...book.themes);
  }

  for (const book of dislikedBooks) {
    if (book.genre) feedbackDislikedGenres.push(book.genre);
    if (Array.isArray(book.themes)) feedbackDislikedThemes.push(...book.themes);
  }

  for (const book of clickedBooks) {
    if (book.genre) feedbackClickedGenres.push(book.genre);
    if (book.author) feedbackClickedAuthors.push(book.author);
  }

  return {
    genres,
    authors,
    themes,
    tags,
    subjects,
    feedbackLikedGenres,
    feedbackLikedAuthors,
    feedbackLikedThemes,
    feedbackDislikedGenres,
    feedbackDislikedThemes,
    feedbackClickedGenres,
    feedbackClickedAuthors,
    likedBookIds: feedbackProfile.likedBookIds || [],
    dislikedBookIds: feedbackProfile.dislikedBookIds || [],
    clickedBookIds: feedbackProfile.clickedBookIds || [],
  };
};

export const rankBooks = ({
  books = [],
  query = '',
  queryEmbedding,
  userPreferences = {},
  historySignals = {},
  limit = 10,
  weights = DEFAULT_WEIGHTS,
}) => {
  const queryTokens = tokenize(query);
  const genreCounts = buildGenreCounts(books);

  const scoredBooks = books.map((book) => {
    const { score, normalizedScore, breakdown } = buildCandidateScore({
      book,
      queryTokens,
      query,
      queryEmbedding,
      userPreferences,
      historySignals,
      genreCounts,
      weights,
    });

    return {
      book,
      score,
      normalizedScore,
      breakdown,
    };
  });

  const rankedBooks = scoredBooks
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return (right.breakdown.popularityPrior + right.breakdown.diversityBoost) - (left.breakdown.popularityPrior + left.breakdown.diversityBoost);
    })
    .slice(0, limit);

  return rankedBooks;
};

export { DEFAULT_WEIGHTS };