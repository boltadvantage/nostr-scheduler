# Nostr Scheduler

A local web app for scheduling future posts to Nostr across multiple accounts. Built by [Bolt Advantage](https://boltadvantage.com).

## Features

- **Multi-account support** — manage several Nostr identities from one dashboard
- **Three login methods:**
  - **Amber / nsecBunker (NIP-46)** — paste your `bunker://` URL from Amber. Amber must be online when scheduled posts publish.
  - **Browser Extension (NIP-07)** — works with nos2x, Alby, etc. Events are signed in the browser at schedule time.
  - **Private Key (hex)** — paste your hex private key directly. Stored locally in SQLite, never transmitted.
- **Queue system** — set daily posting times per account. Queued posts are published in order (oldest first) at each time slot.
- **Draft posts** — save drafts from the Compose tab or create them via the API. Review, edit, then promote to queue or schedule.
- **API access** — generate API keys to let external tools (like Claude) create draft posts programmatically.
- **Image uploads** — upload images to [nostr.build](https://nostr.build) with NIP-98 authentication, or paste any image URL
- **Relay management** — add/remove relays per account at any time
- **Scheduler** — posts are automatically published when the scheduled time arrives (checks every 30 seconds)
- **Send Now** — bypass the schedule and publish immediately
- **Post history** — sent and failed posts are archived, hidden by default, viewable via toggle

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later

## Quick Start

```bash
git clone https://github.com/BoltAdvantage/nostr-scheduler.git
cd nostr-scheduler
npm install
npm start
```

Open [http://localhost:3847](http://localhost:3847) in your browser.

You can also set a custom port via the `PORT` environment variable:

```bash
PORT=4000 npm start
```

## Usage

### 1. Add an Account

Go to the **Accounts** tab and choose one of three methods:

- **Amber / nsecBunker**: Open Amber on your phone, go to your account's "Nostr Connect", copy the `bunker://` URL, and paste it in. Approve the connection request in Amber.
- **Browser Extension**: If you have nos2x, Alby, or another NIP-07 extension installed, click "Login with Extension" and approve the key request.
- **Private Key**: Paste your 64-character hex private key. You can optionally specify relays (comma-separated).

### 2. Compose a Post

Go to the **Compose** tab:

1. Select which account to post from
2. Write your content
3. Optionally attach an image:
   - Select a file and click **Upload to nostr.build** — the hosted URL is automatically filled in
   - Or paste any public image URL directly
4. Choose how to post:
   - **Add to Queue** — post goes into the queue and fires at the next available time slot
   - **Specific Date/Time** — pick an exact date and time
   - **Save as Draft** — save for later review before publishing

### 3. Manage Drafts

The **Drafts** tab shows all draft posts. For each draft you can:

- **Edit** content, image URL, or change the target account
- **Send Now** — publish immediately
- **Queue** — add to the account's queue
- **Schedule** — set a specific date/time
- **Delete** — discard the draft

### 4. Set Up Queues

Go to the **Queues** tab to configure daily posting times per account. Each time slot fires once per day, publishing the oldest queued post for that account. You can enable, disable, or remove individual time slots.

### 5. Manage Scheduled Posts

The **Scheduled** tab shows pending posts and their status:

- **PENDING** — waiting for the scheduled time or next queue slot
- **SENT** — successfully published to relays
- **FAILED** — something went wrong (error details shown)

Toggle **Show sent/failed** to view post history. Use **Clear History** to remove old entries.

### 6. Manage Relays

Each account has its own relay list. On the **Accounts** tab, you can add or remove relays per account at any time. Posts are published to all relays configured for that account.

### 7. API Access

The **Drafts** tab includes an API Keys section. Generate a key to allow external tools to create drafts:

```bash
# Create a draft
curl -X POST http://localhost:3847/api/v1/drafts \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello Nostr!", "account_id": 1}'

# List drafts
curl http://localhost:3847/api/v1/drafts \
  -H "Authorization: Bearer YOUR_API_KEY"

# List accounts
curl http://localhost:3847/api/v1/accounts \
  -H "Authorization: Bearer YOUR_API_KEY"
```

API keys are shown once at creation, stored as SHA-256 hashes, and can be revoked at any time.

## How It Works

- The server checks for due posts every 30 seconds
- **Key accounts**: events are signed server-side with the stored private key at publish time
- **Extension accounts**: events are pre-signed in the browser when you schedule the post, then published at the scheduled time
- **Bunker accounts**: the server connects to your nsecBunker (Amber) at publish time to request a signature — Amber must be running and approve the request
- **Queue system**: time slots fire once per day at or after the configured time, publishing the oldest queued pending post for that account
- Images are uploaded to nostr.build with NIP-98 authentication (signed per account type) and the URL is included in the post

## Data Storage

Everything is stored locally:

- **Database**: `nostr-scheduler.db` (SQLite) in the project root
- **Uploads**: temporarily stored in `uploads/` during the nostr.build upload process, then deleted

No data is sent to any server other than the Nostr relays you configure and nostr.build for image hosting.

## License

MIT
