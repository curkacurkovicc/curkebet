// ćurkebet — jednostavan prediction market za ekipu.
// Pokretanje: DATABASE_URL=postgres://... npm start
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const START = Number(process.env.START_BALANCE || 1000); // početno stanje novog naloga
const DAILY = 100;                                   // dnevni bonus
const TZ = process.env.TIMEZONE || 'Europe/Belgrade'; // kada počinje novi dan
const INVITE_CODE = (process.env.INVITE_CODE || '').trim(); // opciono: kod za registraciju

if (!process.env.DATABASE_URL) {
  console.error('Nedostaje DATABASE_URL (Postgres connection string).');
  process.exit(1);
}
const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(process.env.DATABASE_URL) || process.env.PGSSL === 'off';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  balance BIGINT NOT NULL DEFAULT 0,
  bonus_total BIGINT NOT NULL DEFAULT 0,
  last_claim DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS markets (
  id SERIAL PRIMARY KEY,
  creator_id INT NOT NULL REFERENCES users(id),
  question TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  closes_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',       -- open | resolved | cancelled
  outcome TEXT,                              -- YES | NO
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bets (
  id SERIAL PRIMARY KEY,
  market_id INT NOT NULL REFERENCES markets(id),
  user_id INT NOT NULL REFERENCES users(id),
  side TEXT NOT NULL,                        -- YES | NO
  amount BIGINT NOT NULL CHECK (amount > 0),
  payout BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bets_market ON bets(market_id);
CREATE INDEX IF NOT EXISTS bets_user ON bets(user_id);
`;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
// Stranice (svi fajlovi su u istom folderu, bez podfoldera)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(['/uputstvo', '/uputstvo.html'], (req, res) => res.sendFile(path.join(__dirname, 'uputstvo.html')));

// ---------- pomoćne funkcije ----------
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const num = v => (v == null ? 0 : Number(v));

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: 'Greška na serveru.' });
});

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

function getCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSession(req, res, token) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}${secure}`);
}
async function newSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions(token_hash, user_id) VALUES ($1, $2)', [sha(token), userId]);
  setSession(req, res, token);
}
async function auth(req) {
  const t = getCookie(req, 'sid');
  if (!t) throw new HttpError(401, 'Nisi prijavljen.');
  const r = await pool.query('SELECT u.id, u.display FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1', [sha(t)]);
  if (!r.rows[0]) throw new HttpError(401, 'Nisi prijavljen.');
  return r.rows[0];
}
// Dnevni bonus: atomično, najviše jednom po danu.
async function claimDaily(userId) {
  const r = await pool.query(
    `UPDATE users SET balance = balance + $2, bonus_total = bonus_total + $2, last_claim = $3
     WHERE id = $1 AND (last_claim IS NULL OR last_claim < $3) RETURNING id`,
    [userId, DAILY, today()]);
  return r.rowCount > 0;
}

// Jednostavno ograničenje pokušaja prijave (po IP + korisničkom imenu).
const attempts = new Map();
function checkRate(key) {
  const now = Date.now(), a = attempts.get(key);
  if (a && now - a.t < 15 * 60e3 && a.n >= 10) throw new HttpError(429, 'Previše pokušaja. Pokušaj ponovo za 15 minuta.');
}
function failRate(key) {
  const now = Date.now(), a = attempts.get(key);
  if (!a || now - a.t > 15 * 60e3) attempts.set(key, { n: 1, t: now }); else a.n++;
  if (attempts.size > 5000) attempts.clear();
}

// ---------- nalozi ----------
app.get('/api/config', (req, res) => res.json({ inviteRequired: !!INVITE_CODE, daily: DAILY, start: START }));

app.post('/api/register', wrap(async (req, res) => {
  const display = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_.ČčĆćŠšŽžĐđ-]{3,20}$/.test(display)) throw new HttpError(400, 'Korisničko ime: 3–20 slova, brojeva ili _ . -');
  if (password.length < 6 || password.length > 200) throw new HttpError(400, 'Šifra mora imati bar 6 znakova.');
  if (INVITE_CODE && String(req.body.invite || '').trim() !== INVITE_CODE) throw new HttpError(403, 'Pogrešan pozivni kod.');
  const hash = await bcrypt.hash(password, 10);
  let user;
  try {
    // Početno stanje; dnevni bonus kreće od sledećeg dana.
    user = (await pool.query(
      `INSERT INTO users(username, display, pass_hash, balance, bonus_total, last_claim)
       VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`,
      [display.toLowerCase(), display, hash, START, today()])).rows[0];
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'To korisničko ime je zauzeto.');
    throw e;
  }
  await newSession(req, res, user.id);
  res.json({ ok: true });
}));

