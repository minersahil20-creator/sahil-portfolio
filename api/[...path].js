// Vercel serverless function handler for Express app
const serverless = require('serverless-http');
const app = require('../server');

module.exports = serverless(app);
