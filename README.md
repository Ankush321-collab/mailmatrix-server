# Mailservice

A local SMTP mail catcher built with Node.js. Incoming emails are accepted over SMTP, parsed, and saved to disk as raw `.eml` files plus structured JSON metadata.

## Features

- Receives email over SMTP
- Stores each message in its own folder under `emails/`
- Parses sender, recipients, subject, headers, text, HTML, and attachments
- Saves attachments to disk
- REST API for listing, retrieving, and deleting stored messages
- Exposes a health endpoint
- Supports optional SMTP authentication with environment variables

## Scripts

- `npm start` — start the service
- `npm run dev` — start in watch mode
- `npm test` — run the test suite

## Default ports

- SMTP: `2525`
- HTTP API / Health endpoint: `3000`

Port `25` usually needs elevated privileges on Windows, so the service defaults to `2525`.

## Configuration

All configuration is done with environment variables:

- `SMTP_HOST` — default `0.0.0.0`
- `SMTP_PORT` — default `2525`
- `STATUS_PORT` — default `3000`
- `STORAGE_DIR` — default `./emails`
- `MAX_MESSAGE_SIZE_BYTES` — default `10485760`
- `SMTP_USERNAME` — optional
- `SMTP_PASSWORD` — optional

If both `SMTP_USERNAME` and `SMTP_PASSWORD` are set, SMTP auth is required.

## Run

1. Install dependencies:
   - `npm install`
2. Start the service:
   - `npm start`
3. Check status:
   - `http://localhost:3000/health`

## Message storage

Each incoming message is written to:

- `emails/<message-id>/message.eml`
- `emails/<message-id>/message.json`
- `emails/<message-id>/attachments/*`

## REST API

### Health

| Method | Path      | Description                   |
|--------|-----------|-------------------------------|
| GET    | `/health` | Service status and metrics    |

### Messages

| Method | Path                    | Description                              |
|--------|-------------------------|------------------------------------------|
| GET    | `/messages`             | List all stored messages (summary view)  |
| GET    | `/messages/:id`         | Get full metadata for a single message   |
| GET    | `/messages/:id/eml`     | Download the raw `.eml` file             |
| DELETE | `/messages/:id`         | Delete a stored message                  |

#### `GET /messages`

Returns an array of message summaries sorted newest first:

```json
{
  "messages": [
    {
      "id": "2026-01-02T10-00-00-000Z-<uuid>",
      "receivedAt": "2026-01-02T10:00:00.000Z",
      "from": [{ "name": "Alice", "address": "alice@example.com" }],
      "to": [{ "name": "Bob", "address": "bob@example.com" }],
      "subject": "Hello",
      "attachmentCount": 0
    }
  ]
}
```

#### `GET /messages/:id`

Returns the full parsed metadata stored in `message.json` for that message.

#### `GET /messages/:id/eml`

Responds with the raw RFC 822 message as a file download (`Content-Type: message/rfc822`).

#### `DELETE /messages/:id`

Removes the message directory (EML, JSON, and attachments) and returns:

```json
{ "deleted": true }
```

Returns `404` if the message does not exist.

## Example test settings

Use these SMTP settings in your mail client or app:

- Host: `localhost`
- Port: `2525`
- Security: none
- Authentication: off, unless you configured `SMTP_USERNAME` and `SMTP_PASSWORD`
