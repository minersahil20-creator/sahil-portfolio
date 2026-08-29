require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const express = require('express');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Vercel serverless functions can only write to /tmp. For local/dev hosting,
// keep using the project data folder. For durable production storage, connect a DB.
const DATA_DIR = process.env.VERCEL ? path.join('/tmp', 'sahil-portfolio-data') : path.join(__dirname, 'data');
const BOOKINGS_PATH = path.join(DATA_DIR, 'bookings.json');
const REVIEWS_PATH = path.join(DATA_DIR, 'reviews.json');

const SERVICE_PLANS = [
  {
    id: 'basic',
    name: 'Basic Plan',
    price: 550,
    tagline: 'Single responsive landing page and essential polish.'
  },
  {
    id: 'silver',
    name: 'Silver Plan',
    price: 1050,
    tagline: 'Multi-section portfolio, animations, and contact-ready setup.'
  },
  {
    id: 'gold',
    name: 'Gold Plan',
    price: 2050,
    tagline: 'Premium portfolio build with advanced interactions and checkout support.'
  }
];

const ADD_ONS = [
  { id: 'extra-page', name: 'Extra Page', price: 300 },
  { id: 'seo-boost', name: 'SEO Starter Boost', price: 400 },
  { id: 'priority-delivery', name: 'Priority Delivery', price: 500 },
  { id: 'copy-polish', name: 'Content Polish', price: 250 }
];

const pendingOrders = new Map();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    frameguard: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net', 'https://avatars.githubusercontent.com'],
        connectSrc: ["'self'", 'https://api.github.com'],
        frameAncestors: null,
        formAction: ["'self'"],
        objectSrc: ["'none'"]
      }
    }
  })
);
app.use(express.json({ limit: '60kb' }));

const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many checkout attempts. Please wait and try again.' }
});

const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many review submissions. Please try again later.' }
});

function normalizeEmail(email = '') {
  return String(email).trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function isValidUpiId(upiId = '') {
  return /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9._-]{2,64}$/.test(String(upiId).trim());
}

function cleanText(value = '', maxLength = 120) {
  return String(value)
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function hasEmailConfig() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getMailTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function hasBrevoConfig() {
  return Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
}

function hasAnyEmailConfig() {
  return hasBrevoConfig() || hasEmailConfig();
}

async function sendTransactionalEmail({ to, toName = '', subject, text, html }) {
  const toEmail = normalizeEmail(to);
  if (!isValidEmail(toEmail)) {
    const error = new Error('Recipient email address is invalid.');
    error.status = 400;
    throw error;
  }

  if (hasBrevoConfig()) {
    const senderEmail = normalizeEmail(process.env.BREVO_SENDER_EMAIL);
    if (!isValidEmail(senderEmail)) {
      const error = new Error('Brevo sender email is invalid.');
      error.status = 503;
      throw error;
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': process.env.BREVO_API_KEY.trim(),
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: {
          email: senderEmail,
          name: cleanText(process.env.BREVO_SENDER_NAME || 'Sahil Portfolio', 80)
        },
        to: [
          {
            email: toEmail,
            name: cleanText(toName, 80) || undefined
          }
        ],
        subject: cleanText(subject, 180),
        htmlContent: html,
        textContent: text
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const detail = cleanText(payload.message || response.statusText || 'Unknown Brevo API error', 220);
      console.error(`Brevo email delivery failed (${response.status}): ${detail}`);
      const error = new Error('Brevo email delivery failed. Please verify the Brevo API key and sender email.');
      error.status = 503;
      throw error;
    }

    return response.json().catch(() => ({}));
  }

  if (hasEmailConfig()) {
    const transport = getMailTransport();
    return transport.sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: toEmail,
      subject,
      disableFileAccess: true,
      disableUrlAccess: true,
      text,
      html
    });
  }

  const error = new Error('Email service is not configured.');
  error.status = 503;
  throw error;
}

function getUpiConfig() {
  const upiId = cleanText(process.env.UPI_ID || '', 320);
  const payeeName = cleanText(process.env.UPI_PAYEE_NAME || 'Sahil Sinha', 80);
  const transactionNote = cleanText(process.env.UPI_TRANSACTION_NOTE || 'Sahil Portfolio Booking', 80);

  return {
    upiId,
    payeeName,
    transactionNote,
    ready: isValidUpiId(upiId)
  };
}

function maskUpiId(upiId = '') {
  const [handle, bank] = upiId.split('@');
  if (!handle || !bank) return '';
  const visible = handle.length <= 4 ? handle : `${handle.slice(0, 3)}***${handle.slice(-1)}`;
  return `${visible}@${bank}`;
}

