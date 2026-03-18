# Nostr Scheduler

A local web app for scheduling future posts to Nostr across multiple accounts. Built by [Bolt Advantage](https://boltadvantage.com).

## Features

- **Multi-account support** — manage several Nostr identities from one dashboard
- **Three login methods:**
  - **Amber / nsecBunker (NIP-46)** — paste your `bunker://` URL from Amber. Amber must be online when scheduled posts publish.
  - **Browser Extension (NIP-07)** — works with nos2x, Alby, etc. Events are signed in the browser at schedule time.
  - **Private Key (hex)** — paste your hex private key directly. Stored locally in SQLite, never transmitted.
- **Image uploads** — upload images to [nostr.build](https://nostr.build) directly from the app, or paste any image URL
- **Relay management** — add/remove relays per account at any time
- **Scheduler** — posts are automatically published when the scheduled time arrives (checks every 30 seconds)
- **Send Now** — bypass the schedule and publish immediately

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
4. Pick a date and time
5. Click **Schedule Post**

### 3. Manage Scheduled Posts

The **Scheduled** tab shows all your posts with their status:

- **PENDING** — waiting for the scheduled time
- **SENT** — successfully published to relays
- **FAILED** — something went wrong (error details shown)

You can **Send Now** to publish immediately, or **Delete** to cancel a pending post.

### 4. Manage Relays

Each account has its own relay list. On the **Accounts** tab, you can add or remove relays per account at any time. Posts are published to all relays configured for that account.

## How It Works

- The server checks for due posts every 30 seconds
- **Key accounts**: events are signed server-side with the stored private key at publish time
- **Extension accounts**: events are pre-signed in the browser when you schedule the post, then published at the scheduled time
- **Bunker accounts**: the server connects to your nsecBunker (Amber) at publish time to request a signature — Amber must be running and approve the request
- Images are uploaded to nostr.build's public API and the URL is included in the post

## Data Storage

Everything is stored locally:

- **Database**: `nostr-scheduler.db` (SQLite) in the project root
- **Uploads**: temporarily stored in `uploads/` during the nostr.build upload process, then deleted

No data is sent to any server other than the Nostr relays you configure and nostr.build for image hosting.

## License

MIT
