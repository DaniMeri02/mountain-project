// Set required env vars before any test modules are imported.
// dotenv won't override these since they're already set.
process.env.DB_USER = 'test_user';
process.env.DB_PASSWORD = 'test_password';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5433';
process.env.DB_NAME = 'test_db';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.YOUTUBE_API_KEY = 'test-youtube-key';
process.env.REDDIT_CLIENT_ID = 'test-reddit-id';
process.env.REDDIT_CLIENT_SECRET = 'test-reddit-secret';
process.env.MAPBOX_TOKEN = 'pk.test-mapbox-token';
