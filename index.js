require('dotenv').config();
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, MessageFlags,
} = require('discord.js');

/* ───────────────────────── CONFIG ───────────────────────── */
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
const OWNER_IDS = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const VOUCH_ID = process.env.VOUCH_ID || OWNER_IDS[0] || '1250242285656997965';
const TOLERANCE = Number(process.env.PAY_TOLERANCE || 0.02); // 2% underpay allowed (rate drift/rounding)
const EPH = MessageFlags.Ephemeral;

const USDT_ERC20 = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const BS = 'https://eth.blockscout.com/api/v2';

const COINS = {
  btc:          { name: 'Bitcoin',        sym: 'BTC',  cg: 'bitcoin',  dec: 8, type: 'utxo',  chain: 'btc',  detect: 'btc',  minConf: 1, color: 0xf7931a },
  ltc:          { name: 'Litecoin',       sym: 'LTC',  cg: 'litecoin', dec: 8, type: 'utxo',  chain: 'ltc',  detect: 'ltc',  minConf: 1, color: 0x345d9d },
  doge:         { name: 'Dogecoin',       sym: 'DOGE', cg: 'dogecoin', dec: 2, type: 'utxo',  chain: 'doge', detect: 'doge', minConf: 1, color: 0xc2a633 },
  eth:          { name: 'Ethereum',       sym: 'ETH',  cg: 'ethereum', dec: 6, type: 'eth',   detect: 'evm',  minConf: 3, color: 0x627eea },
  'usdt-trc20': { name: 'USDT (TRC20)',   sym: 'USDT', cg: 'tether',   dec: 2, type: 'trc20', detect: 'tron', minConf: 1, color: 0x26a17b },
  'usdt-erc20': { name: 'USDT (ERC20)',   sym: 'USDT', cg: 'tether',   dec: 2, type: 'erc20', detect: 'evm',  minConf: 3, color: 0x26a17b },
};

const CATALOG = {
  mcfa:  { label: 'Minecraft Premium Account', items: ['capes', 'tiers', 'playtime'] },
  nitro: { label: 'Nitro',                     items: ['promo', 'gl', 'account'] },
  dsmp:  { label: 'Minecraft DonutSMP Money',  items: ['buy', 'sell'] },
};
const METHODS = ['LTC', 'BTC', 'ETH', 'USDT', 'DOGE', 'UPI', 'PayPal', 'CashApp', 'Card'];

/* ───────────────────────── STORAGE ───────────────────────── */
const DATA_DIR = process.env.DATA_DIR || __dirname; // point at a persistent volume when hosting
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'data.json');
let db = { addresses: {}, panels: {}, stock: {}, vouches: null, invoices: {}, usedTx: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { /* first run */ }
const save = () => {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
};
for (const [id, inv] of Object.entries(db.invoices)) {            // prune invoices older than 30 days
  if (Date.now() - inv.createdAt > 30 * 864e5) delete db.invoices[id];
}

/* ───────────────────────── HELPERS ───────────────────────── */
const reply = (i, o) => i.reply({ flags: EPH, ...o });
const fmt = (n, d = 8) => Number(n).toFixed(d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const usd = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = h => `${h.slice(0, 8)}…${h.slice(-6)}`;
const isOwner = id => OWNER_IDS.includes(id);

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000), ...opts });
  if (!r.ok) {
    const e = new Error(r.status === 429 ? 'API rate limit hit, try again in a minute' : `API error ${r.status} (${new URL(url).host})`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

let priceCache = { t: 0, d: {} };
async function prices() {
  if (Date.now() - priceCache.t < 60000 && priceCache.d.bitcoin) return priceCache.d;
  const d = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,litecoin,ethereum,dogecoin,tether,tron&vs_currencies=usd');
  const out = {};
  for (const k in d) out[k] = d[k].usd;
  priceCache = { t: Date.now(), d: out };
  return out;
}

/* ───────────────────────── ADDRESS DETECTION ───────────────────────── */
function detect(raw) {
  let a = raw.trim();
  if (/^(bc1|ltc1)/i.test(a)) a = a.toLowerCase();
  let kind = null;
  if (/^0x[a-fA-F0-9]{40}$/.test(a)) kind = 'evm';
  else if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) kind = 'tron';
  else if (/^bc1[a-z0-9]{25,87}$/.test(a) || /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a)) kind = 'btc';
  else if (/^ltc1[a-z0-9]{25,87}$/.test(a) || /^[LM][a-km-zA-HJ-NP-Z1-9]{26,33}$/.test(a)) kind = 'ltc';
  else if (/^[D9A][a-km-zA-HJ-NP-Z1-9]{33}$/.test(a)) kind = 'doge';
  return kind ? { kind, address: a } : null;
}

