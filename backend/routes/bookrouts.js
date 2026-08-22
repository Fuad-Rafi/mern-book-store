import express from 'express';
import Book from '../models/bookmodels.js';
import { authenticateToken, optionalAuthenticateToken, requireRole } from '../middleware/auth.js';
import { normalizeBookPayload } from '../utils/ragData.js';
import { deleteBookPoint } from '../services/qdrantService.js';
import { embedAndSyncBook } from '../services/bookIndexer.js';
import { ENABLE_EMBEDDING_ON_WRITE } from '../config.js';
import { safeLogError } from '../utils/securityLogger.js';

const router = express.Router();
const FEATURED_POOL_LIMIT = 11;

// Vector fields are large (384 floats each, one per chunk) and no client needs
// them. Excluded from every read that returns books over the wire.
const WITHOUT_VECTORS = '-embedding -chunkEmbeddings';

const getNormalizedFeaturedBooks = async () => {
    let featuredBooks = await Book.find({ isFeatured: true }).select(WITHOUT_VECTORS).sort({ updatedAt: -1 });

    // Only trim if over the limit, do NOT auto-refill if under
    if (featuredBooks.length > FEATURED_POOL_LIMIT) {
        const overflowBooks = featuredBooks.slice(FEATURED_POOL_LIMIT);
        await Book.updateMany(
            { _id: { $in: overflowBooks.map((book) => book._id) } },
            { $set: { isFeatured: false } }
        );
        featuredBooks = featuredBooks.slice(0, FEATURED_POOL_LIMIT);
    }

    // If less than limit, just return as is (no refill)
    return featuredBooks;
};

const parseOptionalPrice = (value) => {
    if (value === '' || value === null || value === undefined) {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 200 || parsed > 700) {
        return undefined;
    }

    return parsed;
};

const parseOptionalRating = (value) => {
    if (value === '' || value === null || value === undefined) {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5) {
        return undefined;
    }

    return parsed;
};

const buildBookPayload = (body) => {
    const normalized = normalizeBookPayload(body);
    const parsedPrice = parseOptionalPrice(body.price);
    const parsedRating = parseOptionalRating(body.rating);

    if (parsedPrice === undefined || parsedRating === undefined) {
        return undefined;
    }

    return {
        ...normalized,
        price: parsedPrice,
        rating: parsedRating,
    };
};

// route to get all books
router.get('/', optionalAuthenticateToken, async (req, res) => {
    try {
        const books = await Book.find({}).select(WITHOUT_VECTORS);

        res.json({
            count: books.length,
            books
        });
    } catch (error) {
        safeLogError('Error fetching books', error);
        res.status(500).json({ message: error.message });
    }
});

// route to get featured books for home carousel
router.get('/featured/list', optionalAuthenticateToken, async (req, res) => {
    try {
        const featuredBooks = await getNormalizedFeaturedBooks();
        res.json({ count: featuredBooks.length, books: featuredBooks });
    } catch (error) {
        safeLogError('Error fetching featured books', error);
        res.status(500).json({ message: error.message });
    }
});

// route to mark a book as featured until the fixed pool is full
router.post('/:id/feature', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const targetBook = await Book.findById(req.params.id);
        if (!targetBook) {
            return res.status(404).json({ message: 'Book not found' });
        }

        if (targetBook.isFeatured) {
            return res.status(400).json({ message: 'Book is already featured' });
        }

        const featuredBooks = await getNormalizedFeaturedBooks();
        const featuredCount = featuredBooks.length;
        if (featuredCount >= FEATURED_POOL_LIMIT) {
            return res.status(409).json({
                message: `Featured pool is full. Maximum ${FEATURED_POOL_LIMIT} books allowed.`,
                currentCount: featuredCount,
            });
        }

        targetBook.isFeatured = true;
        await targetBook.save();

        return res.json({
            message: 'Book added to featured carousel',
            featuredBookId: targetBook._id,
            replacedBookId: null,
        });
    } catch (error) {
        safeLogError('Error featuring book', error);
        return res.status(500).json({ message: error.message });
    }
});

// route to unfeature a book (remove from featured list)
router.post('/:id/unfeature', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const targetBook = await Book.findById(req.params.id);
        if (!targetBook) {
            return res.status(404).json({ message: 'Book not found' });
        }
        if (!targetBook.isFeatured) {
            return res.status(400).json({ message: 'Book is not featured' });
        }
        targetBook.isFeatured = false;
        await targetBook.save();
        return res.json({ message: 'Book removed from featured list', bookId: targetBook._id });
    } catch (error) {
        safeLogError('Error unfeaturing book', error);
        return res.status(500).json({ message: error.message });
    }
});
// route to get one book by ID
router.get('/:id', optionalAuthenticateToken, async (req, res) => {
    try {
        const book = await Book.findById(req.params.id).select(WITHOUT_VECTORS);
        if (!book) {
            return res.status(404).json({ message: 'Book not found' });
        }
        res.json(book);
    } catch (error) {
        safeLogError('Error fetching book', error);
        res.status(500).json({ message: error.message });
    }
});

