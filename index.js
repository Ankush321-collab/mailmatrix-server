const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { SMTPServer } = require("smtp-server");
const { simpleParser } = require("mailparser");

function toNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function sanitizeFilename(value) {
  return String(value || "file")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "-")
    .slice(0, 120);
}

function normalizeAddressObject(addressObject) {
  if (!addressObject || !addressObject.value) {
    return [];
  }

  return addressObject.value.map(entry => ({
    name: entry.name || "",
    address: entry.address || ""
  }));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function ensureDirectory(dirPath) {
  await fsPromises.mkdir(dirPath, { recursive: true });
}

function buildMessageId() {
  return `${new Date().toISOString().replace(/[.:]/g, "-")}-${crypto.randomUUID()}`;
}

async function collectMessage(stream, maxSizeBytes) {
  const chunks = [];
  let totalBytes = 0;

  return new Promise((resolve, reject) => {
    let finished = false;

    const rejectOnce = error => {
      if (finished) {
        return;
      }

      finished = true;
      reject(error);
    };

    const resolveOnce = value => {
      if (finished) {
        return;
      }

      finished = true;
      resolve(value);
    };

    stream.on("data", chunk => {
      totalBytes += chunk.length;

      if (totalBytes > maxSizeBytes) {
        rejectOnce(new Error(`Message exceeded ${maxSizeBytes} bytes`));
        return;
      }

      chunks.push(chunk);
    });

    stream.once("error", rejectOnce);
    stream.once("end", () => resolveOnce(Buffer.concat(chunks)));
  });
}

async function saveAttachments(attachments, attachmentDir) {
  const savedAttachments = [];

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const originalName = attachment.filename || `attachment-${index + 1}`;
    const filename = sanitizeFilename(originalName);
    const targetPath = path.join(attachmentDir, filename);

    await fsPromises.writeFile(targetPath, attachment.content);

    savedAttachments.push({
      filename,
      contentType: attachment.contentType,
      size: attachment.size,
      contentDisposition: attachment.contentDisposition,
      checksum: attachment.checksum,
      path: targetPath
    });
  }

  return savedAttachments;
}

async function saveMessage(rawMessage, parsedMessage, session, config) {
  const messageId = buildMessageId();
  const messageDir = path.join(config.storageDir, messageId);
  const attachmentDir = path.join(messageDir, "attachments");

  await ensureDirectory(attachmentDir);

  const rawMessagePath = path.join(messageDir, "message.eml");
  await fsPromises.writeFile(rawMessagePath, rawMessage);

  const attachments = await saveAttachments(parsedMessage.attachments || [], attachmentDir);

  const metadata = {
    id: messageId,
    receivedAt: new Date().toISOString(),
    remoteAddress: session.remoteAddress,
    clientHostname: session.clientHostname,
    hostNameAppearsAs: session.hostNameAppearsAs,
    envelope: session.envelope,
    messageIdHeader: parsedMessage.messageId || "",
    subject: parsedMessage.subject || "",
    date: parsedMessage.date ? parsedMessage.date.toISOString() : null,
    from: normalizeAddressObject(parsedMessage.from),
    to: normalizeAddressObject(parsedMessage.to),
    cc: normalizeAddressObject(parsedMessage.cc),
    bcc: normalizeAddressObject(parsedMessage.bcc),
    replyTo: normalizeAddressObject(parsedMessage.replyTo),
    text: parsedMessage.text || "",
    html: parsedMessage.html || "",
    headers: (parsedMessage.headerLines || []).map(header => ({
      key: header.key,
      line: header.line
    })),
    attachments,
    rawMessagePath
  };

  const metadataPath = path.join(messageDir, "message.json");
  await fsPromises.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  return {
    id: messageId,
    metadataPath,
    rawMessagePath,
    attachmentCount: attachments.length
  };
}