const EXPLORER = {
  btc:  { tx: 'https://mempool.space/tx/',          addr: 'https://mempool.space/address/' },
  ltc:  { tx: 'https://litecoinspace.org/tx/',      addr: 'https://litecoinspace.org/address/' },
  doge: { tx: 'https://dogechain.info/tx/',         addr: 'https://dogechain.info/address/' },
  evm:  { tx: 'https://etherscan.io/tx/',           addr: 'https://etherscan.io/address/' },
  tron: { tx: 'https://tronscan.org/#/transaction/', addr: 'https://tronscan.org/#/address/' },
};

/* ───────────────────────── WALLET LOOKUPS ───────────────────────── */
async function utxoInfo(chain, addr) {
  const d = await getJSON(`https://api.blockcypher.com/v1/${chain}/main/addrs/${addr}/full?limit=5`);
  const mine = io => (io.addresses || []).includes(addr);
  const txs = (d.txs || []).map(tx => {
    const inn = (tx.outputs || []).filter(mine).reduce((s, o) => s + o.value, 0);
    const out = (tx.inputs || []).filter(mine).reduce((s, x) => s + (x.output_value || 0), 0);
    return { hash: tx.hash, net: (inn - out) / 1e8, conf: tx.confirmations, ts: Date.parse(tx.received) };
  });
  const sym = COINS[chain].sym;
  return {
    name: COINS[chain].name, sym, color: COINS[chain].color,
    balances: [{ sym, cg: COINS[chain].cg, amount: d.balance / 1e8 }],
    pending: (d.unconfirmed_balance || 0) / 1e8,
    received: d.total_received / 1e8, sent: d.total_sent / 1e8,
    txCount: d.final_n_tx ?? d.n_tx, txs,
  };
}

async function evmInfo(addr) {
  const notFound = e => (e.status === 404 ? null : Promise.reject(e));
  const [a, tb, tx] = await Promise.all([
    getJSON(`${BS}/addresses/${addr}`).catch(notFound),
    getJSON(`${BS}/addresses/${addr}/token-balances`).catch(() => []),
    getJSON(`${BS}/addresses/${addr}/transactions`).catch(() => ({ items: [] })),
  ]);
  const me = addr.toLowerCase();
  let received = 0, sent = 0;
  const txs = (tx.items || []).map(t => {
    const v = Number(t.value) / 1e18;
    const out = t.from?.hash?.toLowerCase() === me;
    const failed = t.status === 'error';
    if (!failed) { if (out) sent += v; else received += v; }
    return { hash: t.hash, net: out ? -v : v, conf: t.confirmations, ts: Date.parse(t.timestamp), failed };
  });
  const usdtRow = (Array.isArray(tb) ? tb : []).find(x => (x.token?.address_hash || x.token?.address || '').toLowerCase() === USDT_ERC20.toLowerCase());
  const balances = [{ sym: 'ETH', cg: 'ethereum', amount: Number(a?.coin_balance || 0) / 1e18 }];
  if (usdtRow) balances.push({ sym: 'USDT', cg: 'tether', amount: Number(usdtRow.value) / 10 ** Number(usdtRow.token.decimals || 6) });
  return {
    name: 'Ethereum (EVM)', sym: 'ETH', color: COINS.eth.color, balances, received, sent,
    txCount: null, txs, note: 'ETH totals are based on the last ~50 transactions only. Ethereum mainnet only.',
  };
}

