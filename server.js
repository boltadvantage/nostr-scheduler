const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { finalizeEvent, getPublicKey, generateSecretKey } = require('nostr-tools/pure');
const { Relay } = require('nostr-tools/relay');
const { BunkerSigner, parseBunkerInput } = require('nostr-tools/nip46');

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3847;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// Multer config for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Database setup
const db = new Database(path.join(__dirname, 'nostr-scheduler.db'));
db.pragma('journal_mode = WAL');

// --- Database Migration ---
const tableInfo = db.pragma('table_info(accounts)');
const nsecCol = tableInfo.find(c => c.name === 'nsec_hex');
const hasBunkerCol = tableInfo.find(c => c.name === 'bunker_url');

if (nsecCol && nsecCol.notnull === 1) {
  console.log('Migrating accounts table...');
  db.exec(`
    CREATE TABLE accounts_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      nsec_hex TEXT,
      npub_hex TEXT NOT NULL,
      relays TEXT NOT NULL DEFAULT '["wss://relay.damus.io","wss://nos.lol","wss://relay.nostr.band"]',
      login_type TEXT NOT NULL DEFAULT 'key',
      bunker_url TEXT,
      bunker_client_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO accounts_new (id, name, nsec_hex, npub_hex, relays, login_type, created_at)
      SELECT id, name, nsec_hex, npub_hex, relays,
        COALESCE(login_type, 'key'),
        created_at
      FROM accounts;
    DROP TABLE accounts;
    ALTER TABLE accounts_new RENAME TO accounts;
  `);
  console.log('Migration complete.');
} else if (!hasBunkerCol && tableInfo.length > 0) {
  try { db.exec(`ALTER TABLE accounts ADD COLUMN bunker_url TEXT`); } catch (e) {}
  try { db.exec(`ALTER TABLE accounts ADD COLUMN bunker_client_key TEXT`); } catch (e) {}
}

// Migrate scheduled_posts: make scheduled_at nullable, add is_queued
const postInfo = db.pragma('table_info(scheduled_posts)');
const scheduledAtCol = postInfo.find(c => c.name === 'scheduled_at');
const hasIsQueued = postInfo.find(c => c.name === 'is_queued');

