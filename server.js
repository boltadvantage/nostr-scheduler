const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
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
const PORT = 3847;

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
// Check if we need to migrate (old schema has nsec_hex NOT NULL)
const tableInfo = db.pragma('table_info(accounts)');
const nsecCol = tableInfo.find(c => c.name === 'nsec_hex');
const hasBunkerCol = tableInfo.find(c => c.name === 'bunker_url');

if (nsecCol && nsecCol.notnull === 1) {
  console.log('Migrating accounts table: making nsec_hex nullable, adding bunker columns...');
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
  // Table exists but missing bunker columns
  try { db.exec(`ALTER TABLE accounts ADD COLUMN bunker_url TEXT`); } catch (e) {}
  try { db.exec(`ALTER TABLE accounts ADD COLUMN bunker_client_key TEXT`); } catch (e) {}
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
    scheduled_at DATETIME NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    event_id TEXT,
    signed_event TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );
`);

// Ensure signed_event column exists on scheduled_posts
try { db.exec(`ALTER TABLE scheduled_posts ADD COLUMN signed_event TEXT`); } catch (e) {}

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
      // NIP-46 nsecBunker (Amber, etc.)
      if (!bunker_url) return res.status(400).json({ error: 'Bunker URL required' });

      const bp = await parseBunkerInput(bunker_url);
      if (!bp) return res.status(400).json({ error: 'Invalid bunker URL. Expected format: bunker://pubkey?relay=wss://...' });

      // Generate a client keypair for bunker communication
      const clientSk = generateSecretKey();
      bunkerClientKeyHex = bytesToHex(clientSk);

      // Test the connection and get the actual signer pubkey
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

      // Use relays from the bunker pointer if none provided
      const relayList = relays || JSON.stringify(bp.relays);

      const result = db.prepare(
        'INSERT INTO accounts (name, nsec_hex, npub_hex, relays, login_type, bunker_url, bunker_client_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(name, null, pubkey, relayList, type, bunker_url, bunkerClientKeyHex);

      return res.json({ id: result.lastInsertRowid, name, npub_hex: pubkey, relays: relayList, login_type: type });

    } else if (type === 'extension') {
      // NIP-07 browser extension
      if (!npub_hex) return res.status(400).json({ error: 'Public key required for extension login' });
      pubkey = npub_hex;
    } else {
      // Direct private key
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
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Image Upload to nostr.build ---

app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  try {
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
      },
      body: body,
    });

    const result = await response.json();

    // Clean up local file after upload
    fs.unlinkSync(filePath);

    if (result.status === 'success' && result.data && result.data.length > 0) {
      const imageUrl = result.data[0].url;
      res.json({ url: imageUrl });
    } else {
      res.status(500).json({ error: 'Upload failed: ' + JSON.stringify(result) });
    }
  } catch (e) {
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// --- Post Routes ---

app.get('/api/posts', (req, res) => {
  const posts = db.prepare(`
    SELECT p.*, a.name as account_name, a.login_type
    FROM scheduled_posts p
    JOIN accounts a ON p.account_id = a.id
    ORDER BY p.scheduled_at ASC
  `).all();
  res.json(posts);
});

app.post('/api/posts', (req, res) => {
  const { account_id, content, scheduled_at, image_url, signed_event } = req.body;
  if (!account_id || !content || !scheduled_at) {
    return res.status(400).json({ error: 'account_id, content, and scheduled_at required' });
  }

  const result = db.prepare(
    'INSERT INTO scheduled_posts (account_id, content, image_url, scheduled_at, signed_event) VALUES (?, ?, ?, ?, ?)'
  ).run(account_id, content, image_url || null, scheduled_at, signed_event || null);

  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/posts/:id', (req, res) => {
  const post = db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(req.params.id);
  if (post && post.image_path) {
    const imgFile = path.join(uploadsDir, post.image_path);
    if (fs.existsSync(imgFile)) fs.unlinkSync(imgFile);
  }
  db.prepare(`DELETE FROM scheduled_posts WHERE id = ? AND status = 'pending'`).run(req.params.id);
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
    // Pre-signed event from NIP-07 browser extension
    signedEvent = JSON.parse(post.signed_event);

  } else if (post.login_type === 'bunker' && post.bunker_url && post.bunker_client_key) {
    // NIP-46: Sign via Amber / nsecBunker
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
    // Server-side signing with stored key
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
  const now = new Date().toISOString();
  const duePosts = db.prepare(
    `SELECT id FROM scheduled_posts WHERE status = 'pending' AND scheduled_at <= ?`
  ).all(now);

  for (const post of duePosts) {
    publishPost(post.id).catch(e => console.error(`Scheduler error for post ${post.id}:`, e.message));
  }
});

app.listen(PORT, () => {
  console.log(`Nostr Scheduler running at http://localhost:${PORT}`);
});
