import express from 'express';
import mongoose from 'mongoose';
import bookRoutes from './routes/bookrouts.js';
import authRoutes from './routes/authroutes.js';
import orderRoutes from './routes/orderroutes.js';
import recommendationRoutes from './routes/bookrecommendations.js';
import assistantChatRoutes from './routes/assistantchat.js';
import seedRoutes from './routes/seedroutes.js';
import { mongoDBURL, PORT, TRUST_PROXY, validateEnvironment } from './config.js';
import { safeLogError } from './utils/securityLogger.js';
import cors from 'cors';

const app = express();

validateEnvironment();

// Controls whether Express derives req.ip from X-Forwarded-For. Off by default
// so the rate limiter cannot be bypassed by spoofing that header.
app.set('trust proxy', TRUST_PROXY ? 1 : false);

const localOrigins = ['http://localhost:3000', 'http://localhost:3002', 'http://localhost:5000'];
const envOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : [];
const allowedOrigins = [...new Set([...localOrigins, ...envOrigins])];
const localhostOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

const isOriginAllowed = (origin) => {
  if (!origin) {
    // Allow non-browser requests that do not send an Origin header.
    return true;
  }

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  return localhostOriginPattern.test(origin);
};

// Middleware to handle CORS - single configuration
app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware to parse JSON bodies
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.send('Hello, World!');
});

const connectionOptions = {
  maxPoolSize: 5,
  minPoolSize: 0,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
};

let cachedConnection = global.mongooseConnection;
let cachedConnectionPromise = global.mongooseConnectionPromise;

const connectDB = async () => {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  if (!cachedConnectionPromise) {
    const maskedUrl = mongoDBURL.replace(/\/\/.*@/, '//****:****@');
    console.log(`Connecting to MongoDB at ${maskedUrl}`);
    cachedConnectionPromise = mongoose.connect(mongoDBURL, connectionOptions);
    global.mongooseConnectionPromise = cachedConnectionPromise;
  }

  cachedConnection = await cachedConnectionPromise;
  global.mongooseConnection = cachedConnection;
  return cachedConnection;
};

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    safeLogError('Database connection failure', error);
    res.status(500).json({ message: 'Database connection failed' });
  }
});

app.use('/books/recommendations', recommendationRoutes);
app.use('/books', bookRoutes);
app.use('/assistant', assistantChatRoutes);
app.use('/auth', authRoutes);
app.use('/orders', orderRoutes);
app.use('/admin', seedRoutes);

app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

app.use((error, req, res, next) => {
  safeLogError('Unhandled API error', error, {
    method: req?.method,
    path: req?.originalUrl,
  });

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({ message: 'Internal server error' });
});

if (process.env.VERCEL !== '1') {
  connectDB()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
      });
    })
    .catch((error) => {
      safeLogError('Error connecting to MongoDB', error);
    });
}

export default app;

