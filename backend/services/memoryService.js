export const KNOWN_GENRES = [
  'mystery',
  'thriller',
  'romance',
  'fantasy',
  'science fiction',
  'sci-fi',
  'historical',
  'horror',
  'non-fiction',
  'biography',
  'self-help',
  'young adult',
  'adventure',
  'drama',
  'poetry',
  'classic',
];

// Words that are definitely NOT part of an author's name
const AUTHOR_STOP_WORDS = new Set([
  'under', 'below', 'above', 'over', 'between', 'taka', 'tk', '৳',
  'books', 'book', 'novels', 'novel', 'price', 'budget', 'about',
  'mystery', 'thriller', 'romance', 'fantasy', 'horror', 'fiction',
  'science', 'biography', 'poetry', 'classic', 'drama', 'adventure',
  'some', 'me', 'a', 'an', 'the', 'any', 'few', 'good', 'great',
  'give', 'show', 'find', 'get', 'want', 'need', 'like', 'love',
  'please', 'more', 'new', 'latest', 'best', 'top', 'popular',
  'reading', 'read', 'recommend', 'suggested', 'english', 'bangla',
  'something', 'anything', 'do', 'can', 'you', 'tell', 'suggest',
  'of', 'and', 'or', 'in', 'for', 'with', 'from', 'by', 'at', 'to',
]);

const unique = (values = []) => [...new Set(values.filter(Boolean))];

const normalizeAuthorName = (name = '') => {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase());
};

export const normalizeGenre = (genre) => {
  const value = String(genre || '').toLowerCase().trim();
  if (value === 'sci-fi') {
    return 'science fiction';
  }
  return value;
};

/**
 * Try to extract an author name from a captured regex group.
 * Returns null if the result looks like a genre or stop word.
 */
const cleanAuthorCapture = (raw = '') => {
  if (!raw) return null;

  const tokens = raw.trim().split(/\s+/);
  // Remove leading/trailing stop words
  const cleaned = tokens.filter(t => !AUTHOR_STOP_WORDS.has(t.toLowerCase()));

  if (cleaned.length === 0) return null;

  const name = cleaned.join(' ');
  const normalized = normalizeAuthorName(name);

  // Must be at least 4 chars and not a known genre
  if (normalized.length < 4) return null;
  if (KNOWN_GENRES.includes(normalized.toLowerCase())) return null;

  return normalized;
};

export const extractPreferenceSignals = (text = '') => {
  const rawContent = String(text || '').trim();
  const content = rawContent.toLowerCase();

  // ── Genre detection ──────────────────────────────────────────────────
  const preferredGenres = KNOWN_GENRES
    .filter((genre) => content.includes(genre))
    .map(normalizeGenre);

  const dislikedGenres = [];
  const dislikePatterns = [
    /do not like\s+([a-z\-\s]+)/i,
    /don't like\s+([a-z\-\s]+)/i,
    /avoid\s+([a-z\-\s]+)/i,
    /no\s+([a-z\-\s]+)\s+please/i,
  ];

  for (const pattern of dislikePatterns) {
    const match = content.match(pattern);
    if (!match || !match[1]) continue;
    const snippet = match[1];
    for (const genre of KNOWN_GENRES) {
      if (snippet.includes(genre)) {
        dislikedGenres.push(normalizeGenre(genre));
      }
    }
  }

  // ── Budget detection ─────────────────────────────────────────────────
  let budgetMin = null;
  let budgetMax = null;

  const rangeMatch = content.match(/(?:between|from)\s*(?:tk|taka|৳)?\s*(\d{2,4})\s*(?:and|to|-)+\s*(?:tk|taka|৳)?\s*(\d{2,4})/i);
  if (rangeMatch) {
    budgetMin = Number(rangeMatch[1]);
    budgetMax = Number(rangeMatch[2]);
  }

  // Matches: "under 300 tk", "below tk 250", "max 350 taka", "less than 400"
  const underMatch = content.match(/(?:under|below|less than|max(?:imum)?|up to|within)\s*(?:tk|taka|৳)?\s*(\d{2,4})(?:\s*(?:tk|taka|৳))?/i);
  if (underMatch) {
    budgetMax = Number(underMatch[1]);
  }

  // Matches: "over 200 tk", "above 300", "minimum 250 taka"
  const overMatch = content.match(/(?:over|above|more than|min(?:imum)?|at least)\s*(?:tk|taka|৳)?\s*(\d{2,4})/i);
  if (overMatch) {
    budgetMin = Number(overMatch[1]);
  }

  // ── Author detection ─────────────────────────────────────────────────
  const preferredAuthors = [];

  /**
   * Strategy: Use multiple patterns ordered by confidence.
   * Pattern 1 & 2 are HIGH confidence ("books by X", "X's books").
   * Pattern 3 is MEDIUM ("give me some [Name] books").
   * Pattern 4 is MEDIUM ("show me [Name 1] [Name 2] books").
   * Pattern 5 is for explicit "from" keyword.
   */
  const authorPatterns = [
    // HIGH: "books by Iris Moore", "written by Nina Hale"
    /(?:books?\s+by|written\s+by|authored\s+by)\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,3})/gi,

    // HIGH: "from Humayun Ahmed", "from Iris Moore under 300"
    /\bfrom\s+([a-z][a-z.'-]*\s+[a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*)?)\b/gi,

    // HIGH: Possessive – "Iris Moore's books", "Humayun's novels"
    /([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})'s?\s+(?:books?|works?|novels?)/gi,

    // MEDIUM: "[Name 1] [Name 2] books" anywhere in sentence
    // The name must be 2+ words (reduces false positives)
    /\b([a-z][a-z.'-]+\s+[a-z][a-z.'-]+)\s+books?\b/gi,

    // MEDIUM: "give/show/get/find/want me some [Name] books"
    /(?:give|show|get|find|want|need|send|recommend)\s+(?:me\s+)?(?:some\s+)?([a-z][a-z.'-]+\s+[a-z][a-z.'-]+)\s+books?\b/gi,
  ];

  for (const pattern of authorPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const authorName = cleanAuthorCapture(match[1]);
      if (authorName && !preferredAuthors.includes(authorName)) {
        preferredAuthors.push(authorName);
      }
    }
  }

  // ── Reading pace/length signals (optional enrichment) ─────────────
  let pacePreference = '';
  if (/(fast-paced|fast paced|page-turner|intense)/i.test(content)) {
    pacePreference = 'fast-paced';
  } else if (/(slow-burn|slow burn|reflective|character-driven)/i.test(content)) {
    pacePreference = 'slow-burn';
  }

  let lengthPreference = '';
  if (/(short|quick read|not too long|light read)/i.test(content)) {
    lengthPreference = 'short';
  } else if (/(long|epic|detailed|series)/i.test(content)) {
    lengthPreference = 'long';
  }

  return {
    preferredGenres: unique(preferredGenres),
    dislikedGenres: unique(dislikedGenres),
    preferredAuthors: unique(preferredAuthors),
    budgetMin: Number.isFinite(budgetMin) ? budgetMin : null,
    budgetMax: Number.isFinite(budgetMax) ? budgetMax : null,
    pacePreference,
    lengthPreference,
  };
};

export const summarizeConversation = (messages = []) => {
  const recentUserMessages = messages
    .filter((message) => message.role === 'user')
    .slice(-3)
    .map((message) => message.content)
    .join(' / ');

  return `Recent asks: ${recentUserMessages || 'none'}`;
};