function buildUpiUri({ upiId, payeeName, amount, note }) {
  // Keep this as a simple personal-UPI deep link. Some UPI apps reject merchant-only
  // params such as transaction reference (`tr`) when the payee is a normal UPI ID.
  const params = [
    ['pa', upiId],
    ['pn', payeeName],
    ['am', Number(amount).toFixed(2)],
    ['cu', 'INR'],
    ['tn', note]
  ]
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');

  return `upi://pay?${params}`;
}

function findPlan(planId) {
  return SERVICE_PLANS.find((plan) => plan.id === planId);
}

function calculateQuote({ planId, addons = [], customWork = {} }) {
  const plan = findPlan(planId);
  if (!plan) {
    const error = new Error('Please select a valid service plan.');
    error.status = 400;
    throw error;
  }

  const uniqueAddonIds = [...new Set(Array.isArray(addons) ? addons : [])];
  const selectedAddons = uniqueAddonIds.map((addonId) => {
    const addon = ADD_ONS.find((item) => item.id === addonId);
    if (!addon) {
      const error = new Error('One or more selected add-ons are invalid.');
      error.status = 400;
      throw error;
    }
    return addon;
  });

  const customDescription = cleanText(customWork.description || '', 180);
  const customAmount = Number(customWork.amount || 0);
  const roundedCustomAmount = Math.round(customAmount);
  let normalizedCustomWork = null;

  if (customWork.enabled || customDescription || roundedCustomAmount > 0) {
    if (!Number.isFinite(customAmount) || roundedCustomAmount < 0 || roundedCustomAmount > 50000) {
      const error = new Error('Custom work amount must be between ₹0 and ₹50,000.');
      error.status = 400;
      throw error;
    }

    normalizedCustomWork = {
      description: customDescription || 'Custom extra work',
      price: roundedCustomAmount
    };
  }

  const subtotal =
    plan.price +
    selectedAddons.reduce((sum, addon) => sum + addon.price, 0) +
    (normalizedCustomWork ? normalizedCustomWork.price : 0);
  const total = subtotal;

  return {
    plan,
    addons: selectedAddons,
    customWork: normalizedCustomWork,
    subtotal,
    total
  };
}

function normalizePhone(phone = '') {
  return String(phone).trim().replace(/[^\d+()\s-]/g, '').replace(/\s+/g, ' ');
}