app.post('/api/login', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = req.ip + '|' + username;
  checkRate(key);
  const u = (await pool.query('SELECT id, pass_hash FROM users WHERE username = $1', [username])).rows[0];
  if (!u || !(await bcrypt.compare(password, u.pass_hash))) { failRate(key); throw new HttpError(401, 'Pogrešno korisničko ime ili šifra.'); }
  attempts.delete(key);
  await newSession(req, res, u.id);
  res.json({ ok: true });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const t = getCookie(req, 'sid');
  if (t) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha(t)]);
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
}));

app.post('/api/password', wrap(async (req, res) => {
  const me = await auth(req);
  const { oldPassword = '', newPassword = '' } = req.body;
  if (String(newPassword).length < 6) throw new HttpError(400, 'Nova šifra mora imati bar 6 znakova.');
  const u = (await pool.query('SELECT pass_hash FROM users WHERE id = $1', [me.id])).rows[0];
  if (!(await bcrypt.compare(String(oldPassword), u.pass_hash))) throw new HttpError(401, 'Stara šifra nije tačna.');
  await pool.query('UPDATE users SET pass_hash = $2 WHERE id = $1', [me.id, await bcrypt.hash(String(newPassword), 10)]);
  res.json({ ok: true });
}));

// ---------- stanje (sve što ekran treba) ----------
app.get('/api/state', wrap(async (req, res) => {
  const me = await auth(req);
  const bonus = await claimDaily(me.id);
  const markets = (await pool.query(
    `SELECT m.*, u.display AS creator FROM markets m JOIN users u ON u.id = m.creator_id
     ORDER BY m.created_at DESC LIMIT 300`)).rows;
  const ids = markets.map(m => m.id);
  const bets = ids.length ? (await pool.query(
    `SELECT b.market_id, b.user_id, u.display AS name, b.side, b.amount, b.payout, b.created_at
     FROM bets b JOIN users u ON u.id = b.user_id WHERE b.market_id = ANY($1) ORDER BY b.created_at DESC`, [ids])).rows : [];
  const players = (await pool.query(
    `SELECT u.id, u.display AS name, u.balance, u.bonus_total, COALESCE(o.open, 0) AS open
     FROM users u LEFT JOIN (
       SELECT b.user_id, SUM(b.amount) AS open FROM bets b JOIN markets m ON m.id = b.market_id
       WHERE m.status = 'open' GROUP BY b.user_id) o ON o.user_id = u.id`)).rows;

  const byMarket = {};
  for (const b of bets) (byMarket[b.market_id] ||= []).push({
    userId: b.user_id, name: b.name, side: b.side, amount: num(b.amount),
    payout: b.payout == null ? null : num(b.payout), ts: b.created_at.getTime(),
  });
  res.json({
    serverNow: Date.now(),
    bonus,
    daily: DAILY,
    start: START,
    me: { id: me.id, name: me.display },
    markets: markets.map(m => ({
      id: m.id, creatorId: m.creator_id, creator: m.creator, question: m.question, description: m.description,
      closesAt: m.closes_at.getTime(), createdAt: m.created_at.getTime(), status: m.status, outcome: m.outcome,
      resolvedAt: m.resolved_at ? m.resolved_at.getTime() : null, bets: byMarket[m.id] || [],
    })),
    players: players.map(p => ({ id: p.id, name: p.name, balance: num(p.balance), bonusTotal: num(p.bonus_total), open: num(p.open) })),
  });
}));

// ---------- tržišta ----------
app.post('/api/markets', wrap(async (req, res) => {
  const me = await auth(req);
  const question = String(req.body.question || '').trim();
  const description = String(req.body.description || '').trim();
  const closesAt = Number(req.body.closesAt);
  if (question.length < 3 || question.length > 200) throw new HttpError(400, 'Pitanje mora imati 3–200 znakova.');
  if (description.length > 1000) throw new HttpError(400, 'Opis je predugačak.');
  if (!Number.isFinite(closesAt) || closesAt < Date.now() + 60e3) throw new HttpError(400, 'Rok mora biti u budućnosti.');
  if (closesAt > Date.now() + 2 * 365 * 864e5) throw new HttpError(400, 'Rok je predaleko.');
  const r = await pool.query(
    'INSERT INTO markets(creator_id, question, description, closes_at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0)) RETURNING id',
    [me.id, question, description, closesAt]);
  res.json({ id: r.rows[0].id });
}));