async function tronInfo(addr) {
  const acc = await getJSON(`https://api.trongrid.io/v1/accounts/${addr}`);
  const d = acc.data?.[0];
  const usdtRaw = (d?.trc20 || []).find(o => o[USDT_TRC20] !== undefined)?.[USDT_TRC20] || 0;
  const tr = await getJSON(`https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?limit=50&contract_address=${USDT_TRC20}`);
  let received = 0, sent = 0;
  const txs = (tr.data || []).map(t => {
    const v = Number(t.value) / 10 ** Number(t.token_info?.decimals || 6);
    const out = t.from === addr;
    if (out) sent += v; else received += v;
    return { hash: t.transaction_id, net: out ? -v : v, conf: null, ts: t.block_timestamp };
  });
  return {
    name: 'TRON (USDT TRC20)', sym: 'USDT', color: COINS['usdt-trc20'].color,
    balances: [
      { sym: 'USDT', cg: 'tether', amount: Number(usdtRaw) / 1e6 },
      { sym: 'TRX', cg: 'tron', amount: (d?.balance || 0) / 1e6 },
    ],
    received, sent, txCount: null, txs,
    note: 'Totals/transactions cover USDT-TRC20 transfers (last ~50) only.',
  };
}

/* ───────────────────────── PAYMENT VERIFICATION ───────────────────────── */
async function lookupTx(key, hash, addr) {
  const c = COINS[key];
  const me = addr.toLowerCase();
  const ms = v => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null; };
  try {
    if (c.type === 'utxo') {
      const tx = await getJSON(`https://api.blockcypher.com/v1/${c.chain}/main/txs/${hash}`);
      const got = (tx.outputs || []).filter(o => (o.addresses || []).includes(addr)).reduce((s, o) => s + o.value, 0) / 1e8;
      return { exists: true, got, conf: tx.confirmations || 0, time: ms(tx.received), failed: !!tx.double_spend };
    }
    if (c.type === 'eth' || c.type === 'erc20') {
      const tx = await getJSON(`${BS}/transactions/${hash}`);
      let got = 0;
      if (c.type === 'eth') {
        if (tx.to?.hash?.toLowerCase() === me) got = Number(tx.value) / 1e18;
      } else {
        const tt = await getJSON(`${BS}/transactions/${hash}/token-transfers`).catch(() => ({ items: [] }));
        for (const t of tt.items || []) {
          const tok = (t.token?.address_hash || t.token?.address || '').toLowerCase();
          if (tok === USDT_ERC20.toLowerCase() && t.to?.hash?.toLowerCase() === me) {
            got += Number(t.total?.value || 0) / 10 ** Number(t.total?.decimals || 6);
          }
        }
      }
      return { exists: true, got, conf: tx.confirmations || 0, time: ms(tx.timestamp), failed: tx.status === 'error' };
    }
    if (c.type === 'trc20') {
      const tx = await getJSON(`https://apilist.tronscanapi.com/api/transaction-info?hash=${hash}`);
      if (!tx?.hash) return { exists: false };
      const list = tx.trc20TransferInfo || (tx.tokenTransferInfo ? [tx.tokenTransferInfo] : []);
      const got = list
        .filter(t => t.to_address === addr && (t.contract_address || t.address) === USDT_TRC20)
        .reduce((s, t) => s + Number(t.amount_str ?? t.amount ?? 0) / 10 ** Number(t.decimals || 6), 0);
      return {
        exists: true, got, conf: tx.confirmed ? 1 : 0, time: ms(tx.timestamp),
        failed: !!tx.contractRet && tx.contractRet !== 'SUCCESS',
      };
    }
  } catch (e) {
    if (e.status === 404) return { exists: false };
    throw e;
  }
}

