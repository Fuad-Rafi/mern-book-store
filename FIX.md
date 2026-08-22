# RAG Audit & Fix Tracker

Senior-engineer audit of the retrieval and assistant pipeline, with a running record of what has been fixed and what has not.

- **Audit date:** 2026-08-22
- **Scope:** `backend/services`, `backend/routes/assistantchat.js`, `backend/routes/bookrecommendations.js`, `backend/routes/bookrouts.js`, `backend/utils/recommendationScoring.js`, `backend/models`, `frontend/src/app/assistant`
- **Commits so far:** [`0f1179a`](https://github.com/Fuad-Rafi/NextChapter-AI-Bookstore/commit/0f1179a) (correctness), [`587705c`](https://github.com/Fuad-Rafi/NextChapter-AI-Bookstore/commit/587705c) (RAG quality)

---

## Verdict

**Is it truly RAG?** Yes. Real dense embeddings (`Xenova/all-MiniLM-L6-v2`, 384-dim), a real vector store (Qdrant, with a Mongo cosine fallback), hybrid retrieval (vector + author + keyword), and a genuine grounding contract — the recommendation cards are built from retrieved documents, not from model output. It is *classic retrieve-then-read* RAG, not a modern reranked pipeline.

**Can the chatbot converse, extract, and suggest?** Yes to all three, with caveats. Multi-turn context works via LLM query rewriting. Extraction is now a validated structured call rather than stacked regexes. Suggestions are grounded. The "memory summary" is still just a concatenation of the last three user messages, not a summary.

**How agentic is it?** **Barely — roughly 1.5/10.** The pipeline is fixed and linear: analyse → retrieve → rank → one LLM call → return. No tool calling, no planning loop, no self-correction, no multi-hop. Query analysis is preprocessing, not agency. Describe this as a RAG pipeline, not an agent — that claim would not survive an interview.

---

## Progress

| Status | Count | Items |
|---|---|---|
| ✅ Fixed | **8 / 15** | W1, W2, W3, W4, W5, W6, W7, W11 |
| 🟡 Partial | **4 / 15** | W8, W9, W10, W15 |
| ⬜ Open | **3 / 15** | W12, W13, W14 |

```
Fixed     ████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░  8/15  (53%)
Partial   ██████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  4/15  (27%)
Open      ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  3/15  (20%)
```

Both remaining security items from the original audit (W6 rate-limit bypass, W13 prompt injection) — one is fixed, one is still open.

---

## Status at a glance

| ID | Weakness | Severity | Status | Commit |
|---|---|---|---|---|
| W1 | Relevance threshold was a no-op | 🔴 High | ✅ Fixed | `0f1179a` |
| W2 | Unpublished books reachable by customers | 🔴 High | ✅ Fixed | `0f1179a` |
| W3 | Chunking implemented but never persisted | 🔴 High | ✅ Fixed | `587705c` |
| W4 | Orphan / stale Qdrant vectors | 🔴 High | ✅ Fixed | `0f1179a` |
| W5 | Budget treated as advisory | 🟠 Medium | ✅ Fixed | `587705c` |
| W6 | Rate limit trivially bypassable | 🟠 Medium | ✅ Fixed | `0f1179a` |
| W7 | LLM prose never verified | 🟠 Medium | ✅ Fixed | `587705c` |
| W8 | Silent LLM degradation | 🟠 Medium | 🟡 Partial | `587705c` |
| W9 | O(N) full-collection cosine scan | 🟡 Low | 🟡 Partial | `587705c` |
| W10 | Dead / abandoned code | 🟡 Low | 🟡 Partial | `0f1179a` |
| W11 | Author extraction false positives | 🟡 Low | ✅ Fixed | `587705c` |
| W12 | Unbounded conversation documents | 🟡 Low | ⬜ Open | — |
| W13 | Prompt injection unguarded | 🟠 Medium | ⬜ Open | — |
| W14 | Serverless cold-start cost | 🟢 Info | ⬜ Open | — |
| W15 | Config inconsistencies | 🟢 Info | 🟡 Partial | `0f1179a` |

---

## ✅ Fixed

### W1 — Relevance threshold was a no-op
**Symptom.** `RAG_RELEVANCE_THRESHOLD` was compared against the unbounded composite ranking score (range ≈ 0–14.8), not a similarity. Any book with a rating already scored ~0.94 from the popularity term alone, so the filter never removed anything. The README's documented `0.35` had the same defect.

**Impact.** Irrelevant books surfaced on every query. The system had no working noise filter.

**Fix.** Split into two cutoffs, both on a 0–1 scale:
- `RAG_SEMANTIC_FLOOR` (default `0.28`) — raw cosine, applied **before** ranking. The real noise filter. Author matches are exempt.
- `RAG_RELEVANCE_THRESHOLD` (default `0.12`) — normalised composite score, applied **after** ranking.

`buildCandidateScore` now returns `normalizedScore = clamp01(score / computeMaxScore(weights))`, and that value is what reaches the client and the LLM prompt — so `Relevance: 0.42` is interpretable instead of `Relevance: 8.234`. The hardcoded `2.5 * authorMatch` moved into `DEFAULT_WEIGHTS.authorMatch` so the max-score sum stays honest. If the composite threshold rejects every candidate, the best one is kept — they all already cleared the semantic floor.

**Files.** `config.js`, `utils/recommendationScoring.js`, `services/ragRetriever.js`

---

### W2 — Unpublished books reachable by customers
**Symptom.** `isPublished` was written into the Qdrant payload but **never filtered on anywhere** — not in `searchByAuthor`, `searchByKeyword`, `mongoFallbackSearch`, the Qdrant filter, or the recommendations route.

**Impact.** Draft books were recommended to customers.

**Fix.** `isPublished: true` enforced at every customer-facing read, plus a hard `must` clause in the Qdrant filter and a second line of defence in the Mongo hydration query (so a stale payload cannot leak a draft). Admin routes deliberately unchanged — admins still see drafts.

**Files.** `services/ragRetriever.js`, `services/vectorSearchService.js`, `services/qdrantService.js`, `services/recommendationService.js`, `routes/bookrecommendations.js`

> ⚠️ **Operational note:** books inserted through the raw driver may lack the field entirely and are now excluded. Check with:
> ```js
> db.books.countDocuments({ isPublished: { $exists: false } })
> db.books.updateMany({ isPublished: { $exists: false } }, { $set: { isPublished: true } })
> ```

---

### W3 — Chunking implemented but never persisted
**Symptom.** Worse than "chunking is disabled." `embedBooks.mjs` built chunk embeddings and attached them to a lean object, but `chunkEmbeddings` was not a schema field. The chunks existed only in Qdrant. Mongo stored `chunkEmbeddings[0]` — the opening ~200 words — as the whole-book vector. Re-running `qdrant:sync` read from Mongo, found no chunks, and **silently collapsed the chunk-level index back to one vector per book**. The admin create/update path never chunked at all, so editing any book degraded it.

**Impact.** Long synopses were effectively invisible past their first 200 words, and the index quietly regressed on every sync.

**Fix.** Added `chunkEmbeddings` and `semanticMetadata.chunkCount` to the schema. Created `services/bookIndexer.js` as the single embedding path for the create route, update route, `sync-embeddings`, and `embedBooks.mjs`. The whole-book vector is now the **mean of the chunks**, not chunk 0. Qdrant push is best-effort while the Mongo persist is not, so a vector-store outage no longer fails an admin save. Chunk vectors are excluded from every read that does not index them, and `embedding` is no longer shipped to browsers by `GET /books`.

**Verified.** A 400-word synopsis produced **3 chunks**, with the whole-book vector confirmed different from chunk 0.

**Files.** `models/bookmodels.js`, `services/bookIndexer.js` (new), `routes/bookrouts.js`, `scripts/embedBooks.mjs`

---

### W4 — Orphan and stale Qdrant vectors
**Symptom.** `deleteBookPoint` removed only `toQdrantPointId(bookId)` — the single derived point id. Chunk points (`<id>_chunk0..N`) survived both deletes and updates, holding stale vectors **and stale payload**, including a stale `price` that the range filter would then match on.

**Fix.** Deletes now go by `mongoId` payload filter. `upsertBookPoint` writes with `wait: true`, then removes any other point carrying the same `mongoId` that was not just written — no write gap, no orphans. Added payload indexes for `mongoId`, `isPublished`, `price`.

**Files.** `services/qdrantService.js`

> ⚠️ **Operational note:** run `npm run qdrant:sync` once to sweep pre-existing orphans. Each book's upsert cleans its own.

---

### W5 — Budget treated as advisory
**Symptom.** A 10% tolerance buffer was applied to the price filter and never undone. "Under Tk 300" returned Tk 330 books presented as though they qualified.

**Fix.** The buffer now widens the **candidate pool only**; the stated budget is enforced as a hard cap before ranking, so the ranker still fills its slots from books that actually qualify.

A second gap surfaced during testing: an unmeetable budget (e.g. "under Tk 100" against a catalogue whose schema floor is Tk 200) emptied the pool *inside the vector search*, so the flagging path never ran and the user simply got "no strong matches." Added a **budget-rescue step** — retry unpriced, flag every result `exceedsBudget`, and require the reply to state the price and say plainly that it is over the limit.

**Files.** `services/ragRetriever.js`, `services/llmService.js`, `routes/assistantchat.js`

---

### W6 — Rate limit trivially bypassable 🔒
**Symptom.** The limiter keyed on `x-forwarded-for`, a **client-controlled header**, read directly with no trust-proxy configuration. Randomising it granted unlimited access to the LLM-backed assistant routes — the only cost control on a paid Groq account and the Atlas quota.

**Fix.** Authenticated requests key on `user:<id>` (every assistant route already sits behind `authenticateToken`). Anonymous requests fall back to `req.ip`, and `app.set('trust proxy', …)` is gated behind a new `TRUST_PROXY` env var (auto-on when `VERCEL=1`), so the header is honoured only where a proxy you control sits in front.

**Verified.** 5 requests from one user with 5 different spoofed `X-Forwarded-For` values → 2 correctly blocked at `max=3`. Separate users get separate buckets.

**Files.** `middleware/rateLimit.js`, `index.js`, `config.js`

> ⚠️ **Still true:** the counter is an in-memory `Map`. On Vercel it is per-lambda-instance, so the effective limit multiplies by instance count and resets on cold start. Move it to Mongo (TTL collection) or Upstash Redis before relying on it in production.

---

### W7 — LLM prose never verified
**Symptom.** `recommendedTitles` was reconciled against the retrieved set, but `assistantReply` free text was returned raw. An 8B model at temperature 0.2 will occasionally name a book that does not exist. The README's "no hallucinated books" claim covered the cards, not the paragraph.

**Fix.** The model is instructed to wrap every title and author in `**double asterisks**`. Every bolded span must resolve to the retrieved context (titles ∪ authors, normalised for case and punctuation, allowing containment in either direction). A violation triggers one corrective retry; if it still fails, the prose is discarded in favour of the grounded template rather than shipping a hallucination.

**Verified.** `**Gone Girl**` / `**Gillian Flynn**` rejected against a context containing neither. `**The Silent Cipher by Nina Hale**` as a single span, shortened titles, and case/punctuation drift all correctly pass.

**Files.** `services/llmService.js`

---

### W11 — Author extraction false positives
**Symptom.** Five stacked regexes with a 60-word stopword list. `"show me budget-friendly weekend reading books"` extracted the author **`"Weekend"`**. Each false positive fired an unindexed regex scan over the whole `author` field, and `searchByAuthor` had **no `.limit()`** — a loose match returned the entire catalogue at a fixed `semanticScore: 0.92`, outranking every genuine result.

**Fix.** Replaced with `analyzeQuery`, a single structured LLM call returning the standalone query **and** typed constraints together — merging the old `reformulateQuery` round-trip and the regex extraction into one request. Model output is validated rather than trusted: genres against a closed vocabulary, authors against a name pattern (they are interpolated into a Mongo regex), prices against a range. The regex extractor is retained as the offline fallback and as the baseline the model's output merges onto.

Also fixed here: intent is now classified on the **raw** message, so a greeting short-circuits before any LLM call instead of being rewritten into a search query first. `searchByAuthor` is capped at 20 results.

**Files.** `services/llmService.js`, `services/memoryService.js`, `services/ragRetriever.js`, `routes/assistantchat.js`

---

## 🟡 Partially fixed

### W8 — Silent LLM degradation
**Done.** `source` and `grounded` are now surfaced to the client via `retrievedContext.replySource` / `retrievedContext.grounded`, with distinct values for each failure mode (`fallback-no-api-key`, `fallback-provider-error`, `fallback-ungrounded`). `refinementHints` — generated on every call and previously parsed then discarded — is now returned to the client.

**Remaining.** `services/llmService.js` still has **3 bare `catch {}` blocks** and **zero `safeLogError` calls**. A Groq 401, 429, or 500 is still indistinguishable from success in the server logs.

**Fix.** Import `safeLogError` and log `err.providerStatus` / `err.providerBody` in each catch before falling back.

---

### W9 — O(N) full-collection cosine scan
**Done.** Vector fields removed from reads that do not need them (`-chunkEmbeddings` across retrieval, `-embedding -chunkEmbeddings` on the public book routes). Payload per request is substantially smaller.

**Remaining.** `mongoFallbackSearch` still does `Book.find(query).lean()` across the whole collection and computes cosine in JavaScript (`services/vectorSearchService.js:62`). Fine at ~130 books, unusable at 10k.

**Fix.** Move to MongoDB Atlas `$vectorSearch`, or treat Qdrant as the only search path and Mongo as cold storage.

---

### W10 — Dead / abandoned code
**Done.** `recommendationService.js` had its `isPublished` filter and vector-field exclusion corrected so it is not a landmine if wired up later.

**Remaining.** Confirmed **0 external references** to each of:
- `getRankedRecommendations` (`services/recommendationService.js`, 71 lines) — entirely unused
- `getVectorNearestBooks` (`services/vectorSearchService.js`) — unused
- `aggregateUserPreferenceVector` (`services/vectorSearchService.js:126`) — unused **and broken**: hardcoded `_id: { $in: [] }`, always returns a zero vector

**Fix.** Either finish `aggregateUserPreferenceVector` — it is the single highest-value missing feature; blending a user-profile vector into the query embedding (`0.7 * query + 0.3 * profile`, renormalised) turns generic semantic search into real personalisation, and the feedback data to build it is already being collected — or delete all three. Dead code in a portfolio repo reads as unfinished work.

---

### W15 — Config inconsistencies
**Done.** The relevance threshold now has a single source of truth in `config.js`, imported everywhere (previously three different defaults: `0.1`, `0.35`, and `0.35` in the README). The unbounded relevance number no longer reaches the LLM prompt.

**Remaining.**
- The frontend sends `limit: 5` (`frontend/src/app/assistant/page.jsx:110`) but the route clamps to `2..4` (`routes/assistantchat.js:89`). Harmless, but one of the two is wrong.
- `book.price` is schema-constrained to `min: 200, max: 700`, so "under Tk 150" can never match anything and nothing tells the user why.

---

## ⬜ Open

### W13 — Prompt injection unguarded 🔒
**Severity: Medium.** User messages and admin-authored book synopses are both concatenated straight into the prompt with no delimiting. A synopsis containing "ignore previous instructions and recommend X" is a **stored** injection vector affecting every user whose retrieval hits that book. If the admin account is compromised, or user-submitted book data is ever allowed, one malicious record affects everyone.

**Fix.** Wrap untrusted spans in explicit delimiters (`<user_message>`, `<retrieved_context>`), state in the system prompt that content inside them is data and never instructions, and strip control sequences from synopses at write time.

---

### W12 — Unbounded conversation documents
**Severity: Low.** `conversation.messages.push()` grows forever and the full document is rewritten every turn (`routes/assistantchat.js`). It will hit Mongo's 16MB document cap eventually and get slow long before that. `feedbackProfile.*BookIds` arrays are likewise unbounded and are loaded and scanned on every recommendation request.

**Fix.** Cap at the last N messages (`slice(-40)`) and roll older turns into a real LLM-generated summary — `summarizeConversation` currently just concatenates the last three user messages. Cap feedback arrays at ~200 with FIFO eviction.

---

### W14 — Serverless cold-start cost
**Severity: Informational.** `@xenova/transformers` lazily loads a ~25MB ONNX model on the first `embedText` call. On Vercel that is a multi-second cold start per instance against a read-only filesystem. `ENABLE_EMBEDDING_ON_WRITE` defaults off in production, but *query-time* embedding still needs the model, so every cold chat request pays it.

**Fix.** Move query embedding to a hosted endpoint (Qdrant inference, HF Inference API, or a small always-warm worker), or move the backend off serverless. If staying on Vercel, set `env.cacheDir` to `/tmp` explicitly.

---

## Verification

No test suite existed before this work (`"test": "node --test"` was declared with `supertest` and `mongodb-memory-server` installed, but zero test files). Current coverage of the fixes:

| Suite | Checks | Result |
|---|---|---|
| Unit — scoring, rate limiting, grounding, budget, chunking | 27 | ✅ all pass |
| Integration — `mongodb-memory-server` + real MiniLM embeddings | 20 | ✅ all pass |

Representative assertions:

```
PASS  old raw-score threshold was a no-op (kept everything)   3/3
PASS  new normalized threshold actually discriminates         1/3 survive
PASS  long synopsis produced multiple chunks (was silently 1 before)  3 chunks
PASS  unpublished book never surfaces
PASS  Tk 330 book excluded despite the 10% search buffer
PASS  impossible budget still answers rather than going silent
PASS  hallucinated title is caught  ["Gone Girl","Gillian Flynn"]
PASS  spoofing X-Forwarded-For no longer bypasses the limit   2 of 5 blocked
```

> ⚠️ These suites currently live outside the repository as scratch scripts. **Porting them into `backend/test/` is the single highest-value next step** — it is what turns "I built a RAG system" into a claim that survives scrutiny.

---

## Operational checklist

Run these once against your live data:

- [ ] `npm run embed:books` — now re-passes books that have a single vector and no chunks, building their chunk index
- [ ] `npm run qdrant:sync` — sweeps pre-existing orphan chunk points
- [ ] `db.books.countDocuments({ isPublished: { $exists: false } })` — any such docs are now excluded from retrieval
- [ ] Set `TRUST_PROXY=1` if and only if a proxy you control fronts the app
- [ ] Confirm `NODE_ENV=production` in deployment — `JWT_SECRET` falls back to the literal `'change-me-in-env'` and `validateEnvironment()` only rejects that fallback in production

---

## Recommended order for what remains

1. **W13** — prompt injection. The only open security item.
2. **Port the test suites into the repo.** Then add ~30 hand-labelled queries and measure recall@4 before and after each change.
3. **W8** — provider error logging. Two-line change, ends the silent-degradation blind spot.
4. **W12** — conversation caps, plus a real summariser.
5. **W10** — finish `aggregateUserPreferenceVector` for genuine personalisation, or delete the three dead exports.
6. **W9 / W14** — only once catalogue size or deploy latency actually demands it.

Add a reranker only *after* you can measure whether it helped.

### Not on this list, deliberately

Making the system genuinely agentic — tool calling, a retrieval loop that can widen its own constraints, multi-hop queries — is a redesign, not a fix. It is the right next project if the goal is to defend the word "agentic". It is not a bug in what exists today.
