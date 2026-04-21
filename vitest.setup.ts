// Set required env vars before any test modules are imported.
// dotenv won't override these since they're already set.
process.env.DB_USER = 'test_user';
process.env.DB_PASSWORD = 'test_password';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5433';
process.env.DB_NAME = 'test_db';
process.env.GEMINI_API_KEY = 'test-gemini-key';