/* ───────────────────────── CALCULATOR (no eval) ───────────────────────── */
const CONST = { pi: Math.PI, e: Math.E };
const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, min: Math.min, max: Math.max, pow: Math.pow,
};
function calc(src) {
  const re = /\s*(?:(\d*\.?\d+)|([a-z]+)|(\*\*|[-+*/%^(),×÷]))/iy;
  const toks = [];
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) { if (/^\s*$/.test(src.slice(pos))) break; throw new Error(`Unexpected character near position ${pos + 1}`); }
    pos = re.lastIndex;
    if (m[1] !== undefined) toks.push({ t: 'n', v: parseFloat(m[1]) });
    else if (m[2]) toks.push({ t: 'id', v: m[2].toLowerCase() });
    else toks.push({ t: 'op', v: { '×': '*', '÷': '/', '^': '**' }[m[3]] || m[3] });
  }
  let p = 0;
  const peek = () => toks[p];
  const isOp = v => peek() && peek().t === 'op' && peek().v === v;
  const expr = () => { let v = term(); while (isOp('+') || isOp('-')) { const o = toks[p++].v; const r = term(); v = o === '+' ? v + r : v - r; } return v; };
  const term = () => { let v = unary(); while (isOp('*') || isOp('/') || isOp('%')) { const o = toks[p++].v; const r = unary(); v = o === '*' ? v * r : o === '/' ? v / r : v % r; } return v; };
  const unary = () => { if (isOp('-')) { p++; return -unary(); } if (isOp('+')) { p++; return unary(); } return power(); };
  const power = () => { const b = atom(); if (isOp('**')) { p++; return b ** unary(); } return b; };
  const atom = () => {
    const t = toks[p++];
    if (!t) throw new Error('Expression ended unexpectedly');
    if (t.t === 'n') return t.v;
    if (t.t === 'op' && t.v === '(') { const v = expr(); if (!isOp(')')) throw new Error('Missing )'); p++; return v; }
    if (t.t === 'id') {
      if (t.v in CONST) return CONST[t.v];
      const f = FUNCS[t.v];
      if (!f) throw new Error(`Unknown name "${t.v}"`);
      if (!isOp('(')) throw new Error(`${t.v} needs ( )`);
      p++;
      const args = [];
      if (!isOp(')')) { do { args.push(expr()); } while (isOp(',') && ++p); }
      if (!isOp(')')) throw new Error('Missing )');
      p++;
      return f(...args);
    }
    throw new Error('Unexpected symbol');
  };
  const v = expr();
  if (p < toks.length) throw new Error('Unexpected symbol');
  if (!Number.isFinite(v)) throw new Error('Result is not a finite number');
  return v;
}

/* ───────────────────────── EMBED / MODAL BUILDERS ───────────────────────── */
function buildEmbed(cfg) {
  const e = new EmbedBuilder().setDescription(cfg.description).setColor(cfg.color ? parseInt(cfg.color.replace('#', ''), 16) : 0x5865f2);
  if (cfg.title) e.setTitle(cfg.title);
  if (cfg.image) e.setImage(cfg.image);
  return e;
}

function embedModal(customId, modalTitle, cur = {}) {
  const row = (id, label, style, required, max, value, placeholder) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
    if (value) t.setValue(value);
    if (placeholder) t.setPlaceholder(placeholder);
    return new ActionRowBuilder().addComponents(t);
  };
  return new ModalBuilder().setCustomId(customId).setTitle(modalTitle).addComponents(
    row('title', 'Title', TextInputStyle.Short, false, 256, cur.title),
    row('description', 'Message (supports markdown)', TextInputStyle.Paragraph, true, 4000, cur.description),
    row('color', 'Color hex (e.g. #5865F2)', TextInputStyle.Short, false, 7, cur.color, '#5865F2'),
    row('image', 'Image URL (optional)', TextInputStyle.Short, false, 500, cur.image, 'https://...'),
  );
}