const config = {
  smtpPort: toNumber(process.env.SMTP_PORT, 2525),
  smtpHost: process.env.SMTP_HOST || "0.0.0.0",
  statusPort: toNumber(process.env.STATUS_PORT, 3000),
  storageDir: path.resolve(process.env.STORAGE_DIR || path.join(__dirname, "emails")),
  maxSizeBytes: toNumber(process.env.MAX_MESSAGE_SIZE_BYTES, 10 * 1024 * 1024),
  requireAuth: Boolean(process.env.SMTP_USERNAME && process.env.SMTP_PASSWORD)
};

const state = {
  startedAt: new Date().toISOString(),
  totalConnections: 0,
  totalMessages: 0,
  lastMessageAt: null,
  lastError: null
};

const server = new SMTPServer({
  secure: false,
  disabledCommands: ["STARTTLS"],
  authOptional: !config.requireAuth,
  allowInsecureAuth: true,
  size: config.maxSizeBytes,
  banner: "Mailservice SMTP ready",

  onConnect(session, callback) {
    state.totalConnections += 1;
    console.log(`[SMTP] Client connected from ${session.remoteAddress}`);
    callback();
  },

  onAuth(auth, session, callback) {
    if (!config.requireAuth) {
      callback(null, { user: "anonymous" });
      return;
    }

    const isValidUser = auth.username === process.env.SMTP_USERNAME;
    const isValidPassword = auth.password === process.env.SMTP_PASSWORD;

    if (!isValidUser || !isValidPassword) {
      state.lastError = `Authentication failed for ${session.remoteAddress}`;
      callback(new Error("Invalid username or password"));
      return;
    }

    callback(null, { user: auth.username });
  },

  onMailFrom(address, session, callback) {
    console.log(`[SMTP] MAIL FROM <${address.address}>`);
    callback();
  },

  onRcptTo(address, session, callback) {
    console.log(`[SMTP] RCPT TO <${address.address}>`);
    callback();
  },

  onData(stream, session, callback) {
    collectMessage(stream, config.maxSizeBytes)
      .then(rawMessage => simpleParser(rawMessage).then(parsedMessage => ({ rawMessage, parsedMessage })))
      .then(({ rawMessage, parsedMessage }) => saveMessage(rawMessage, parsedMessage, session, config))
      .then(result => {
        state.totalMessages += 1;
        state.lastMessageAt = new Date().toISOString();
        console.log(
          `[SMTP] Stored message ${result.id} (${result.attachmentCount} attachments) in ${result.metadataPath}`
        );
        callback(null, "Message queued");
      })
      .catch(error => {
        state.lastError = formatError(error);
        console.error("[SMTP] Failed to process message:", error);
        callback(error);
      });
  }
});

const statusServer = http.createServer((request, response) => {
  if (request.url !== "/" && request.url !== "/health") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify(
      {
        service: "mailservice",
        status: "ok",
        smtp: {
          host: config.smtpHost,
          port: config.smtpPort,
          authRequired: config.requireAuth,
          maxSizeBytes: config.maxSizeBytes
        },
        storageDir: config.storageDir,
        metrics: state
      },
      null,
      2
    )
  );
});

async function start() {
  await ensureDirectory(config.storageDir);

  server.listen(config.smtpPort, config.smtpHost, () => {
    console.log(`[SMTP] Listening on ${config.smtpHost}:${config.smtpPort}`);
    console.log(`[SMTP] Messages will be stored in ${config.storageDir}`);
  });

  statusServer.listen(config.statusPort, () => {
    console.log(`[HTTP] Health endpoint available at http://localhost:${config.statusPort}/health`);
  });
}

function shutdown(signal) {
  console.log(`[SYSTEM] Received ${signal}, shutting down...`);

  statusServer.close(() => {
    console.log("[HTTP] Status server stopped");
  });

  server.close(() => {
    console.log("[SMTP] Server stopped");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch(error => {
  state.lastError = formatError(error);
  console.error("[SYSTEM] Failed to start mailservice:", error);
  process.exit(1);
});