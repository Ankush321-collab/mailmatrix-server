# Mailservice

A local SMTP mail catcher built with Node.js. Incoming emails are accepted over SMTP, parsed, and saved to disk as raw `.eml` files plus structured JSON metadata.

## Features

- Receives email over SMTP
- Stores each message in its own folder under `emails/`
- Parses sender, recipients, subject, headers, text, HTML, and attachments
- Saves attachments to disk
- Exposes a simple health endpoint
- Supports optional SMTP authentication with environment variables

## Scripts

- `npm start` — start the service
- `npm run dev` — start in watch mode

## Default ports

- SMTP: `2525`
- Health endpoint: `3000`

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

## Example test settings

Use these SMTP settings in your mail client or app:

- Host: `localhost`
- Port: `2525`
- Security: none
- Authentication: off, unless you configured `SMTP_USERNAME` and `SMTP_PASSWORD`