function readEmbedModal(i) {
  const g = k => i.fields.getTextInputValue(k).trim();
  const color = g('color'), image = g('image');
  if (color && !/^#?[0-9a-f]{6}$/i.test(color)) throw new Error('Color must be a 6-digit hex like #5865F2');
  if (image && !/^https?:\/\//i.test(image)) throw new Error('Image must be a http(s) URL');
  return { title: g('title') || null, description: g('description'), color: color || null, image: image || null };
}

/* ───────────────────────── COMMAND DEFINITIONS ───────────────────────── */
const coinChoices = Object.entries(COINS).map(([value, c]) => ({ name: c.name, value }));
const catChoices = Object.entries(CATALOG).map(([value, c]) => ({ name: value, value }));
const networkOpt = o => o.setName('network').setDescription('USDT network (default TRC20)').addChoices({ name: 'TRC20 (Tron)', value: 'trc20' }, { name: 'ERC20 (Ethereum)', value: 'erc20' });
const amountOpt = o => o.setName('amount').setDescription('Amount in USD').setRequired(true).setMinValue(0.01);

const commands = [
  new SlashCommandBuilder().setName('setaddr').setDescription('Set or edit one of your payment addresses')
    .addStringOption(o => o.setName('coin').setDescription('Coin').setRequired(true).addChoices(...coinChoices))
    .addStringOption(o => o.setName('address').setDescription('Your wallet address').setRequired(true)),
  new SlashCommandBuilder().setName('addresses').setDescription('Show all saved payment addresses'),
  ...['btc', 'ltc', 'eth', 'doge'].map(k => new SlashCommandBuilder().setName(k).setDescription(`Show my ${COINS[k].name} address`)),
  new SlashCommandBuilder().setName('usdt').setDescription('Show my USDT address').addStringOption(networkOpt),
  new SlashCommandBuilder().setName('bal').setDescription('Wallet info for any address (auto-detects the chain)')
    .addStringOption(o => o.setName('address').setDescription('Wallet address').setRequired(true)),
  ...['btc', 'ltc', 'eth', 'doge'].map(k => new SlashCommandBuilder().setName('pay' + k).setDescription(`Request a ${COINS[k].sym} payment`).addNumberOption(amountOpt)),
  new SlashCommandBuilder().setName('payusdt').setDescription('Request a USDT payment').addNumberOption(amountOpt).addStringOption(networkOpt),
  ...Object.entries(CATALOG).map(([k, c]) => new SlashCommandBuilder().setName(k).setDescription(`${c.label} panels`)
    .addStringOption(o => o.setName('option').setDescription('What to show').setRequired(true)
      .addChoices(...[...c.items, 'stock'].map(v => ({ name: v, value: v }))))),
  new SlashCommandBuilder().setName('setpanel').setDescription('Set the embed message for a panel')
    .addStringOption(o => o.setName('category').setDescription('Category').setRequired(true).addChoices(...catChoices))
    .addStringOption(o => o.setName('item').setDescription('Panel').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('change').setDescription('Change stock')
    .addStringOption(o => o.setName('stock').setDescription('New stock (e.g. 25 or "Out of stock")').setRequired(true).setMaxLength(100))
    .addStringOption(o => o.setName('category').setDescription('Category').setRequired(true).addChoices(...catChoices))
    .addStringOption(o => o.setName('item').setDescription('Item (or all)').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('cal').setDescription('Calculator')
    .addStringOption(o => o.setName('expression').setDescription('e.g. (12.5*3)+4^2').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder().setName('vouch').setDescription('Generate a +vouch line')
    .addStringOption(o => o.setName('product').setDescription('Product').setRequired(true).addChoices(...catChoices))
    .addNumberOption(o => o.setName('amount').setDescription('Amount in USD').setRequired(true).setMinValue(0))
    .addStringOption(o => o.setName('method').setDescription('Payment method').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('vouches').setDescription('Legitimacy / vouches embed')
    .addSubcommand(s => s.setName('view').setDescription('Show vouches'))
    .addSubcommand(s => s.setName('edit').setDescription('Edit the vouches embed')),
];

/* ───────────────────────── HANDLERS ───────────────────────── */
const H = {};

// --- addresses
H.setaddr = async i => {
  const key = i.options.getString('coin', true);
  const d = detect(i.options.getString('address', true));
  const c = COINS[key];
  if (!d || d.kind !== c.detect) return reply(i, { content: `❌ That doesn't look like a valid ${c.name} address.` });
  db.addresses[key] = d.address;
  save();
  return reply(i, { content: `✅ ${c.name} address saved:\n\`${d.address}\`` });
};

async function showAddr(i, key) {
  const c = COINS[key], a = db.addresses[key];
  if (!a) return reply(i, { content: `No ${c.name} address set yet. Use \`/setaddr\`.` });
  return i.reply({ embeds: [new EmbedBuilder().setColor(c.color).setTitle(`${c.name} address`).setDescription(`\`\`\`${a}\`\`\``)] });
}
for (const k of ['btc', 'ltc', 'eth', 'doge']) H[k] = i => showAddr(i, k);
H.usdt = i => showAddr(i, 'usdt-' + (i.options.getString('network') || 'trc20'));
H.addresses = async i => {
  const lines = Object.entries(COINS).map(([k, c]) => `**${c.name}**\n${db.addresses[k] ? `\`${db.addresses
