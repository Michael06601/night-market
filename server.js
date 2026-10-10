'use strict';
// Night Market backend. Zero dependencies: needs only Node.js 18 or newer.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';          // use 0.0.0.0 so friends on your network can connect
const OPEN_RIDERS = process.env.RIDER_SIGNUP === 'open'; // default: riders need admin approval
const SECURE = process.env.COOKIE_SECURE === '1' ? '; Secure' : ''; // set COOKIE_SECURE=1 when served over HTTPS
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');
const PUB = path.join(__dirname, 'public');
const CATS = ['Fashion', 'Electronics', 'Collectibles', 'Home', 'Beauty', 'Sports', 'Other'];
const PAYS = ['Crypto']; // crypto only: no cash, no bank transfers
const TIMES = ['As soon as possible', 'Tonight, 9pm to midnight', 'Late night, after midnight'];
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

// ---------- storage: one JSON file, written atomically ----------
let db = { users: [], sessions: {}, listings: [], messages: [], orders: [], reports: [], invites: [], seq: 1 };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { /* first run */ }
db.invites = db.invites || [];
db.listings.forEach(l => { l.pay = ['Crypto']; }); // older listings may still list cash
let timer = null;
function flush() { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); }
function save() { clearTimeout(timer); timer = setTimeout(flush, 150); }
process.on('uncaughtException', e => console.error('Unexpected error:', e));
process.on('unhandledRejection', e => console.error('Unexpected error:', e));
process.on('SIGINT', () => { flush(); process.exit(); });
process.on('SIGTERM', () => { flush(); process.exit(); });
const nid = () => db.seq++, now = () => Date.now();

