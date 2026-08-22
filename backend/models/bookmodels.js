import mongoose from "mongoose";

const stringArray = {
  type: [String],
  default: [],
};

const bookSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  author: { 
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    default: '',
    trim: true,
  },
  synopsis: {
    type: String,
    default: '',
    trim: true,
  },
  genre: {
    type: String,
    default: '',
    trim: true,
  },
  tags: stringArray,
  themes: stringArray,
  subjects: stringArray,
  language: {
    type: String,
    default: '',
    trim: true,
  },
  audience: {
    type: String,
    default: '',
    trim: true,
  },
  searchText: {
    type: String,
    default: '',
    index: true,
  },
  isPublished: {
    type: Boolean,
    default: true,
  },
  isFeatured: {
    type: Boolean,
    default: false,
    index: true,
  },
  publishedDate: {
    type: Date,
    required: true,
  },
  coverImage: {
    type: String,
    default: '',
  },
  price: {
    type: Number,
    default: null,
    min: 200,
    max: 700,
  },
  rating: {
    type: Number,
    default: null,
    min: 0,
    max: 5,
  },
  // Single whole-book vector: the mean of chunkEmbeddings. Used by the Mongo
  // cosine fallback and by the ranking layer's semanticMatch term.
  embedding: {
    type: [Number],
    required: false,
    sparse: true,
  },
  // Per-chunk vectors, one per ~200-word window of the embedding text. These
  // are what get indexed into Qdrant as separate points, so a long synopsis can
  // match on any passage rather than only its opening. Persisted here so that
  // re-syncing Qdrant from Mongo reproduces the chunk-level index instead of
  // silently collapsing it to a single vector.
  chunkEmbeddings: {
    type: [[Number]],
    required: false,
    default: undefined,
  },
  semanticMetadata: {
    embeddedAt: {
      type: Date,
      required: false,
    },
    modelVersion: {
      type: String,
      required: false,
    },
    chunkCount: {
      type: Number,
      required: false,
    },
  },
}, { timestamps: true });

bookSchema.pre('validate', function updateSearchText() {
  const parts = [
    this.title,
    this.author,
    this.description,
    this.synopsis,
    this.genre,
    ...(Array.isArray(this.tags) ? this.tags : []),
    ...(Array.isArray(this.themes) ? this.themes : []),
    ...(Array.isArray(this.subjects) ? this.subjects : []),
    this.language,
    this.audience,
  ];

  this.searchText = parts
    .filter(Boolean)
    .map((part) => String(part).trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
});

const Book = mongoose.model("Book", bookSchema);

export default Book;