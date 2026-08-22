import { GROQ_API_KEY } from '../config.js';
import { KNOWN_GENRES, extractPreferenceSignals, normalizeGenre } from './memoryService.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

const MAX_QUERY_LENGTH = 200;
const MAX_AUTHORS = 3;
const MAX_PRICE = 100000;

const callGroq = async (payload) => {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`Groq provider error ${response.status}`);
    err.providerStatus = response.status;
    err.providerBody = errorText;
    throw err;
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || '';
};

const safeParseJson = (content) => {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
};

// ── Query analysis ────────────────────────────────────────────────────────
// One structured call replaces the old two-step of "reformulate with an LLM,
// then pull constraints out with stacked regexes". The regex extractor is kept
// as the offline fallback and as the baseline the model's output is merged onto.

const buildAnalysisSystemPrompt = () => {
  return [
    'You extract search parameters for a book catalogue. Reply with JSON only.',
    'Keys:',
    '- standaloneQuery (string): the user\'s latest message rewritten as a self-contained search query, resolving pronouns and implied context from the history. If it is already self-contained, return it unchanged. Never answer the question, never add chat.',
    `- genres (array of strings): zero or more of exactly these values: ${KNOWN_GENRES.join(', ')}. Empty array if none is clearly implied.`,
    '- dislikedGenres (array of strings): same allowed values, for genres the user is ruling out.',
    '- authors (array of strings): person names the user is explicitly asking for. A name only. Never a genre, mood, adjective or generic word like "weekend" or "budget". Empty array if the user named no author.',
    '- budgetMin (number or null) and budgetMax (number or null): price bounds in Taka. "under 300" means budgetMax 300. Null when unstated.',
    '- intent (string): "search", "greeting", or "clarification".',
    'Extract only what the user actually said. Do not guess.',
  ].join('\n');
};

const sanitizeGenreList = (value) => {
  if (!Array.isArray(value)) {
    return null;
  }

  const allowed = new Set(KNOWN_GENRES);
  return [...new Set(
    value
      .filter((item) => typeof item === 'string')
      .map((item) => normalizeGenre(item))
      .filter((item) => allowed.has(item) || item === 'science fiction')
  )];
};

// A model-supplied author still gets validated: it is interpolated into a Mongo
// regex, and it decides whether the high-confidence author path fires at all.
const sanitizeAuthorList = (value) => {
  if (!Array.isArray(value)) {
    return null;
  }

  const genreSet = new Set(KNOWN_GENRES);

  return [...new Set(
    value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().replace(/\s+/g, ' '))
      .filter((item) => item.length >= 3 && item.length <= 60)
      .filter((item) => /^[\p{L}][\p{L}.'\- ]*$/u.test(item))
      .filter((item) => !genreSet.has(item.toLowerCase()))
  )].slice(0, MAX_AUTHORS);
};

const sanitizePrice = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_PRICE) {
    return null;
  }
  return parsed;
};

const sanitizeIntent = (value) => {
  const allowed = ['search', 'greeting', 'clarification'];
  return allowed.includes(value) ? value : 'search';
};

/**
 * Turn a raw user message plus history into a standalone query and structured
 * constraints.
 *
 * Always returns a usable result: with no API key, or on any provider or
 * validation failure, it degrades to the deterministic regex extractor.
 *
 * @returns {Promise<{standaloneQuery: string, constraints: object, intent: string, source: string}>}
 */
export const analyzeQuery = async ({ chatHistory = [], currentMessage = '' } = {}) => {
  const message = String(currentMessage || '').trim();
  const baseline = extractPreferenceSignals(message);

  const regexResult = {
    standaloneQuery: message,
    constraints: baseline,
    intent: 'search',
    source: 'regex',
  };

  if (!GROQ_API_KEY || !message) {
    return regexResult;
  }

  const historyText = chatHistory.length > 0
    ? chatHistory.slice(-4).map((msg) => `${msg.role}: ${msg.content}`).join('\n')
    : '(no prior turns)';

  try {
    const content = await callGroq({
      model: MODEL,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildAnalysisSystemPrompt() },
        { role: 'user', content: `Chat history:\n${historyText}\n\nLatest user message:\n${message}` },
      ],
    });

    const parsed = safeParseJson(content);
    if (!parsed) {
      return regexResult;
    }

    const rawQuery = typeof parsed.standaloneQuery === 'string' ? parsed.standaloneQuery.trim() : '';
    const standaloneQuery = rawQuery && rawQuery.length <= MAX_QUERY_LENGTH ? rawQuery : message;

    const genres = sanitizeGenreList(parsed.genres);
    const dislikedGenres = sanitizeGenreList(parsed.dislikedGenres);
    const authors = sanitizeAuthorList(parsed.authors);
    const budgetMin = sanitizePrice(parsed.budgetMin);
    const budgetMax = sanitizePrice(parsed.budgetMax);

    return {
      standaloneQuery,
      constraints: {
        ...baseline,
        // Genres are a closed vocabulary, so union both extractors safely.
        preferredGenres: [...new Set([...(baseline.preferredGenres || []), ...(genres || [])])],
        dislikedGenres: [...new Set([...(baseline.dislikedGenres || []), ...(dislikedGenres || [])])],
        // Authors are open-ended and the regex extractor over-fires on phrases
        // like "weekend reading books", so when the model answers we take its
        // list verbatim — including an empty one.
        preferredAuthors: authors ?? baseline.preferredAuthors,
        budgetMin: budgetMin ?? baseline.budgetMin,
        budgetMax: budgetMax ?? baseline.budgetMax,
      },
      intent: sanitizeIntent(parsed.intent),
      source: 'groq',
    };
  } catch {
    return regexResult;
  }
};