//route to update a new book (admin only)
router.put('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const payload = buildBookPayload(req.body);
        if (!payload) {
            return res.status(400).json({ message: 'Invalid price value' });
        }

        if (!payload.title || !payload.author || !payload.publishedDate) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const updatedBook = await Book.findByIdAndUpdate(req.params.id, payload, {
            new: true,
            runValidators: true,
        });

        if (!updatedBook) {
            return res.status(404).json({ message: 'Book not found' });
        }

        if (ENABLE_EMBEDDING_ON_WRITE) {
            try {
                await embedAndSyncBook(updatedBook);
            } catch (error) {
                safeLogError('Qdrant update sync failed', error, { bookId: updatedBook._id });
            }
        }

        res.json(updatedBook);
    } catch (error) {
        safeLogError('Error updating book', error);
        res.status(500).json({ message: error.message });
    }
});

//route to delete a book by ID (admin only)
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const deletedBook = await Book.findByIdAndDelete(req.params.id);

        if (!deletedBook) {
            return res.status(404).json({ message: 'Book not found' });
        }

        try {
            await deleteBookPoint(req.params.id);
        } catch (error) {
            safeLogError('Qdrant delete sync failed', error, { bookId: req.params.id });
        }

        res.json({ message: 'Book deleted successfully' });
    } catch (error) {
        safeLogError('Error deleting book', error);
        res.status(500).json({ message: error.message });
    }
});

//route to create a new book (admin only)
router.post('/', authenticateToken, requireRole('admin'), async (request, response) => {
    try {
        console.log('Book creation request received. Payload:', JSON.stringify(request.body, null, 2));
        const payload = buildBookPayload(request.body);

        if (!payload) {
            console.warn('Book payload validation failed: Invalid price or rating');
            return response.status(400).json({ message: 'Invalid price value' });
        }

        if (!payload.title || !payload.author || !payload.publishedDate) {
            console.warn('Book payload validation failed: Missing required fields', {
                title: !!payload.title,
                author: !!payload.author,
                publishedDate: !!payload.publishedDate
            });
            return response.status(400).json({ message: 'Missing required fields' });
        }

        const newBook = new Book({
            ...payload,
        });

        const savedBook = await newBook.save();
        console.log(`Book successfully saved to database with ID: ${savedBook._id}`);

        if (ENABLE_EMBEDDING_ON_WRITE) {
            console.log(`Starting embedding generation for book ${savedBook._id}...`);
            try {
                await embedAndSyncBook(savedBook);
                console.log(`Embedding generation and sync successful for book ${savedBook._id}`);
            } catch (error) {
                safeLogError('Qdrant create sync failed', error, { bookId: savedBook._id });
            }
        }

        response.status(201).json(savedBook);
    } catch (error) {
        safeLogError('Error creating book', error);
        response.status(500).json({ message: error.message });
    }
});

// Route to sync missing embeddings for all books (admin only)
// Critical for production: ENABLE_EMBEDDING_ON_WRITE=0 in Vercel means
// books added via Admin panel have no vectors. Call this to fix them.
router.post('/sync-embeddings', authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        // Books with no embedding at all, plus books embedded before chunking was
        // persisted — those have a single vector and no chunkEmbeddings, so they
        // still need a pass to build their chunk-level index.
        const booksToSync = await Book.find({
            $or: [
                { embedding: { $exists: false } },
                { embedding: null },
                { embedding: { $size: 0 } },
                { chunkEmbeddings: { $exists: false } },
                { chunkEmbeddings: { $size: 0 } },
            ],
        });

        if (booksToSync.length === 0) {
            return res.json({ message: 'All books already have embeddings.', synced: 0, total: 0 });
        }

        console.log(`Starting embedding sync for ${booksToSync.length} books...`);

        let synced = 0;
        let failed = 0;
        const errors = [];

        for (const book of booksToSync) {
            try {
                await embedAndSyncBook(book);
                synced++;
                console.log(`[sync] Embedded book ${book._id} (${book.title})`);
            } catch (err) {
                failed++;
                errors.push({ bookId: String(book._id), title: book.title, error: err.message });
                safeLogError('Sync embedding failed', err, { bookId: book._id });
            }
        }

        return res.json({
            message: `Sync complete. ${synced} books embedded, ${failed} failed.`,
            synced,
            failed,
            total: booksToSync.length,
            errors: errors.length > 0 ? errors : undefined,
        });
    } catch (error) {
        safeLogError('Error in sync-embeddings', error);
        return res.status(500).json({ message: error.message });
    }
});

export default router;
