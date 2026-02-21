# MERN Book Platform

Last updated: 2026-02-21

A role-based MERN application for book management and ordering.
- **Admin** manages books and monitors all orders.
- **Customer** signs up, logs in, browses available books, and places orders.

## Tech Stack
- **Backend:** Node.js, Express 5, MongoDB, Mongoose, JWT, bcryptjs, CORS
- **Frontend:** React 19, Vite 7, React Router 7, Axios, Tailwind CSS 4

## Project Structure
```text
blog-mern/
├── backend/
│   ├── config.js
│   ├── index.js
│   ├── middleware/auth.js
│   ├── models/
│   │   ├── bookmodels.js
│   │   ├── ordermodel.js
│   │   └── usermodel.js
│   ├── routes/
│   │   ├── authroutes.js
│   │   ├── bookrouts.js
│   │   └── orderroutes.js
│   └── .env.example
└── frontend/
    └── src/
        ├── components/ProtectedRoute.jsx
        ├── context/AuthContext.jsx
        ├── pages/
        └── utils/axios.js
```

## Core Features

### 1. Book Management (CRUD Operations)

#### Create Books
- Form-based book creation with input validation.
- Required fields: title, author, and published date.
- Automatic timestamp generation using `createdAt` and `updatedAt`.
- Validation error handling with clear form feedback.
- Responsive form layout for desktop, tablet, and mobile users.

#### Read Books
- Display all books in a dedicated list view.
- Show individual book details in a separate detailed page.
- Enable users to browse and filter through the book catalog.
- Responsive grid/list presentation for different screen sizes.
- Display key metadata such as title, author, and publication date.

#### Update Books
- Edit existing book records from the update page.
- Modify title, author, and published date fields.
- Real-time form validation while editing.
- Success feedback after update completion.
- Redirect users to the updated book details view on success.

#### Delete Books
- Delete books through a confirmation-driven flow.
- Prevent accidental deletion using a dedicated confirmation page.
- Permanently remove selected books from the database.
- Redirect users back to the book list after successful deletion.

### 2. User Interface Features

#### Navigation
- Clean and intuitive route structure across the application.
- Reusable back button component for quick return navigation.
- Route-based page transitions using React Router.
- Responsive navigation behavior across devices.

#### Loading States
- Reusable spinner component for loading scenarios.
- Visual feedback during API calls and page-level data fetching.
- Smooth transition experience between data states and pages.

#### Responsive Design
- Mobile-first styling approach using Tailwind CSS.
- Responsive layouts optimized for all major screen sizes.
- Utility-first Tailwind class usage for consistent UI styling.
- Cross-browser compatible interface behavior.

### 3. API Features

#### RESTful API Design
- Standard HTTP methods: `GET`, `POST`, `PUT`, and `DELETE`.
- JSON-based request and response payloads.
- Proper HTTP status code usage for success and error states.
- Centralized error handling and request validation.

#### CORS Configuration
- Cross-Origin Resource Sharing enabled on backend services.
- Development origin support for `http://localhost:5173`.
- Credentials and custom header support for frontend integration.

## API Access Rules

### Auth
- `POST /auth/signup` → Public
- `POST /auth/login` → Public
- `POST /auth/logout` → Logout flow endpoint

### Books
- `GET /books` → Public (returns un-ordered books)
- `GET /books/:id` → Public API (used in authenticated app flow)
- `POST /books` → Admin only
- `PUT /books/:id` → Admin only
- `DELETE /books/:id` → Admin only

### Orders
- `POST /orders` → Customer only
- `GET /orders` → Admin only

## Data Models
- **User**: `name`, `email` (unique), `password` (hashed), `role` (`customer`)
- **Book**: `title`, `author`, `publishedDate`, timestamps
- **Order**: `bookId`, `bookTitle`, `bookAuthor`, `customerName`, `customerAddress`, `customerPhone`, timestamps

## Security Measures Implemented

### Authentication & Authorization
- JWT verification middleware checks bearer token from `Authorization` header.
- Token expiry enforced server-side.
- Role-based middleware (`requireRole`) enforces endpoint access.
- Status boundaries:
  - `401` for missing/expired authentication
  - `403` for invalid token / insufficient permissions