// ── Reply generation ──────────────────────────────────────────────────────

const buildSystemPrompt = () => {
  return [
    'You are a friendly, conversational book assistant.',
    'Always base your recommendations exclusively on the provided retrieved context.',
    'If the retrieved context is weak or empty, explain that no strong matches were found and suggest refinements.',
    'Do not invent books, authors, or metadata.',
    'GROUNDING: Wrap every book title and author name you mention in **double asterisks**. Only ever bold a title or author that appears verbatim in the retrieved context. Never bold anything else.',
    'PRIORITY: When generating your `assistantReply`, always prioritize the CURRENTLY retrieved books over any previously discussed books.',
    'If user constraints (like budget or genre) have changed, focus your explanation on the NEW books that now qualify, as these are often better matches than what was previously available.',
    'BUDGET: If a book is marked OVER BUDGET, you must say plainly that it costs more than the limit they gave, and state its price. Never present an over-budget book as if it met the limit.',
    'Crucially, you MUST provide a brief (1-2 line) explanation for EACH of the top 1 or 2 best matches from the current list.',
    'Explain exactly why those specific books are the best fit for their request based on their synopsis and metadata.',
    'Speak like an expert bookseller talking to a friend in a natural, conversational tone.',
    'Respond in JSON with keys: assistantReply (your conversational explanation including the book justifications), recommendedTitles (array of 2 to 4 titles you are recommending from the context), and refinementHints (array of 2 strings to help them narrow down further).',
  ].join(' ');
};

const buildRetrievedLines = (retrievedBooks = []) => {
  return retrievedBooks.map((book, index) => {
    const synopsis = typeof book.synopsis === 'string' && book.synopsis.trim()
      ? book.synopsis.trim()
      : (typeof book.description === 'string' ? book.description.trim() : 'No synopsis available');

    const budgetFlag = book.exceedsBudget ? ' | OVER BUDGET' : '';

    return `${index + 1}. ${book.title} by ${book.author} | Genre: ${book.genre || 'N/A'} | Price: Tk ${book.price ?? 'N/A'} | Relevance: ${Number(book.relevanceScore || 0).toFixed(3)}${budgetFlag} | Synopsis: ${synopsis}`;
  }).join('\n');
};

const buildBudgetLine = (constraints = {}) => {
  const { budgetMin, budgetMax } = constraints;
  const hasMin = Number.isFinite(budgetMin);
  const hasMax = Number.isFinite(budgetMax);

  if (!hasMin && !hasMax) {
    return '';
  }

  if (hasMin && hasMax) {
    return `Stated budget: Tk ${budgetMin} to Tk ${budgetMax}.`;
  }

  return hasMax ? `Stated budget: at most Tk ${budgetMax}.` : `Stated budget: at least Tk ${budgetMin}.`;
};

const buildUserPrompt = ({ userMessage, retrievedBooks = [], chatHistory = [], constraints = {} }) => {
  const historyText = chatHistory.length > 0
    ? `Recent history (for context only):\n` + chatHistory.slice(-4).map(msg => `${msg.role}: ${msg.content}`).join('\n')
    : '';

  return [
    `User message: ${String(userMessage || '').trim()}`,
    buildBudgetLine(constraints),
    historyText,
    `CURRENT BEST MATCHES (PRIORITIZE THESE):\n${buildRetrievedLines(retrievedBooks) || 'none'}`,
    'Task: Give a friendly reply. Focus on the TOP 1 or 2 books from the CURRENT list above.',
    'If these books are new because of a budget/genre change, explain why they are now better results than what was discussed previously.',
    'Include a 1-2 line explanation for why these specific top matches are perfect for them.',
  ].filter(Boolean).join('\n\n');
};

const parseModelJson = (content, fallbackTitles = []) => {
  const parsed = safeParseJson(content) ?? { assistantReply: String(content || '') };

  const assistantReply = typeof parsed.assistantReply === 'string' ? parsed.assistantReply : '';
  const recommendedTitles = Array.isArray(parsed.recommendedTitles)
    ? parsed.recommendedTitles.filter((title) => typeof title === 'string' && title.trim())
    : fallbackTitles;
  const refinementHints = Array.isArray(parsed.refinementHints)
    ? parsed.refinementHints.filter((hint) => typeof hint === 'string' && hint.trim())
    : [];

  return {
    assistantReply,
    recommendedTitles,
    refinementHints,
  };
};