// ---------- helpers ----------
class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = m => new HttpErr(400, m), deny = (m = 'Not allowed') => new HttpErr(403, m), nf = () => new HttpErr(404, 'Not found');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function checkPw(pw, u) { const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); }
const fails = {};
function cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function authUser(req) {
  const s = cookies(req).sid, rec = s && db.sessions[s];
  if (!rec) return null;
  if (rec.exp < now()) { delete db.sessions[s]; return null; }
  const usr = db.users.find(x => x.id === rec.uid);
  return usr && !usr.banned ? usr : null;
}
function readBody(req) {
  return new Promise((ok, no) => {
    let n = 0; const c = [];
    req.on('data', d => { n += d.length; if (n > 1000000) { no(new HttpErr(413, 'Request too large')); req.destroy(); return; } c.push(d); });
    req.on('end', () => { if (!c.length) return ok({}); try { ok(JSON.parse(Buffer.concat(c).toString())); } catch (e) { no(bad('Bad JSON')); } });
    req.on('error', no);
  });
}
function send(res, code, obj, extra) {
  const b = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, extra));
  res.end(b);
}
const pubUser = u => ({ id: u.id, name: u.name, isAdmin: !!u.isAdmin, rider: u.rider || null, wallet: u.wallet || '' });
const uname = id => (db.users.find(u => u.id === id) || {}).name || 'Unknown';
const listing = id => db.listings.find(l => l.id === id);
function rating(sid) { const r = db.orders.filter(o => o.sellerId === sid && o.rating).map(o => o.rating); return { n: r.length, avg: r.length ? +(r.reduce((a, b) => a + b) / r.length).toFixed(1) : 0 }; }
const listingPub = l => ({ id: l.id, title: l.title, desc: l.desc, price: l.price, cat: l.cat, pay: l.pay, coins: l.coins || '', img: l.img || null, sellerId: l.sellerId, seller: uname(l.sellerId), rating: rating(l.sellerId) });
function orderView(o, u) {
  const l = listing(o.listingId) || {};
  const v = { id: o.id, listingId: o.listingId, title: l.title, price: l.price, pay: o.pay, time: o.time, step: o.step, sellerName: uname(o.sellerId), buyerName: uname(o.buyerId), riderName: o.riderId ? uname(o.riderId) : null, rating: o.rating || null };
  v.fee = o.fee || 0;
  if (o.buyerId === u.id) {
    v.role = 'buying'; v.addr = o.addr; v.recipient = o.recipient || ''; v.phone = o.phone || '';
    if (o.step >= 1 && o.step <= 3) v.code = o.code;   // the delivery code, to be given to whoever receives the package
    if (o.counter) v.counter = { rider: uname(o.counter.riderId), fee: o.counter.fee };
    if (o.riderId && o.step >= 1) v.riderWallet = (db.users.find(y => y.id === o.riderId) || {}).wallet || '';
  } else v.role = 'selling';
  return v;
}
function jobView(o, u) {
  const l = listing(o.listingId) || {}, mine = o.riderId === u.id;
  return {
    id: o.id, title: l.title, sellerName: uname(o.sellerId), pay: o.pay, time: o.time, step: o.step, mine, fee: o.fee || 0,
    addr: mine ? o.addr : null, recipient: mine ? (o.recipient || uname(o.buyerId)) : null, phone: mine ? (o.phone || '') : null,
    myCounter: o.counter && o.counter.riderId === u.id ? o.counter.fee : null,
    locked: !!(o.counter && o.counter.riderId !== u.id && !mine)
  };
}
function newSession(u) {
  const t = crypto.randomBytes(32).toString('hex');
  db.sessions[t] = { uid: u.id, exp: now() + 30 * 864e5 }; save();
  return [200, pubUser(u), { 'Set-Cookie': `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${SECURE}` }];
}
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// ---------- API ----------
async function api(req, url) {
  const m = req.method, p = url.pathname.replace(/^\/api/, '');
  if (m !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) throw bad('JSON only');
  const body = m === 'GET' ? {} : await readBody(req);
  const u = authUser(req);
  const me = () => { if (!u) throw new HttpErr(401, 'Please log in'); return u; };
  const rider = () => { if (me().rider !== 'approved') throw deny('Only approved riders can do this'); return u; };
  let x;

  if (m === 'GET' && p === '/me') return [200, { user: u ? pubUser(u) : null, needInvite: db.users.length > 0 }];
  if (m === 'POST' && p === '/signup') {
    const name = str(body.name, 24), pw = String(body.password || '');
    if (!/^[\w .-]{2,24}$/.test(name)) throw bad('Name must be 2 to 24 letters, numbers, spaces, dots or dashes');
    if (pw.length < 6) throw bad('Password needs at least 6 characters');
    if (db.users.some(y => y.name.toLowerCase() === name.toLowerCase())) throw bad('That name is taken');
    let inv = null;
    if (db.users.length) {
      inv = db.invites.find(i => i.code === str(body.invite, 20).toUpperCase() && !i.usedBy);
      if (!inv) throw bad('You need a valid invite code from a member');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const nu = { id: nid(), name, salt, hash: hashPw(pw, salt), isAdmin: db.users.length === 0, rider: null, invitedBy: inv ? inv.by : null, at: now() };
    if (body.rider) nu.rider = OPEN_RIDERS ? 'approved' : 'pending';
    if (inv) inv.usedBy = nu.id;
    db.users.push(nu); return newSession(nu);
  }
  if (m === 'POST' && p === '/login') {
    const key = str(body.name, 24).toLowerCase(), f = fails[key];
    if (f && f.until > now()) throw new HttpErr(429, 'Too many tries. Wait a minute.');
    x = db.users.find(y => y.name.toLowerCase() === key);
    if (!x || !checkPw(String(body.password || ''), x)) {
      const e = fails[key] = f || { n: 0 }; e.n++; if (e.n >= 5) { e.until = now() + 60000; e.n = 0; }
      throw new HttpErr(401, 'Wrong name or password');
    }
    delete fails[key];
    if (x.banned) throw deny('This account is suspended');
    return newSession(x);
  }
  if (m === 'POST' && p === '/logout') { const s = cookies(req).sid; if (s) { delete db.sessions[s]; save(); } return [200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + SECURE }]; }
  if (m === 'POST' && p === '/rider/apply') { me(); if (!u.rider) { u.rider = OPEN_RIDERS ? 'approved' : 'pending'; save(); } return [200, pubUser(u)]; }

  if (m === 'POST' && p === '/wallet') { rider(); u.wallet = str(body.wallet, 120); save(); return [200, pubUser(u)]; }
  if (m === 'GET' && p === '/invites') { me(); return [200, { invites: db.invites.filter(i => i.by === u.id).reverse().map(i => ({ code: i.code, used: !!i.usedBy, usedBy: i.usedBy ? uname(i.usedBy) : null })) }]; }
  if (m === 'POST' && p === '/invites') {
    me(); const open = db.invites.filter(i => i.by === u.id && !i.usedBy).length;
    if (!u.isAdmin && open >= 3) throw bad('You have 3 unused invites. Wait until a friend uses one.');
    const i = { code: crypto.randomBytes(5).toString('hex').toUpperCase(), by: u.id, usedBy: null, at: now() };
    db.invites.push(i); save(); return [201, { code: i.code }];
  }
  if (m === 'GET' && p === '/listings') { me(); return [200, { listings: db.listings.filter(l => !l.gone && !l.sold && !(db.users.find(y => y.id === l.sellerId) || {}).banned).reverse().map(listingPub) }]; }
  if (m === 'POST' && p === '/listings') {
    me();
    const title = str(body.title, 80), desc = str(body.desc, 1000), price = Math.round(+body.price);
    const pay = PAYS.slice(), coins = str(body.coins, 60);
    if (!title || !desc) throw bad('Title and description are required');
    if (!(price >= 0 && price <= 1e9)) throw bad('Enter a valid price');
    if (!CATS.includes(body.cat)) throw bad('Choose a category');
    let img = null;
    if (body.img) { if (typeof body.img !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(body.img) || body.img.length > 400000) throw bad('Photo is invalid or too large'); img = body.img; }
    const l = { id: nid(), title, desc, price, cat: body.cat, pay, coins, img, sellerId: u.id, at: now() };
    db.listings.push(l); save(); return [201, listingPub(l)];
  }
  if (m === 'DELETE' && (x = p.match(/^\/listings\/(\d+)$/))) {
    me(); const l = listing(+x[1]); if (!l) throw nf(); if (l.sellerId !== u.id) throw deny();
    if (db.orders.some(o => o.listingId === l.id && o.step < 4)) throw bad('This item has an order in progress');
    l.gone = true; save(); return [200, { ok: true }];
  }

  // chat: one thread per listing and buyer
  if (m === 'GET' && p === '/threads') {
    me(); const seen = {}, out = [];
    db.messages.slice().reverse().forEach(g => {
      const l = listing(g.listingId); if (!l) return;
      if (g.buyerId !== u.id && l.sellerId !== u.id) return;
      const k = g.listingId + ':' + g.buyerId; if (seen[k]) return; seen[k] = 1;
      out.push({ listingId: l.id, buyerId: g.buyerId, title: l.title, other: uname(g.buyerId === u.id ? l.sellerId : g.buyerId), last: g.text.slice(0, 60), at: g.at });
    });
    return [200, { threads: out }];
  }
  if (p === '/messages' && (m === 'GET' || m === 'POST')) {
    me();
    const src = m === 'GET' ? Object.fromEntries(url.searchParams) : body;
    const l = listing(+src.listing || +src.listingId); if (!l || l.gone) throw nf();
    const isSeller = l.sellerId === u.id, buyerId = isSeller ? +src.buyer || +src.buyerId : u.id;
    const thread = db.messages.filter(g => g.listingId === l.id && g.buyerId === buyerId);
    if (isSeller && !thread.length) throw deny('No conversation yet');
    if (!isSeller && !db.users.some(y => y.id === buyerId)) throw nf();
    if (m === 'POST') {
      const text = str(body.text, 500); if (!text) throw bad('Write a message first');
      const g = { id: nid(), listingId: l.id, buyerId, from: u.id, text, at: now() };
      db.messages.push(g); thread.push(g); save();
    }
    return [200, { title: l.title, other: uname(isSeller ? buyerId : l.sellerId), buyerId, messages: thread.map(g => ({ id: g.id, text: g.text, mine: g.from === u.id, at: g.at })) }];
  }

  // orders
  if (m === 'POST' && p === '/orders') {
    me(); const l = listing(+body.listingId);
    if (!l || l.gone || l.sold) throw nf();
    if (l.sellerId === u.id) throw bad('You cannot buy your own listing');
    if (db.orders.some(o => o.listingId === l.id && o.step < 4)) throw bad('Someone already has an order in progress for this item');
    const addr = str(body.addr, 200); if (!addr) throw bad('Enter a delivery address');
    if (!TIMES.includes(body.time)) throw bad('Choose a delivery time');
    const fee = Math.round(+body.fee || 0), recipient = str(body.recipient, 40), phone = str(body.phone, 20);
    if (!(fee >= 0 && fee <= 1e7)) throw bad('Enter a valid delivery fee');
    if (phone && !/^[+0-9 ()-]{6,20}$/.test(phone)) throw bad('That phone number looks wrong');
    const o = { id: nid(), listingId: l.id, buyerId: u.id, sellerId: l.sellerId, riderId: null, pay: 'Crypto', addr, time: body.time, fee, recipient, phone, counter: null, step: 0, code: String(crypto.randomInt(1000, 10000)), tries: 0, at: now() };
    db.orders.push(o); save(); return [201, orderView(o, u)];
  }
  if (m === 'GET' && p === '/orders') { me(); return [200, { orders: db.orders.filter(o => o.buyerId === u.id || o.sellerId === u.id).reverse().map(o => orderView(o, u)) }]; }
  if (m === 'GET' && p === '/jobs') {
    rider();
    return [200, { jobs: db.orders.filter(o => (o.step === 0 && o.buyerId !== u.id && o.sellerId !== u.id) || (o.riderId === u.id && o.step < 4)).reverse().map(o => jobView(o, u)) }];
  }
  if (m === 'POST' && (x = p.match(/^\/orders\/(\d+)\/(advance|counter|fee|answer|cancel|confirm|rate|report)$/))) {
    me(); const o = db.orders.find(y => y.id === +x[1]); if (!o) throw nf();
    if (x[2] === 'counter') {
      rider(); if (o.buyerId === u.id || o.sellerId === u.id) throw deny('You cannot deliver your own order');
      if (o.step !== 0 || o.counter) throw deny('This job cannot take an offer right now');
      const f = Math.round(+body.fee);
      if (!(f >= 0 && f <= 1e7) || f === o.fee) throw bad('Enter a valid fee that is different from the offer');
      o.counter = { riderId: u.id, fee: f }; save(); return [200, jobView(o, u)];
    }
    if (x[2] === 'fee' || x[2] === 'answer' || x[2] === 'cancel') {
      if (o.buyerId !== u.id || o.step !== 0) throw deny('Only the buyer can do this, and only before a rider is assigned');
      if (x[2] === 'cancel') { db.orders = db.orders.filter(y => y.id !== o.id); save(); return [200, { ok: true }]; }
      if (x[2] === 'fee') {
        if (o.counter) throw bad('Answer the rider offer first');
        const f = Math.round(+body.fee); if (!(f >= 0 && f <= 1e7)) throw bad('Enter a valid fee');
        o.fee = f; save(); return [200, orderView(o, u)];
      }
      if (!o.counter) throw bad('There is no rider offer to answer');
      if (body.accept) { o.fee = o.counter.fee; o.riderId = o.counter.riderId; o.step = 1; }
      o.counter = null; save(); return [200, orderView(o, u)];
    }
    if (x[2] === 'advance') {
      rider(); if (o.buyerId === u.id || o.sellerId === u.id) throw deny('You cannot deliver your own order');
      if (o.step === 0) {
        if (o.counter) throw deny(o.counter.riderId === u.id ? 'Wait for the buyer to answer your offer' : 'Another rider has made an offer on this job');
        o.riderId = u.id; o.step = 1;
      }
      else if ((o.step === 1 || o.step === 2) && o.riderId === u.id) o.step++;
      else throw deny('This job is not yours or cannot move forward');
      save(); return [200, jobView(o, u)];
    }
    if (x[2] === 'confirm') {
      rider(); if (o.riderId !== u.id || o.step !== 3) throw deny('Not ready for handoff');
      if (o.tries >= 5) throw new HttpErr(429, 'Too many wrong codes. Contact the admin.');
      if (String(body.code || '').trim() !== o.code) { o.tries++; save(); throw bad('That code does not match. Check it with the buyer.'); }
      o.step = 4; o.paidAt = now(); const l = listing(o.listingId); if (l) l.sold = true;
      save(); return [200, jobView(o, u)];
    }
    if (x[2] === 'rate') {
      if (o.buyerId !== u.id || o.step !== 4 || o.rating) throw deny();
      const n = +body.n; if (!Number.isInteger(n) || n < 1 || n > 5) throw bad('Rate from 1 to 5');
      o.rating = n; save(); return [200, orderView(o, u)];
    }
    if (o.buyerId !== u.id && o.sellerId !== u.id && o.riderId !== u.id) throw deny();
    db.reports.push({ id: nid(), orderId: o.id, by: u.id, text: str(body.text, 300) || 'No details', at: now() }); save(); return [200, { ok: true }];
  }

  // admin
  if (p.startsWith('/admin')) {
    me(); if (!u.isAdmin) throw deny();
    if (m === 'GET' && p === '/admin') return [200, {
      members: db.users.map(y => ({ id: y.id, name: y.name, invitedBy: y.invitedBy ? uname(y.invitedBy) : null, banned: !!y.banned, isAdmin: !!y.isAdmin })),
      riders: db.users.filter(y => y.rider).map(y => ({ id: y.id, name: y.name, status: y.rider })),
      reports: db.reports.slice().reverse().map(r => ({ id: r.id, orderId: r.orderId, by: uname(r.by), text: r.text, at: r.at }))
    }];
    if (m === 'POST' && (x = p.match(/^\/admin\/users\/(\d+)$/))) {
      const y = db.users.find(z => z.id === +x[1]); if (!y) throw nf();
      if (y.isAdmin) throw bad('Admins cannot be suspended');
      if (body.action === 'ban') { y.banned = true; Object.keys(db.sessions).forEach(t => { if (db.sessions[t].uid === y.id) delete db.sessions[t]; }); }
      else if (body.action === 'unban') y.banned = false; else throw bad('Unknown action');
      save(); return [200, { ok: true }];
    }
    if (m === 'POST' && (x = p.match(/^\/admin\/riders\/(\d+)$/))) {
      const y = db.users.find(z => z.id === +x[1]); if (!y || !y.rider) throw nf();
      if (body.action === 'approve') y.rider = 'approved'; else if (body.action === 'reject') y.rider = 'rejected'; else throw bad('Unknown action');
      save(); return [200, { ok: true }];
    }
  }
  throw nf();
}

// ---------- server ----------
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) { const [code, obj, h] = await api(req, url); return send(res, code, obj, h); }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const page = fs.readFileSync(path.join(PUB, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      return res.end(page);
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    const c = Number.isInteger(e.code) && e.code >= 400 && e.code < 600 ? e.code : 500;
    if (c === 500) console.error(e);
    send(res, c, { error: c === 500 ? 'Server error' : e.message });
  }
}).listen(PORT, HOST, () => console.log(`Night Market running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (riders: ${OPEN_RIDERS ? 'open signup' : 'admin approval'})`));
