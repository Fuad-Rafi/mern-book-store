import express from 'express';
import mongoose from 'mongoose';
import ChatMemory from '../models/chatmemorymodel.js';
import User from '../models/usermodel.js';
import Book from '../models/bookmodels.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { generateAssistantReply, reformulateQuery } from '../services/llmService.js';
import { classifyQueryIntent, retrieveRelevantBooks } from '../services/ragRetriever.js';
import {
  RAG_RELEVANCE_THRESHOLD,
  RAG_SEMANTIC_FLOOR,
  RATE_LIMIT_ASSISTANT_CHAT_PER_MINUTE,
  RATE_LIMIT_ASSISTANT_FEEDBACK_PER_MINUTE,
} from '../config.js';
import { safeLogError } from '../utils/securityLogger.js';
import { summarizeConversation } from '../services/memoryService.js';

const router = express.Router();

const MAX_MESSAGE_LENGTH = 1000;
const FEEDBACK_EVENTS = ['like', 'dislike', 'click', 'view'];

const FEEDBACK_FIELD_BY_EVENT = {
  like: 'likedBookIds',
  dislike: 'dislikedBookIds',
  click: 'clickedBookIds',
  view: 'viewedBookIds',
};

const assistantChatRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_ASSISTANT_CHAT_PER_MINUTE,
  message: 'Too many chat requests. Please retry shortly.',
});

const assistantFeedbackRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_ASSISTANT_FEEDBACK_PER_MINUTE,
  message: 'Too many feedback requests. Please retry shortly.',
});

const mergeStringArrays = (existing = [], incoming = []) => {
  return [...new Set([...(existing || []), ...(incoming || [])].filter(Boolean))];
};

const pushUniqueObjectId = (values = [], id) => {
  const asStrings = new Set((values || []).map((item) => String(item)));
  if (!asStrings.has(String(id))) {
    values.push(id);
  }
};

const removeObjectId = (values = [], id) => {
  return (values || []).filter((item) => String(item) !== String(id));
};

const buildGroundedRecommendations = (books = []) => {
  return books.map((book) => ({
    _id: book._id,
    title: book.title,
    author: book.author,
    genre: book.genre,
    synopsis: book.synopsis || book.description,
    price: book.price,
    rating: book.rating,
    relevanceScore: Number(book.relevanceScore ?? 0),
  }));
};

const summarizeRecentConversation = (messages = []) => {
  return summarizeConversation(messages);
};

router.post('/chat', authenticateToken, requireRole('customer'), assistantChatRateLimiter, async (req, res) => {
  try {
    const rawMessage = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!rawMessage) {
      return res.status(400).json({ message: 'Message is required' });
    }

    if (rawMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ message: `Message must be <= ${MAX_MESSAGE_LENGTH} characters` });
    }

    const requestedLimit = Number(req.body.limit ?? 3);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 2), 4)
      : 3;

    let conversation;
    if (req.body.conversationId && mongoose.Types.ObjectId.isValid(String(req.body.conversationId))) {
      conversation = await ChatMemory.findOne({
        _id: req.body.conversationId,
        userId: req.user.id,
      });
    }

    if (!conversation) {
      conversation = await ChatMemory.create({
        userId: req.user.id,
        messages: [],
      });
    }

    const userMessageEntry = {
      role: 'user',
      content: rawMessage,
      retrievedBookIds: [],
      createdAt: new Date(),
    };

    let searchMessage = rawMessage;
    if (conversation.messages.length > 0) {
      searchMessage = await reformulateQuery(conversation.messages, rawMessage);
    }

    const intent = classifyQueryIntent(searchMessage);
    let assistantReply = '';
    let responseRecommendations = [];
    let recommendedBookIds = [];
    let retrievedContext = {
      query: rawMessage,
      constraints: {},
      relevanceThreshold: RAG_RELEVANCE_THRESHOLD,
      semanticFloor: RAG_SEMANTIC_FLOOR,
      retrievedCount: 0,
    };

    if (intent.isGreeting || intent.isEmpty || intent.isClarification) {
      assistantReply = 'Hello! Tell me a genre, author, or budget, and I will retrieve matching books.';
    } else {
      const retrieval = await retrieveRelevantBooks({
        userId: req.user.id,
        userQuery: searchMessage,
        limit,
      });

      retrievedContext = {
        query: retrieval.query,
        constraints: retrieval.constraints,
        relevanceThreshold: retrieval.relevanceThreshold,
        semanticFloor: retrieval.semanticFloor,
        retrievedCount: retrieval.retrievedBooks.length,
      };

      if (!retrieval.retrievedBooks.length) {
        assistantReply = 'I could not find strong matches for that request. Try adding a genre, author, or budget range.';
      } else {
        const llmResult = await generateAssistantReply({
          userMessage: rawMessage,
          retrievedBooks: retrieval.retrievedBooks,
          chatHistory: conversation.messages,
        });

        assistantReply = llmResult.assistantReply;

        const recommendedTitleSet = new Set(llmResult.recommendedTitles || []);
        const selectedBooks = recommendedTitleSet.size > 0
          ? retrieval.retrievedBooks.filter((book) => recommendedTitleSet.has(book.title)).slice(0, limit)
          : retrieval.retrievedBooks.slice(0, limit);

        const groundedBooks = selectedBooks.length > 0
          ? selectedBooks
          : retrieval.retrievedBooks.slice(0, limit);

        responseRecommendations = buildGroundedRecommendations(groundedBooks);
        recommendedBookIds = groundedBooks.map((book) => book._id);
      }
    }

    const assistantMessageEntry = {
      role: 'assistant',
      content: assistantReply,
      retrievedBookIds: recommendedBookIds,
      createdAt: new Date(),
    };

    conversation.messages.push(userMessageEntry);
    conversation.messages.push(assistantMessageEntry);
    conversation.summary = summarizeRecentConversation(conversation.messages);
    conversation.lastMessageAt = new Date();
    await conversation.save();

    return res.status(200).json({
      conversationId: conversation._id,
      assistantMessage: assistantMessageEntry.content,
      recommendations: responseRecommendations,
      retrievedContext,
      memorySummary: conversation.summary,
    });
  } catch (error) {
    safeLogError('Chat error', error, { conversationId: req.body?.conversationId, userId: req.user?.id });
    return res.status(500).json({ message: 'Failed to process chat request' });
  }
});

