import mongoose from 'mongoose';
import { EMBEDDING_MODEL, mongoDBURL } from '../config.js';
import Book from '../models/bookmodels.js';
import { embedAndSyncBook } from '../services/bookIndexer.js';

const EMBEDDING_MODEL_VERSION = EMBEDDING_MODEL;

const embedBooks = async () => {
  try {
    console.log('🚀 Starting book embedding process...');
    console.log(`📚 Model: ${EMBEDDING_MODEL_VERSION}`);

    // Connect to database
    await mongoose.connect(mongoDBURL);
    console.log('✅ Connected to MongoDB');

    // Books with no vectors at all, plus books embedded before chunking was
    // persisted (single vector, no chunkEmbeddings) — those need a re-pass.
    const books = await Book.find({
      $or: [
        { embedding: { $exists: false } },
        { embedding: null },
        { embedding: { $size: 0 } },
        { chunkEmbeddings: { $exists: false } },
        { chunkEmbeddings: { $size: 0 } },
      ],
    });
    console.log(`📖 Found ${books.length} books to embed`);

    if (books.length === 0) {
      console.log('ℹ️  All books already have embeddings!');
      await mongoose.disconnect();
      return;
    }

    let embeddedCount = 0;
    let failedCount = 0;
    const startTime = Date.now();

    for (let i = 0; i < books.length; i++) {
      const book = books[i];

      try {
        // Shared with the admin create/update routes, so a book embedded here
        // and a book embedded through the panel end up indexed identically.
        const result = await embedAndSyncBook(book);

        if (!result.embedded) {
          failedCount++;
          console.error(`❌ Nothing to embed for "${book.title}" (no title, synopsis or metadata)`);
          continue;
        }

        if (!result.synced) {
          console.warn(`⚠️ Qdrant sync skipped for "${book.title}" — run "npm run qdrant:sync" once it is reachable`);
        }

        embeddedCount++;

        // Log progress every 5 books
        if ((i + 1) % 5 === 0 || i === books.length - 1) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const rate = embeddedCount / (elapsed || 1);
          console.log(
            `⏳ Progress: ${i + 1}/${books.length} embedded | ${rate.toFixed(1)} books/sec | Time: ${elapsed}s`
          );
        }
      } catch (error) {
        failedCount++;
        console.error(`❌ Failed to embed book "${book.title}":`, error.message);
      }
    }

    const totalTime = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n✨ Embedding complete!`);
    console.log(`✅ Successfully embedded: ${embeddedCount} books`);
    console.log(`❌ Failed: ${failedCount} books`);
    console.log(`⏱️  Total time: ${totalTime}s`);

    if (embeddedCount > 0) {
      console.log(`📊 Avg: ${(totalTime / embeddedCount).toFixed(2)}s per book`);
    }

    // Verify embeddings
    const embeddedBooks = await Book.countDocuments({ embedding: { $exists: true, $ne: null } });
    console.log(`📈 Total books with embeddings: ${embeddedBooks}`);
  } catch (error) {
    console.error('💥 Fatal error during embedding:', error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
};

embedBooks();
