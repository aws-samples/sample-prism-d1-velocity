# Feature: User Authentication (Login)

## Requirements
- [ ] Provide a POST endpoint at `/auth/login` that authenticates users
- [ ] Accept email and password in the request body
- [ ] Validate credentials against the in-memory user store
- [ ] Return a signed JWT token on successful authentication
- [ ] Return appropriate error responses for invalid credentials
- [ ] Validate request body schema before processing
- [ ] Log authentication attempts (success and failure) without logging passwords
- [ ] Create a default user with email "user@example.com" and password "password123"

## Acceptance Criteria
- Given a registered user with email "user@example.com" and password "password123", when POST /auth/login is called with those credentials, then return 200 with `{ "token": "<JWT>", "expiresIn": 3600 }`
- Given the returned JWT, when decoded, then it contains `{ "sub": "<userId>", "email": "user@example.com", "iat": <timestamp>, "exp": <timestamp+3600> }`
- Given a registered user, when POST /auth/login is called with the wrong password, then return 401 with Problem Details: `{ "title": "Unauthorized", "detail": "Invalid email or password" }`
- Given a non-existent email, when POST /auth/login is called, then return 401 with the same Problem Details as wrong-password (do not reveal whether the email exists)
- Given a request body missing "email", when POST /auth/login is called, then return 400 with Problem Details listing the missing field
- Given a request body missing "password", when POST /auth/login is called, then return 400 with Problem Details listing the missing field
- Given an empty request body, when POST /auth/login is called, then return 400 with Problem Details listing all missing fields
- Given a request with Content-Type other than application/json, when POST /auth/login is called, then return 415 Unsupported Media Type

## Design Constraints
- Password hashing: bcrypt with 10 salt rounds (in-memory store keeps hashed passwords)
- Token format: JWT signed with HS256 using a secret from environment variable `JWT_SECRET`
- Token lifetime: 3600 seconds (1 hour), configurable via environment variable `JWT_EXPIRY`
- User store: in-memory Map for workshop purposes (keyed by lowercase email)
- The user store is seeded with at least one test user on app startup
- Error responses must not differentiate between "user not found" and "wrong password" (security best practice)
- No session state -- tokens are stateless and self-contained
- All password comparisons use constant-time comparison (bcrypt.compare handles this)

## API Contract

### Request
- **Method:** POST
- **Path:** `/auth/login`
- **Headers:**
  - `Content-Type: application/json`
- **Body:**
```json
{
  "email": "string (required, valid email format)",
  "password": "string (required, min 8 chars)"
}
```

### Success Response (200)
```json
{
  "token": "string (JWT)",
  "expiresIn": 3600
}
```

### Error Responses

**400 Bad Request (validation failure):**
```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "Missing required fields: email, password",
  "instance": "/auth/login"
}
```

**401 Unauthorized (bad credentials):**
```json
{
  "type": "about:blank",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Invalid email or password",
  "instance": "/auth/login"
}
```

**415 Unsupported Media Type:**
```json
{
  "type": "about:blank",
  "title": "Unsupported Media Type",
  "status": 415,
  "detail": "Content-Type must be application/json",
  "instance": "/auth/login"
}
```
