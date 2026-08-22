import express from 'express';
import Book from '../models/bookmodels.js';
import Order from '../models/ordermodel.js';
import User from '../models/usermodel.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { rankBooks, buildHistorySignals } from '../utils/recommendationScoring.js';

const router = express.Router();

router.get('/', authenticateToken, requireRole('customer'), async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const limitValue = Number(req.query.limit ?? 6);
    const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.trunc(limitValue), 1), 10) : 6;

    const [user, books, orders] = await Promise.all([
      User.findById(req.user.id).lean(),
      Book.find({ isPublished: true }).lean(),
      Order.find({ customerId: req.user.id }).lean(),
    ]);

    const historySignals = buildHistorySignals(orders, books, user?.feedbackProfile || {});
    const userPreferences = user?.preferences || {};
    const orderedBookIds = new Set(
      orders
        .map((order) => String(order.bookRef || order.bookId || ''))
        .filter(Boolean)
    );
    const candidateBooks = books.filter((book) => !orderedBookIds.has(String(book._id)));

    const rankedBooks = rankBooks({
      books: candidateBooks.length > 0 ? candidateBooks : books,
      query,
      userPreferences,
      historySignals,
      limit,
    });

    return res.status(200).json({
      count: rankedBooks.length,
      query,
      recommendations: rankedBooks.map(({ book, score, breakdown }) => ({
        ...book,
        score,
        scoreBreakdown: breakdown,
      })),
    });
  } catch (error) {
    console.error('Error building recommendations:', error.message);
    return res.status(500).json({ message: 'Failed to build recommendations' });
  }
});

export default router;