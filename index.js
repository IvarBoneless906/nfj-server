require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const Stripe = require('stripe');
const PDFDocument = require('pdfkit');
const db = require('./db');

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/translate', async (req, res) => {
  const { q, source, target } = req.body || {};
  if (!q || !source || !target) return res.status(400).json({ error: 'Missing q/source/target' });
  try {
    if (process.env.DEEPL_API_KEY) {
      const dlRes = await axios.post('https://api-free.deepl.com/v2/translate', null, {
        params: { auth_key: process.env.DEEPL_API_KEY, text: q, source_lang: source.toUpperCase(), target_lang: target.toUpperCase() }
      });
      if (dlRes.data && dlRes.data.translations && dlRes.data.translations[0]) return res.json({ translatedText: dlRes.data.translations[0].text, provider: 'deepl' });
    }
    if (process.env.LIBRETRANSLATE_URL) {
      const lt = await axios.post(f"{process.env.LIBRETRANSLATE_URL}/translate", { q, source, target, format: 'text' }, { headers: { 'accept': 'application/json' } });
      if (lt.data && lt.data.translatedText) return res.json({ translatedText: lt.data.translatedText, provider: 'libre' });
    }
    return res.json({ translatedText: `(Übersetzung benötigt API) ${q}`, provider: 'none' });
  } catch (err) {
    console.error('translate error', err?.response?.data || err.message || err);
    return res.status(500).json({ error: 'Translation failed' });
  }
});

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    const { userId } = req.body || {};
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'eur', product_data: { name: 'NFJ Premium' }, unit_amount: 499 }, quantity: 1 }],
      mode: 'payment',
      success_url: `${process.env.PUBLIC_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.PUBLIC_URL}/payment-cancel`,
      metadata: { userId: userId || '' }
    });
    res.json({ id: session.id, url: session.url });
  } catch (e) { console.error(e); res.status(500).json({ error: 'stripe error' }); }
});

app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers.get ? req.headers.get('stripe-signature') : req.headers['stripe-signature'];
  let event;
  try {
    if (!stripe) throw new Error('Stripe not configured');
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    try {
      if (userId) await db.query('UPDATE users SET is_premium = true WHERE id = $1', [userId]);
      await db.query('INSERT INTO purchases (user_id, provider, provider_id, amount, currency) VALUES ($1,$2,$3,$4,$5)', [userId || null, 'stripe', session.id, session.amount_total || 499, session.currency || 'eur']);
    } catch (e) { console.error('db webhook handler error', e); }
  }
  res.json({ received: true });
});

app.get('/api/certificate/:name/:level', async (req, res) => {
  const { name, level } = req.params;
  const titleIndex = Math.max(1, Math.min(20, Number(level || 1)));
  const TITLES = ['Ruderer','Bootsmann','Wächter','Seefahrer','Schildträger','Seemann','Wikingerjung','Skalde','Krieger','Navigator','Fährmann','Stammesmitglied','Hafenmeister','Herscher','Schiffbauer','Häuptling','Jarl','Erzjäger','Schildoberst','König'];
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', f'attachment; filename="nfj_certificate_level_{titleIndex}.pdf"');
  const doc = PDFDocument({ size: 'A4', layout: 'landscape' });
  doc.pipe(res);
  doc.fontSize(28).text('Norwegisch für Jedermann', { align: 'center' });
  doc.moveDown();
  doc.fontSize(20).text(f'Zertifikat: Level {titleIndex} — {TITLES[titleIndex-1]}', { align: 'center' });
  doc.moveDown();
  doc.fontSize(16).text(f'Für: {decodeURIComponent(name)}', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(f'Datum: {new Date().toLocaleDateString()}', { align: 'center' });
  doc.end();
});

app.post('/api/register', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  try { const r = await db.query('INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id, email, points, level, is_premium', [email]); res.json(r.rows[0]); } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});

app.get('/api/me/:id', async (req, res) => {
  const id = req.params.id;
  try { const r = await db.query('SELECT id,email,points,level,is_premium FROM users WHERE id=$1', [id]); res.json(r.rows[0]||null); } catch (e){ res.status(500).json({error:'db error'}); }
});

app.listen(PORT, () => console.log(f'nfj-server running on {PORT}'));