router.post('/feedback', authenticateToken, requireRole('customer'), assistantFeedbackRateLimiter, async (req, res) => {
  try {
    const eventType = typeof req.body.eventType === 'string' ? req.body.eventType.trim().toLowerCase() : '';
    const bookId = typeof req.body.bookId === 'string' ? req.body.bookId.trim() : '';
    const conversationId = typeof req.body.conversationId === 'string' ? req.body.conversationId.trim() : '';

    if (!FEEDBACK_EVENTS.includes(eventType)) {
      return res.status(400).json({ message: 'eventType must be one of: like, dislike, click, view' });
    }

    if (!mongoose.Types.ObjectId.isValid(bookId)) {
      return res.status(400).json({ message: 'A valid bookId is required' });
    }

    const [user, book] = await Promise.all([
      User.findById(req.user.id),
      Book.findById(bookId).lean(),
    ]);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!book) {
      return res.status(404).json({ message: 'Book not found' });
    }

    user.feedbackProfile = user.feedbackProfile || {};
    user.feedbackProfile.likedBookIds = user.feedbackProfile.likedBookIds || [];
    user.feedbackProfile.dislikedBookIds = user.feedbackProfile.dislikedBookIds || [];
    user.feedbackProfile.clickedBookIds = user.feedbackProfile.clickedBookIds || [];
    user.feedbackProfile.viewedBookIds = user.feedbackProfile.viewedBookIds || [];

    const targetField = FEEDBACK_FIELD_BY_EVENT[eventType];
    pushUniqueObjectId(user.feedbackProfile[targetField], new mongoose.Types.ObjectId(bookId));

    if (eventType === 'like') {
      user.feedbackProfile.dislikedBookIds = removeObjectId(user.feedbackProfile.dislikedBookIds, bookId);
    }

    if (eventType === 'dislike') {
      user.feedbackProfile.likedBookIds = removeObjectId(user.feedbackProfile.likedBookIds, bookId);
    }

    const genre = typeof book.genre === 'string' ? book.genre.trim().toLowerCase() : '';
    user.preferences = user.preferences || {};
    user.preferences.preferredGenres = user.preferences.preferredGenres || [];
    user.preferences.dislikedGenres = user.preferences.dislikedGenres || [];

    if (eventType === 'like' && genre) {
      user.preferences.preferredGenres = mergeStringArrays(user.preferences.preferredGenres, [genre]);
      user.preferences.dislikedGenres = user.preferences.dislikedGenres.filter((item) => String(item).toLowerCase() !== genre);
    }

    if (eventType === 'dislike' && genre) {
      user.preferences.dislikedGenres = mergeStringArrays(user.preferences.dislikedGenres, [genre]);
      user.preferences.preferredGenres = user.preferences.preferredGenres.filter((item) => String(item).toLowerCase() !== genre);
    }

    user.feedbackProfile.updatedAt = new Date();
    await user.save();

    if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
      const conversation = await ChatMemory.findOne({ _id: conversationId, userId: req.user.id });
      if (conversation) {
        const targetMessage = [...conversation.messages]
          .reverse()
          .find(
            (message) => message.role === 'assistant'
              && (message.retrievedBookIds || []).some((id) => String(id) === String(bookId))
          );

        if (targetMessage) {
          targetMessage.feedback = targetMessage.feedback || {};
          targetMessage.feedback.likedBookIds = targetMessage.feedback.likedBookIds || [];
          targetMessage.feedback.dislikedBookIds = targetMessage.feedback.dislikedBookIds || [];
          targetMessage.feedback.clickedBookIds = targetMessage.feedback.clickedBookIds || [];
          targetMessage.feedback.viewedBookIds = targetMessage.feedback.viewedBookIds || [];
          pushUniqueObjectId(targetMessage.feedback[targetField], new mongoose.Types.ObjectId(bookId));
          conversation.markModified('messages');
          await conversation.save();
        }
      }
    }

    return res.status(200).json({
      message: 'Feedback recorded',
      eventType,
      bookId,
      profileSnapshot: {
        preferredGenres: user.preferences.preferredGenres || [],
        dislikedGenres: user.preferences.dislikedGenres || [],
        likedBookIds: (user.feedbackProfile.likedBookIds || []).map((id) => String(id)),
        dislikedBookIds: (user.feedbackProfile.dislikedBookIds || []).map((id) => String(id)),
        clickedBookIds: (user.feedbackProfile.clickedBookIds || []).map((id) => String(id)),
        viewedBookIds: (user.feedbackProfile.viewedBookIds || []).map((id) => String(id)),
      },
    });
  } catch (error) {
    safeLogError('Feedback error', error, {
      eventType: req.body?.eventType,
      conversationId: req.body?.conversationId,
      userId: req.user?.id,
    });
    return res.status(500).json({ message: 'Failed to record feedback' });
  }
});

export default router;