if (scheduledAtCol && scheduledAtCol.notnull === 1) {
  console.log('Migrating scheduled_posts table...');
  db.exec(`
    CREATE TABLE scheduled_posts_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      image_path TEXT,
      image_url TEXT,
      scheduled_at DATETIME,
      is_queued INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      event_id TEXT,
      signed_event TEXT,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
    INSERT INTO scheduled_posts_new (id, account_id, content, image_path, image_url, scheduled_at, status, event_id, signed_event, error, created_at)
      SELECT id, account_id, content, image_path, image_url, scheduled_at, status, event_id,
        CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('scheduled_posts') WHERE name='signed_event') THEN signed_event ELSE NULL END,
        error, created_at
      FROM scheduled_posts;
    DROP TABLE scheduled_posts;
    ALTER TABLE scheduled_posts_new RENAME TO scheduled_posts;
  `);
  console.log('Posts migration complete.');
} else if (!hasIsQueued && postInfo.length > 0) {
  try { db.exec(`ALTER TABLE scheduled_posts ADD COLUMN is_queued INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
}

// Create tables if they don't exist at all
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    nsec_hex TEXT,
    npub_hex TEXT NOT NULL,
    relays TEXT NOT NULL DEFAULT '["wss://relay.damus.io","wss://nos.lol","wss://relay.nostr.band"]',
    login_type TEXT NOT NULL DEFAULT 'key',
    bunker_url TEXT,
    bunker_client_key TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scheduled_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    image_path TEXT,
    image_url TEXT,
    scheduled_at DATETIME,
    is_queued INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    event_id TEXT,
    signed_event TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS queue_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    time_slot TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME
  );
`);

// Ensure columns exist (safety net)
try { db.exec(`ALTER TABLE scheduled_posts ADD COLUMN signed_event TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE scheduled_posts ADD COLUMN is_queued INTEGER NOT NULL DEFAULT 0`); } catch (e) {}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// --- Account Routes ---

app.get('/api/accounts', (req, res) => {
  const accounts = db.prepare(
    'SELECT id, name, npub_hex, relays, login_type, bunker_url, created_at FROM accounts'
  ).all();
  res.json(accounts);
});

app.post('/api/accounts', async (req, res) => {
  const { name, nsec_hex, npub_hex, relays, login_type, bunker_url } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  try {
    let pubkey;
    const type = login_type || 'key';
    let bunkerClientKeyHex = null;

    if (type === 'bunker') {
      if (!bunker_url) return res.status(400).json({ error: 'Bunker URL required' });

      const bp = await parseBunkerInput(bunker_url);
      if (!bp) return res.status(400).json({ error: 'Invalid bunker URL. Expected format: bunker://pubkey?relay=wss://...' });

      const clientSk = generateSecretKey();
      bunkerClientKeyHex = bytesToHex(clientSk);

      const signer = BunkerSigner.fromBunker(clientSk, bp);
      try {
        await signer.connect();
        pubkey = await signer.getPublicKey();
        await signer.close();
      } catch (connErr) {
        try { await signer.close(); } catch (e) {}
        return res.status(400).json({
          error: 'Could not connect to bunker. Make sure Amber is open and the bunker URL is correct. Details: ' + connErr.message
        });
      }

      const relayList = relays || JSON.stringify(bp.relays);

      const result = db.prepare(
        'INSERT INTO accounts (name, nsec_hex, npub_hex, relays, login_type, bunker_url, bunker_client_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(name, null, pubkey, relayList, type, bunker_url, bunkerClientKeyHex);

      return res.json({ id: result.lastInsertRowid, name, npub_hex: pubkey, relays: relayList, login_type: type });

    } else if (type === 'extension') {
      if (!npub_hex) return res.status(400).json({ error: 'Public key required for extension login' });
      pubkey = npub_hex;
    } else {
      if (!nsec_hex) return res.status(400).json({ error: 'Private key required' });
      const skBytes = hexToBytes(nsec_hex);
      pubkey = getPublicKey(skBytes);
    }

    const relayList = relays || '["wss://relay.damus.io","wss://nos.lol","wss://relay.nostr.band"]';

    const result = db.prepare(
      'INSERT INTO accounts (name, nsec_hex, npub_hex, relays, login_type) VALUES (?, ?, ?, ?, ?)'
    ).run(name, type === 'key' ? nsec_hex : null, pubkey, relayList, type);

    res.json({ id: result.lastInsertRowid, name, npub_hex: pubkey, relays: relayList, login_type: type });
  } catch (e) {
    res.status(400).json({ error: 'Error: ' + e.message });
  }
});

app.put('/api/accounts/:id/relays', (req, res) => {
  const { relays } = req.body;
  if (!relays) return res.status(400).json({ error: 'Relays required' });
  db.prepare('UPDATE accounts SET relays = ? WHERE id = ?').run(relays, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', (req, res) => {
  db.prepare(`DELETE FROM scheduled_posts WHERE account_id = ? AND status = 'pending'`).run(req.params.id);
  db.prepare('DELETE FROM queue_schedules WHERE account_id = ?').run(req.params.id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Queue Schedule Routes ---

app.get('/api/queues', (req, res) => {
  const queues = db.prepare(`
    SELECT q.*, a.name as account_name
    FROM queue_schedules q
    JOIN accounts a ON q.account_id = a.id
    ORDER BY q.account_id, q.time_slot
  `).all();
  res.json(queues);
});

app.post('/api/queues', (req, res) => {
  const { account_id, time_slot } = req.body;
  if (!account_id || !time_slot) return res.status(400).json({ error: 'account_id and time_slot required' });

  // Validate time format HH:MM
  if (!/^\d{2}:\d{2}$/.test(time_slot)) return res.status(400).json({ error: 'time_slot must be HH:MM format' });

  // Check for duplicate
  const existing = db.prepare('SELECT id FROM queue_schedules WHERE account_id = ? AND time_slot = ?').get(account_id, time_slot);
  if (existing) return res.status(400).json({ error: 'This time slot already exists for this account' });

  const result = db.prepare('INSERT INTO queue_schedules (account_id, time_slot) VALUES (?, ?)').run(account_id, time_slot);
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/queues/:id', (req, res) => {
  const { enabled } = req.body;
  if (enabled !== undefined) {
    db.prepare('UPDATE queue_schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
  }
  res.json({ ok: true });
});

app.delete('/api/queues/:id', (req, res) => {
  db.prepare('DELETE FROM queue_schedules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Image Upload to nostr.build (NIP-98 authenticated) ---

// Build a NIP-98 auth token for nostr.build using a private key
function buildNip98Token(sk, url, method) {
  const eventTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', url],
      ['method', method],
    ],
    content: '',
  };
  const signed = finalizeEvent(eventTemplate, sk);
  return Buffer.from(JSON.stringify(signed)).toString('base64');
}

app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  const accountId = req.body.account_id;
  // If a pre-signed NIP-98 token was provided (from extension signing), use it
  const clientNip98Token = req.body.nip98_token;

  try {
    let nip98Token = clientNip98Token;

    // If no client-provided token, sign server-side using the account's key
    if (!nip98Token && accountId) {
      const account = db.prepare('SELECT nsec_hex, login_type, bunker_url, bunker_client_key FROM accounts WHERE id = ?').get(accountId);

      if (account && account.nsec_hex) {
        const sk = hexToBytes(account.nsec_hex);
        nip98Token = buildNip98Token(sk, 'https://nostr.build/api/v2/upload/files', 'POST');
      } else if (account && account.login_type === 'bunker' && account.bunker_url && account.bunker_client_key) {
        // Sign via bunker
        const bp = await parseBunkerInput(account.bunker_url);
        if (bp) {
          const clientSk = hexToBytes(account.bunker_client_key);
          const signer = BunkerSigner.fromBunker(clientSk, bp);
          try {
            await signer.connect();
            const eventTemplate = {
              kind: 27235,
              created_at: Math.floor(Date.now() / 1000),
              tags: [
                ['u', 'https://nostr.build/api/v2/upload/files'],
                ['method', 'POST'],
              ],
              content: '',
            };
            const signed = await signer.signEvent(eventTemplate);
            await signer.close();
            nip98Token = Buffer.from(JSON.stringify(signed)).toString('base64');
          } catch (e) {
            try { await signer.close(); } catch (x) {}
            return res.status(400).json({ error: 'Bunker signing failed for upload auth: ' + e.message });
          }
        }
      }
    }

    if (!nip98Token) {
      return res.status(400).json({ error: 'No account selected or account cannot sign NIP-98 auth. Select an account with a key or bunker.' });
    }

    const filePath = path.join(uploadsDir, req.file.filename);
    const fileBuffer = fs.readFileSync(filePath);

    const boundary = '----NostrScheduler' + Date.now();
    const crlf = '\r\n';

    const header = `--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="${req.file.originalname}"${crlf}Content-Type: ${req.file.mimetype}${crlf}${crlf}`;
    const footer = `${crlf}--${boundary}--${crlf}`;

    const headerBuf = Buffer.from(header, 'utf-8');
    const footerBuf = Buffer.from(footer, 'utf-8');
    const body = Buffer.concat([headerBuf, fileBuffer, footerBuf]);

    const response = await fetch('https://nostr.build/api/v2/upload/files', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Nostr ${nip98Token}`,
      },
      body: body,
    });

    const result = await response.json();
    fs.unlinkSync(filePath);

    if (result.status === 'success' && result.data && result.data.length > 0) {
      res.json({ url: result.data[0].url });
    } else {
      res.status(500).json({ error: 'Upload failed: ' + JSON.stringify(result) });
    }
  } catch (e) {
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// --- Post Routes ---

app.get('/api/posts', (req, res) => {
  const status = req.query.status; // 'pending', 'sent', 'failed', 'draft', or undefined for all (excl. drafts/deleted)
  let query = `
    SELECT p.*, a.name as account_name, a.login_type
    FROM scheduled_posts p
    JOIN accounts a ON p.account_id = a.id
  `;
  const params = [];

  if (status) {
    query += ` WHERE p.status = ?`;
    params.push(status);
  } else {
    query += ` WHERE p.status NOT IN ('draft', 'deleted')`;
  }

  query += ` ORDER BY CASE WHEN p.is_queued = 1 THEN 1 ELSE 0 END, p.scheduled_at ASC, p.created_at ASC`;

  const posts = db.prepare(query).all(...params);
  res.json(posts);
});

app.post('/api/posts', (req, res) => {
  const { account_id, content, scheduled_at, image_url, signed_event, is_queued, status } = req.body;
  if (!account_id || !content) {
    return res.status(400).json({ error: 'account_id and content required' });
  }
  const postStatus = status === 'draft' ? 'draft' : 'pending';
  if (postStatus !== 'draft' && !is_queued && !scheduled_at) {
    return res.status(400).json({ error: 'scheduled_at required for non-queued posts' });
  }

  const result = db.prepare(
    'INSERT INTO scheduled_posts (account_id, content, image_url, scheduled_at, is_queued, signed_event, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(account_id, content, image_url || null, scheduled_at || null, is_queued ? 1 : 0, signed_event || null, postStatus);

  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/posts/:id', (req, res) => {
  const post = db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(req.params.id);
  if (post && post.image_path) {
    const imgFile = path.join(uploadsDir, post.image_path);
    if (fs.existsSync(imgFile)) fs.unlinkSync(imgFile);
  }
  db.prepare(`DELETE FROM scheduled_posts WHERE id = ? AND status IN ('pending', 'draft')`).run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/posts/:id/send-now', async (req, res) => {
  try {
    await publishPost(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clear sent/failed posts
app.delete('/api/posts/history/clear', (req, res) => {
  db.prepare(`DELETE FROM scheduled_posts WHERE status IN ('sent', 'failed')`).run();
  res.json({ ok: true });
});

// --- Draft Routes ---

// Promote a draft to queued or scheduled
app.put('/api/posts/:id', (req, res) => {
  const post = db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const { content, image_url, account_id, status, scheduled_at, is_queued, signed_event } = req.body;

  const updates = [];
  const params = [];

  if (content !== undefined) { updates.push('content = ?'); params.push(content); }
  if (image_url !== undefined) { updates.push('image_url = ?'); params.push(image_url || null); }
  if (account_id !== undefined) { updates.push('account_id = ?'); params.push(account_id); }
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (scheduled_at !== undefined) { updates.push('scheduled_at = ?'); params.push(scheduled_at || null); }
  if (is_queued !== undefined) { updates.push('is_queued = ?'); params.push(is_queued ? 1 : 0); }
  if (signed_event !== undefined) { updates.push('signed_event = ?'); params.push(signed_event || null); }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  params.push(req.params.id);
  db.prepare(`UPDATE scheduled_posts SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// --- API Key Routes ---

app.get('/api/api-keys', (req, res) => {
  const keys = db.prepare('SELECT id, key_prefix, label, created_at, last_used_at FROM api_keys ORDER BY created_at DESC').all();
  res.json(keys);
});

app.post('/api/api-keys', (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ error: 'Label required' });

  const rawKey = 'nsk_' + crypto.randomBytes(32).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 12) + '...';

  db.prepare('INSERT INTO api_keys (key_hash, key_prefix, label) VALUES (?, ?, ?)').run(keyHash, keyPrefix, label);
  // Return the full key only once
  res.json({ key: rawKey, prefix: keyPrefix, label });
});

app.delete('/api/api-keys/:id', (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- External API (API key authenticated) ---

function authenticateApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer <api_key>' });
  }

  const rawKey = authHeader.slice(7);
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const apiKey = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash);

  if (!apiKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(apiKey.id);
  next();
}

app.post('/api/v1/drafts', authenticateApiKey, (req, res) => {
  const { account_id, content, image_url } = req.body;

  if (!content) return res.status(400).json({ error: 'content is required' });

  // If account_id provided, verify it exists
  if (account_id) {
    const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(account_id);
    if (!account) return res.status(400).json({ error: 'Account not found' });
  }

  // Use first account as default if none specified
  let targetAccountId = account_id;
  if (!targetAccountId) {
    const first = db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get();
    if (!first) return res.status(400).json({ error: 'No accounts configured. Add an account first.' });
    targetAccountId = first.id;
  }

  const result = db.prepare(
    'INSERT INTO scheduled_posts (account_id, content, image_url, status, is_queued) VALUES (?, ?, ?, ?, ?)'
  ).run(targetAccountId, content, image_url || null, 'draft', 0);

  res.json({ id: result.lastInsertRowid, status: 'draft', account_id: targetAccountId });
});

app.get('/api/v1/drafts', authenticateApiKey, (req, res) => {
  const drafts = db.prepare(`
    SELECT p.id, p.account_id, p.content, p.image_url, p.created_at, a.name as account_name
    FROM scheduled_posts p
    JOIN accounts a ON p.account_id = a.id
    WHERE p.status = 'draft'
    ORDER BY p.created_at DESC
  `).all();
  res.json(drafts);
});

app.get('/api/v1/accounts', authenticateApiKey, (req, res) => {
  const accounts = db.prepare('SELECT id, name, npub_hex FROM accounts').all();
  res.json(accounts);
});

// --- Publishing Logic ---

async function publishPost(postId) {
  const post = db.prepare(`
    SELECT p.*, a.nsec_hex, a.relays, a.login_type, a.bunker_url, a.bunker_client_key
    FROM scheduled_posts p
    JOIN accounts a ON p.account_id = a.id
    WHERE p.id = ?
  `).get(postId);

  if (!post || post.status !== 'pending') return;

  let signedEvent;

  // Build content with image
  let content = post.content;
  if (post.image_url) content += '\n' + post.image_url;
  const tags = [];
  if (post.image_url) tags.push(['r', post.image_url]);

  if (post.signed_event) {
    signedEvent = JSON.parse(post.signed_event);

  } else if (post.login_type === 'bunker' && post.bunker_url && post.bunker_client_key) {
    console.log(`Signing post ${postId} via bunker...`);
    const bp = await parseBunkerInput(post.bunker_url);
    if (!bp) {
      db.prepare(`UPDATE scheduled_posts SET status = 'failed', error = ? WHERE id = ?`)
        .run('Invalid bunker URL stored', postId);
      return;
    }

    const clientSk = hexToBytes(post.bunker_client_key);
    const signer = BunkerSigner.fromBunker(clientSk, bp);

    try {
      await signer.connect();
      const eventTemplate = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content,
      };
      signedEvent = await signer.signEvent(eventTemplate);
      await signer.close();
    } catch (e) {
      try { await signer.close(); } catch (x) {}
      db.prepare(`UPDATE scheduled_posts SET status = 'failed', error = ? WHERE id = ?`)
        .run('Bunker signing failed (is Amber open?): ' + e.message, postId);
      return;
    }

  } else if (post.nsec_hex) {
    const sk = hexToBytes(post.nsec_hex);
    const eventTemplate = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    };
    signedEvent = finalizeEvent(eventTemplate, sk);

  } else {
    db.prepare(`UPDATE scheduled_posts SET status = 'failed', error = ? WHERE id = ?`)
      .run('No signing method available', postId);
    return;
  }

  // Publish to relays
  const relays = JSON.parse(post.relays);
  const errors = [];
  let published = false;

  for (const relayUrl of relays) {
    try {
      const relay = await Relay.connect(relayUrl);
      await relay.publish(signedEvent);
      relay.close();
      published = true;
    } catch (e) {
      errors.push(`${relayUrl}: ${e.message}`);
    }
  }

  if (published) {
    db.prepare(`UPDATE scheduled_posts SET status = 'sent', event_id = ? WHERE id = ?`)
      .run(signedEvent.id, postId);
    console.log(`Published post ${postId} (event: ${signedEvent.id})`);
  } else {
    const errMsg = errors.join('; ');
    db.prepare(`UPDATE scheduled_posts SET status = 'failed', error = ? WHERE id = ?`)
      .run(errMsg, postId);
    console.error(`Failed to publish post ${postId}: ${errMsg}`);
    throw new Error(errMsg);
  }
}

// --- Scheduler: check every 30 seconds ---
cron.schedule('*/30 * * * * *', () => {
  const now = new Date();

  // 1. Check time-specific scheduled posts
  const duePosts = db.prepare(
    `SELECT id FROM scheduled_posts WHERE status = 'pending' AND is_queued = 0 AND scheduled_at IS NOT NULL AND scheduled_at <= ?`
  ).all(now.toISOString());

  for (const post of duePosts) {
    publishPost(post.id).catch(e => console.error(`Scheduler error for post ${post.id}:`, e.message));
  }

  // 2. Check queue schedules
  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const currentHH = String(now.getHours()).padStart(2, '0');
  const currentMM = String(now.getMinutes()).padStart(2, '0');
  const currentTime = `${currentHH}:${currentMM}`;

  const activeSlots = db.prepare(
    `SELECT * FROM queue_schedules WHERE enabled = 1 AND (last_fired_date IS NULL OR last_fired_date < ?)`
  ).all(todayStr);

  for (const slot of activeSlots) {
    // Fire if current time >= slot time (slot fires once per day, at or after the slot time)
    if (currentTime >= slot.time_slot) {
      // Find the oldest queued pending post for this account
      const nextPost = db.prepare(
        `SELECT id FROM scheduled_posts WHERE account_id = ? AND is_queued = 1 AND status = 'pending' ORDER BY created_at ASC LIMIT 1`
      ).get(slot.account_id);

      if (nextPost) {
        console.log(`Queue firing: slot ${slot.time_slot} for account ${slot.account_id}, post ${nextPost.id}`);
        publishPost(nextPost.id).catch(e => console.error(`Queue error for post ${nextPost.id}:`, e.message));
      }

      // Mark slot as fired today regardless of whether there was a post
      db.prepare('UPDATE queue_schedules SET last_fired_date = ? WHERE id = ?').run(todayStr, slot.id);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Nostr Scheduler running at http://localhost:${PORT}`);
});
