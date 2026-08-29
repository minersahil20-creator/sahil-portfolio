// Vercel serverless function handler for Express app
const serverless = require('serverless-http');
const app = require('../server');

// This exports a handler function that Vercel can invoke
module.exports = serverless(app);