app.post('/api/markets/:id/bet', wrap(async (req, res) => {
  const me = await auth(req);
  const id = Number(req.params.id);
  const side = req.body.side;
  const amount = Number(req.body.amount);
  if (side !== 'YES' && side !== 'NO') throw new HttpError(400, 'Izaberi DA ili NE.');
  if (!Number.isInteger(amount) || amount < 1 || amount > 1e12) throw new HttpError(400, 'Neispravan iznos.');
  const balance = await tx(async c => {
    const m = (await c.query('SELECT status, closes_at FROM markets WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!m) throw new HttpError(404, 'Pitanje ne postoji.');
    if (m.status !== 'open' || m.closes_at.getTime() <= Date.now()) throw new HttpError(409, 'Opklade su zatvorene.');
    const u = await c.query('UPDATE users SET balance = balance - $2 WHERE id = $1 AND balance >= $2 RETURNING balance', [me.id, amount]);
    if (!u.rowCount) throw new HttpError(400, 'Nemaš dovoljno para.');
    await c.query('INSERT INTO bets(market_id, user_id, side, amount) VALUES ($1, $2, $3, $4)', [id, me.id, side, amount]);
    return num(u.rows[0].balance);
  });
  res.json({ ok: true, balance });
}));

// Samo onaj ko je postavio pitanje može da ga reši.
app.post('/api/markets/:id/resolve', wrap(async (req, res) => {
  const me = await auth(req);
  const id = Number(req.params.id);
  const outcome = req.body.outcome; // YES | NO | CANCEL
  if (!['YES', 'NO', 'CANCEL'].includes(outcome)) throw new HttpError(400, 'Neispravan ishod.');
  await tx(async c => {
    const m = (await c.query('SELECT creator_id, status FROM markets WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!m) throw new HttpError(404, 'Pitanje ne postoji.');
    if (m.creator_id !== me.id) throw new HttpError(403, 'Samo onaj ko je postavio pitanje može da ga reši.');
    if (m.status !== 'open') throw new HttpError(409, 'Pitanje je već rešeno.');
    const bets = (await c.query('SELECT id, user_id, side, amount FROM bets WHERE market_id = $1 ORDER BY amount DESC, id', [id])).rows
      .map(b => ({ ...b, amount: num(b.amount) }));
    const total = bets.reduce((a, b) => a + b.amount, 0);
    const win = outcome === 'CANCEL' ? 0 : bets.filter(b => b.side === outcome).reduce((a, b) => a + b.amount, 0);
    const refund = outcome === 'CANCEL' || win === 0;
    let paid = 0;
    for (const b of bets) {
      b.payout = refund ? b.amount : (b.side === outcome ? Math.floor(b.amount * total / win) : 0);
      paid += b.payout;
    }
    // ostatak od zaokruživanja ide najvećem dobitniku
    if (!refund && total > paid) bets.find(b => b.side === outcome).payout += total - paid;
    const perUser = {};
    for (const b of bets) {
      await c.query('UPDATE bets SET payout = $2 WHERE id = $1', [b.id, b.payout]);
      perUser[b.user_id] = (perUser[b.user_id] || 0) + b.payout;
    }
    for (const [uid, amt] of Object.entries(perUser)) {
      if (amt) await c.query('UPDATE users SET balance = balance + $2 WHERE id = $1', [Number(uid), amt]);
    }
    await c.query(
      `UPDATE markets SET status = $2, outcome = $3, resolved_at = now() WHERE id = $1`,
      [id, outcome === 'CANCEL' ? 'cancelled' : 'resolved', outcome === 'CANCEL' ? null : outcome]);
  });
  res.json({ ok: true });
}));

app.get('/healthz', (req, res) => res.send('ok'));

pool.query(SCHEMA)
  .then(() => app.listen(PORT, () => console.log(`ćurkebet radi na portu ${PORT}`)))
  .catch(e => { console.error('Ne mogu da se povežem na bazu:', e.message); process.exit(1); });