### Password Security
- Customer passwords hashed with `bcryptjs` (10 rounds).
- Password checks use secure bcrypt comparison.
- Admin password supports bcrypt-hash in environment config.
- Plaintext admin password fallback exists for compatibility, but should be removed in production.

### Frontend Token Security
- Central Axios instance auto-attaches `Authorization: Bearer <token>`.
- Global `401` response handling clears local auth and redirects to login.
- Logout clears token/user state from client storage.

### CORS and Configuration Security
- CORS configured with explicit origins and allowed headers.
- `Authorization` header is allowed for bearer auth.
- Sensitive values are environment-driven via `.env`.

## Environment Configuration
Create `backend/.env` from `backend/.env.example`.

Required variables:
```env
PORT=5000
MONGODB_URL=mongodb://localhost:27017/blog
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRES_IN=7d
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<bcrypt-hash>
```

Generate admin password hash:
```bash
node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('your-password', 10).then(console.log);"
```

## Setup and Run

### Backend
```bash
cd backend
npm install
npm run dev
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Frontend scripts:
```bash
npm run dev
npm run build
npm run preview
npm run lint
```

Frontend development notes:
- Vite provides HMR for fast local development.
- React Compiler is not enabled in this setup by default.
- If you migrate to TypeScript, enable type-aware lint rules (`typescript-eslint`).

Default URLs:
- Backend: `http://localhost:5000`
- Frontend: `http://localhost:5173`

## Security Testing Checklist

### Authentication
- Protected routes reject requests without token.
- Invalid token returns `401/403` as expected.
- Expired token causes client redirect to login.
- Customer cannot access admin-only routes.
- Admin cannot access customer-only routes.

### Password and Session
- Customer passwords are stored hashed in DB.
- Admin login works with hashed admin password.
- Invalid credentials are rejected.
- Logout clears local auth state.

### Authorization Rules
- `POST/PUT/DELETE /books` requires admin token.
- `POST /orders` requires customer token.
- `GET /orders` requires admin token.

## cURL Security Verification Samples
```bash
# Customer signup
curl -X POST http://localhost:5000/auth/signup -H "Content-Type: application/json" -d '{"name":"Test User","email":"test@example.com","password":"password123"}'

# Customer login
curl -X POST http://localhost:5000/auth/login -H "Content-Type: application/json" -d '{"email":"test@example.com","password":"password123"}'

# Unauthorized admin action (should fail)
curl -X POST http://localhost:5000/books -H "Content-Type: application/json" -d '{"title":"Test","author":"Author","publishedDate":"2024"}'

# Admin login
curl -X POST http://localhost:5000/auth/login -H "Content-Type: application/json" -d '{"role":"admin","username":"admin","password":"admin123"}'
```

## Known Limitations
- Stateless JWT logout does not revoke already-issued tokens server-side.
- Token storage in local storage is more XSS-sensitive than httpOnly cookies.
- Single admin account model (no multi-admin management).
- No login rate limiting or brute-force lockout yet.
- Development defaults use HTTP; production must use HTTPS.

## Production Security Checklist

### Required
1. Use HTTPS/TLS end-to-end.
2. Set strong `JWT_SECRET` (32+ random chars).
3. Use bcrypt-hashed admin password.
4. Use secured MongoDB connection/authentication.
5. Never commit `.env`.
6. Restrict CORS to exact production origins.

### Recommended
1. Add `express-rate-limit` on auth endpoints.
2. Add request validation/sanitization middleware.
3. Add `helmet` security headers.
4. Add refresh token and revocation strategy.
5. Add structured logging and monitoring.
6. Run dependency checks (`npm audit`) regularly.
7. Add CSP policy and CSRF strategy if moving to cookie sessions.

### Optional
1. Token blacklist (e.g., Redis).
2. 2FA for admin account.
3. Account lockout after repeated failed logins.
4. Email verification flow for customer signup.
5. Audit trail for sensitive admin actions.