// ── Grounding verification ────────────────────────────────────────────────
// The recommendation cards were always grounded, because they are built from
// the retrieved documents. The prose was not: nothing stopped the model from
// naming a book that does not exist. Titles and authors are bolded on request,
// so every bolded span must resolve to something in the retrieved context.

const normalizeForMatch = (value) => {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
};

export const extractBoldSpans = (reply = '') => {
  const spans = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let match;

  while ((match = pattern.exec(String(reply || ''))) !== null) {
    const span = match[1].trim();
    if (span) {
      spans.push(span);
    }
  }

  return spans;
};

/**
 * @returns {{grounded: boolean, unsupported: string[]}}
 */
export const verifyReplyGrounding = (reply = '', retrievedBooks = []) => {
  const allowed = new Set();

  for (const book of retrievedBooks) {
    const title = normalizeForMatch(book.title);
    const author = normalizeForMatch(book.author);
    if (title) allowed.add(title);
    if (author) allowed.add(author);
  }

  const unsupported = extractBoldSpans(reply)
    .map((span) => ({ span, normalized: normalizeForMatch(span) }))
    .filter(({ normalized }) => {
      if (!normalized) {
        return false;
      }
      // Accept an exact match, or a span contained in / containing a known
      // value — models routinely bold "The Silent Cipher by Nina Hale" as one
      // span, or shorten a subtitled title.
      for (const value of allowed) {
        if (value === normalized || value.includes(normalized) || normalized.includes(value)) {
          return false;
        }
      }
      return true;
    })
    .map(({ span }) => span);

  return {
    grounded: unsupported.length === 0,
    unsupported,
  };
};

const buildFallbackReply = ({ userMessage, retrievedBooks = [], source }) => {
  const top = retrievedBooks.slice(0, 5);

  if (!top.length) {
    return {
      assistantReply: 'I could not find strong matches for that request. Try adding a genre, author, or budget range.',
      recommendedTitles: [],
      refinementHints: ['Add a preferred genre', 'Try a wider price range'],
      grounded: true,
      source: source || 'fallback-no-context',
    };
  }

  const picks = top
    .map((book, index) => {
      const overBudget = book.exceedsBudget ? ' — above the budget you gave' : '';
      return `${index + 1}. ${book.title} by ${book.author} (Tk ${book.price ?? 'N/A'})${overBudget}`;
    })
    .join('\n');

  return {
    assistantReply: `These are the most relevant matches from your catalog:\n${picks}\nShare more detail if you want tighter results.`,
    recommendedTitles: top.map((book) => book.title),
    refinementHints: ['Add genre or mood', 'Set a budget cap'],
    grounded: true,
    source: source || 'fallback-grounded',
  };
};

export const generateAssistantReply = async ({
  userMessage,
  retrievedBooks = [],
  chatHistory = [],
  constraints = {},
}) => {
  if (!GROQ_API_KEY) {
    return buildFallbackReply({ userMessage, retrievedBooks, source: 'fallback-no-api-key' });
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: buildUserPrompt({ userMessage, retrievedBooks, chatHistory, constraints }),
    },
  ];

  const requestReply = async () => {
    const content = await callGroq({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages,
    });

    return parseModelJson(content, retrievedBooks.map((book) => book.title));
  };

  try {
    let parsed = await requestReply();

    if (!parsed.assistantReply) {
      return buildFallbackReply({ userMessage, retrievedBooks });
    }

    let verification = verifyReplyGrounding(parsed.assistantReply, retrievedBooks);

    if (!verification.grounded) {
      // One corrective pass. If the model still names something that is not in
      // the context, drop its prose entirely rather than ship a hallucination.
      messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
      messages.push({
        role: 'user',
        content: [
          `These bolded names are not in the retrieved context: ${verification.unsupported.join(', ')}.`,
          'Rewrite assistantReply using only the numbered books above. Do not mention anything else.',
          'Reply with the same JSON keys.',
        ].join(' '),
      });

      const retried = await requestReply();
      const retriedVerification = retried.assistantReply
        ? verifyReplyGrounding(retried.assistantReply, retrievedBooks)
        : { grounded: false, unsupported: [] };

      if (!retriedVerification.grounded) {
        return buildFallbackReply({ userMessage, retrievedBooks, source: 'fallback-ungrounded' });
      }

      parsed = retried;
      verification = retriedVerification;
    }

    // Titles are still reconciled against the retrieved set by the caller; this
    // filter just stops obviously invented entries reaching it.
    const knownTitles = new Set(retrievedBooks.map((book) => normalizeForMatch(book.title)));
    const recommendedTitles = parsed.recommendedTitles.filter(
      (title) => knownTitles.has(normalizeForMatch(title))
    );

    return {
      assistantReply: parsed.assistantReply,
      recommendedTitles: recommendedTitles.length > 0 ? recommendedTitles : parsed.recommendedTitles,
      refinementHints: parsed.refinementHints,
      grounded: true,
      source: 'groq',
    };
  } catch {
    return buildFallbackReply({ userMessage, retrievedBooks, source: 'fallback-provider-error' });
  }
};