function isValidPhone(phone = '') {
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function validateBookingIdentity(body) {
  const name = cleanText(body.name, 80);
  const phone = normalizePhone(body.phone || body.number);
  const email = normalizeEmail(body.email);

  if (name.length < 2) {
    const error = new Error('Please enter your full name.');
    error.status = 400;
    throw error;
  }

  if (!isValidPhone(phone)) {
    const error = new Error('Please enter a valid phone number.');
    error.status = 400;
    throw error;
  }

  if (!isValidEmail(email)) {
    const error = new Error('Please enter a valid email address.');
    error.status = 400;
    throw error;
  }

  return { name, phone, email };
}

function publicQuote(quote) {
  return {
    plan: quote.plan,
    addons: quote.addons,
    customWork: quote.customWork,
    subtotal: quote.subtotal,
    total: quote.total
  };
}

async function readJsonArray(filePath) {
  try {
    const existing = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(existing);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeJsonArray(filePath, rows) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(rows, null, 2)}\n`);
}

async function appendBooking(booking) {
  const bookings = await readJsonArray(BOOKINGS_PATH);
  bookings.push(booking);
  await writeJsonArray(BOOKINGS_PATH, bookings);
}

function maskEmail(email = '') {
  const [name, domain] = normalizeEmail(email).split('@');
  if (!name || !domain) return '';
  const visible = name.length <= 3 ? `${name[0] || ''}***` : `${name.slice(0, 2)}***${name.slice(-1)}`;
  return `${visible}@${domain}`;
}

function validateReview(body) {
  const name = cleanText(body.name || 'Portfolio Client', 80);
  const email = normalizeEmail(body.email);
  const description = cleanText(body.description || '', 700);
  const rating = Number(body.rating);

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    const error = new Error('Please select a star rating between 1 and 5.');
    error.status = 400;
    throw error;
  }

  if (!isValidEmail(email)) {
    const error = new Error('Please enter a valid email address for your review.');
    error.status = 400;
    throw error;
  }

  if (description.length < 10) {
    const error = new Error('Please write a review with at least 10 characters.');
    error.status = 400;
    throw error;
  }

  return { name, email, rating, description };
}

function publicReview(review) {
  return {
    id: review.id,
    name: review.name,
    emailMasked: maskEmail(review.email),
    rating: review.rating,
    description: review.description,
    createdAt: review.createdAt
  };
}

async function readReviews() {
  const reviews = await readJsonArray(REVIEWS_PATH);
  return reviews
    .filter((review) => review.status !== 'hidden')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function appendReview(review) {
  const reviews = await readJsonArray(REVIEWS_PATH);
  reviews.push(review);
  await writeJsonArray(REVIEWS_PATH, reviews);
}

async function notifyReviewSubmitted(review) {
  if (!hasAnyEmailConfig()) return false;

  const ownerEmail = process.env.BOOKING_NOTIFY_EMAIL || process.env.BREVO_SENDER_EMAIL || process.env.SMTP_USER;
  if (!ownerEmail) return false;

  await sendTransactionalEmail({
    to: ownerEmail,
    toName: 'Sahil Sinha',
    subject: `New ${review.rating}-star portfolio review`,
    text: `New portfolio review submitted.\n\nName: ${review.name}\nEmail: ${review.email}\nRating: ${review.rating}/5\nReview: ${review.description}\nSubmitted: ${review.createdAt}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #111;">
        <h2>New portfolio review</h2>
        <p><strong>Name:</strong> ${escapeHtml(review.name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(review.email)}</p>
        <p><strong>Rating:</strong> ${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)} (${review.rating}/5)</p>
        <p><strong>Review:</strong></p>
        <p>${escapeHtml(review.description)}</p>
        <p><strong>Submitted:</strong> ${escapeHtml(review.createdAt)}</p>
      </div>
    `
  });

  return true;
}

async function notifyBookingSubmitted(booking) {
  if (!hasAnyEmailConfig()) return false;

  const ownerEmail = process.env.BOOKING_NOTIFY_EMAIL || process.env.BREVO_SENDER_EMAIL || process.env.SMTP_USER;
  if (!ownerEmail) return false;

  const addons = booking.quote.addons.map((addon) => `${addon.name} (₹${addon.price})`).join(', ') || 'None';
  const customWork = booking.quote.customWork
    ? `${booking.quote.customWork.description} (₹${booking.quote.customWork.price})`
    : 'None';

  await sendTransactionalEmail({
    to: ownerEmail,
    toName: 'Sahil Sinha',
    subject: `New UPI booking submitted: ${booking.bookingId}`,
    text: `New booking submitted for manual UPI verification.\n\nBooking ID: ${booking.bookingId}\nName: ${booking.name}\nPhone: ${booking.phone}\nEmail: ${booking.email}\nPlan: ${booking.quote.plan.name}\nAdd-ons: ${addons}\nCustom work: ${customWork}\nTotal: ₹${booking.quote.total}\nUPI Reference/UTR: ${booking.upi.utr}\nUPI Transaction Ref: ${booking.upi.transactionRef}\n\nPlease confirm this payment in your UPI/bank app before starting work.`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #111;">
        <h2>New UPI booking submitted</h2>
        <p><strong>Booking ID:</strong> ${escapeHtml(booking.bookingId)}</p>
        <p><strong>Name:</strong> ${escapeHtml(booking.name)}</p>
        <p><strong>Phone:</strong> ${escapeHtml(booking.phone)}</p>
        <p><strong>Email:</strong> ${escapeHtml(booking.email)}</p>
        <p><strong>Plan:</strong> ${escapeHtml(booking.quote.plan.name)}</p>
        <p><strong>Add-ons:</strong> ${escapeHtml(addons)}</p>
        <p><strong>Custom work:</strong> ${escapeHtml(customWork)}</p>
        <p><strong>Total:</strong> ₹${booking.quote.total}</p>
        <p><strong>UPI Reference/UTR:</strong> ${escapeHtml(booking.upi.utr)}</p>
        <p><strong>UPI Transaction Ref:</strong> ${escapeHtml(booking.upi.transactionRef)}</p>
        <p>Please confirm this payment in your UPI/bank app before starting work.</p>
      </div>
    `
  });

  return true;
}

function cleanupExpiredMemory() {
  const now = Date.now();

  for (const [orderId, order] of pendingOrders.entries()) {
    if (order.expiresAt < now) pendingOrders.delete(orderId);
  }
}

setInterval(cleanupExpiredMemory, 5 * 60 * 1000).unref();

app.get('/api/config', (_req, res) => {
  const upi = getUpiConfig();

  res.json({
    plans: SERVICE_PLANS,
    addons: ADD_ONS,
    emailProvider: hasBrevoConfig() ? 'brevo' : hasEmailConfig() ? 'smtp' : 'development',
    paymentMethod: 'upi',
    paymentsReady: upi.ready,
    upiReady: upi.ready,
    upiPayeeName: upi.payeeName,
    upiIdMasked: upi.ready ? maskUpiId(upi.upiId) : ''
  });
});

app.post('/api/create-order', checkoutLimiter, async (req, res, next) => {
  try {
    const upi = getUpiConfig();
    if (!upi.ready) {
      const error = new Error('UPI payment is not configured yet. Add UPI_ID to .env to enable checkout.');
      error.status = 503;
      throw error;
    }

    const { name, phone, email } = validateBookingIdentity(req.body);
    const quote = calculateQuote(req.body);
    const orderId = `UPI${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const bookingId = `BK${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const transactionRef = orderId.replace(/[^A-Z0-9]/gi, '').slice(0, 35);
    const note = cleanText(`${upi.transactionNote} ${bookingId}`, 80);
    const upiUri = buildUpiUri({
      upiId: upi.upiId,
      payeeName: upi.payeeName,
      amount: quote.total,
      note
    });
    const qrDataUrl = await QRCode.toDataURL(upiUri, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: {
        dark: '#0b1220',
        light: '#ffffff'
      }
    });

    const pendingBooking = {
      bookingId,
      orderId,
      name,
      phone,
      email,
      quote: publicQuote(quote),
      paymentMethod: 'upi',
      status: 'upi_created',
      upi: {
        upiId: upi.upiId,
        payeeName: upi.payeeName,
        transactionRef,
        note
      },
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 60 * 60 * 1000
    };

    pendingOrders.set(orderId, pendingBooking);

    res.json({
      order: {
        id: orderId,
        amount: quote.total,
        currency: 'INR',
        expiresAt: pendingBooking.expiresAt
      },
      booking: publicQuote(quote),
      payment: {
        method: 'upi',
        upiId: upi.upiId,
        payeeName: upi.payeeName,
        upiUri,
        qrDataUrl,
        transactionRef,
        note
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/reviews', async (_req, res, next) => {
  try {
    const reviews = await readReviews();
    res.json({ reviews: reviews.slice(0, 12).map(publicReview) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/reviews', reviewLimiter, async (req, res, next) => {
  try {
    const reviewInput = validateReview(req.body);
    const review = {
      id: `RV${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      ...reviewInput,
      status: 'published',
      createdAt: new Date().toISOString()
    };

    await appendReview(review);

    let emailSent = false;
    let emailWarning = '';
    try {
      emailSent = await notifyReviewSubmitted(review);
      if (!emailSent) emailWarning = 'Email provider is not configured, but the review was saved.';
    } catch (mailError) {
      emailWarning = 'Review was saved, but email notification could not be delivered from this environment.';
      console.error('Unable to send review notification email:', mailError.message);
    }

    res.status(201).json({
      success: true,
      emailSent,
      warning: emailWarning,
      review: publicReview(review),
      message: emailSent
        ? 'Thank you! Your review was submitted and emailed successfully.'
        : 'Thank you! Your review was submitted. Email notification will work when the email provider is reachable.'
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/verify-payment', checkoutLimiter, async (req, res, next) => {
  try {
    const orderId = cleanText(req.body.orderId || req.body.upi_order_id, 80);
    const utr = cleanText(req.body.utr || req.body.upiTransactionId, 40).toUpperCase();
    const payerName = cleanText(req.body.payerName || '', 80);

    if (!orderId || !/^[A-Z0-9-]{8,40}$/i.test(orderId)) {
      const error = new Error('Invalid UPI order reference. Please create the payment request again.');
      error.status = 400;
      throw error;
    }

    if (!utr || !/^[A-Z0-9-]{6,36}$/i.test(utr)) {
      const error = new Error('Please enter a valid UPI transaction ID / UTR after payment.');
      error.status = 400;
      throw error;
    }

    const pendingBooking = pendingOrders.get(orderId);
    if (!pendingBooking) {
      const error = new Error('Booking order not found or has expired. Please create a new UPI payment request.');
      error.status = 404;
      throw error;
    }

    const storedBooking = {
      ...pendingBooking,
      status: 'payment_submitted_pending_manual_verification',
      paymentSubmittedAt: new Date().toISOString(),
      upi: {
        ...pendingBooking.upi,
        utr,
        payerName: payerName || pendingBooking.name
      }
    };

    delete storedBooking.expiresAt;
    await appendBooking(storedBooking);
    pendingOrders.delete(orderId);

    let notificationSent = false;
    try {
      notificationSent = await notifyBookingSubmitted(storedBooking);
    } catch (error) {
      console.error('Unable to send booking notification email:', error.message);
    }

    res.json({
      success: true,
      bookingId: storedBooking.bookingId,
      orderId,
      paymentReference: utr,
      status: storedBooking.status,
      notificationSent,
      message: 'Payment details submitted. Your booking is pending manual UPI verification.'
    });
  } catch (error) {
    next(error);
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ message: 'API route not found.' });
});

app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((req, res) => {
  res.status(404).type('text/plain').send(`Not found: ${req.path}`);
});

app.use((error, _req, res, _next) => {
  const status = error.status || error.statusCode || 500;
  const message = status >= 500 && status !== 503 ? 'Server error. Please try again later.' : error.message;
  if (status >= 500 && status !== 503) console.error(error);
  res.status(status).json({ message });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Sahil portfolio server running at http://${HOST}:${PORT}`);
  });
}

module.exports = app;
