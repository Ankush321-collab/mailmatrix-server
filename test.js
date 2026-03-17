"use strict";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");

const {
  config,
  handleRequest,
  listMessages,
  getMessageMetadata,
  deleteMessage,
  sanitizeFilename,
  normalizeAddressObject,
  formatError,
  toNumber
} = require("./index.js");

// ---------------------------------------------------------------------------
// Helper: make an HTTP request to a server
// ---------------------------------------------------------------------------
function request(server, method, urlPath) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const options = {
      hostname: "127.0.0.1",
      port: address.port,
      path: urlPath,
      method
    };

    const req = http.request(options, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json;

        try {
          json = JSON.parse(body);
        } catch {
          json = null;
        }

        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });

    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Helper: start a lightweight test HTTP server using handleRequest
// ---------------------------------------------------------------------------
function startTestServer(storageDir) {
  const savedStorageDir = config.storageDir;
  config.storageDir = storageDir;

  const srv = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    srv.listen(0, "127.0.0.1", err => {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        server: srv,
        close: () =>
          new Promise(res => {
            config.storageDir = savedStorageDir;
            srv.close(res);
          })
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helper: write a fake message.json to a temp storage dir
// ---------------------------------------------------------------------------
async function writeFakeMessage(storageDir, id, overrides = {}) {
  const messageDir = path.join(storageDir, id);
  await fsPromises.mkdir(path.join(messageDir, "attachments"), { recursive: true });

  const metadata = {
    id,
    receivedAt: "2026-01-01T00:00:00.000Z",
    remoteAddress: "127.0.0.1",
    clientHostname: "localhost",
    hostNameAppearsAs: "localhost",
    envelope: { mailFrom: { address: "sender@example.com" }, rcptTo: [] },
    messageIdHeader: "<test@example.com>",
    subject: "Test Subject",
    date: null,
    from: [{ name: "Sender", address: "sender@example.com" }],
    to: [{ name: "Recipient", address: "recipient@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    text: "Hello",
    html: "",
    headers: [],
    attachments: [],
    rawMessagePath: path.join(messageDir, "message.eml"),
    ...overrides
  };

  await fsPromises.writeFile(path.join(messageDir, "message.json"), JSON.stringify(metadata, null, 2), "utf8");
  await fsPromises.writeFile(path.join(messageDir, "message.eml"), "From: sender@example.com\r\n\r\nHello");

  return metadata;
}

// ===========================================================================
// Unit tests for pure helper functions
// ===========================================================================

describe("toNumber", () => {
  test("returns parsed value for a valid numeric string", () => {
    assert.equal(toNumber("42", 0), 42);
  });

  test("returns default for a non-numeric string", () => {
    assert.equal(toNumber("abc", 99), 99);
  });

  test("returns default for undefined", () => {
    assert.equal(toNumber(undefined, 5), 5);
  });

  test("returns default for NaN", () => {
    assert.equal(toNumber(NaN, 7), 7);
  });

  test("accepts numeric values directly", () => {
    assert.equal(toNumber(3.14, 0), 3.14);
  });
});

describe("sanitizeFilename", () => {
  test("replaces disallowed characters with underscores", () => {
    assert.equal(sanitizeFilename('bad<name>:file"here'), "bad_name__file_here");
  });

  test("replaces whitespace with hyphens", () => {
    assert.equal(sanitizeFilename("hello world"), "hello-world");
  });

  test("returns 'file' when given an empty string", () => {
    assert.equal(sanitizeFilename(""), "file");
  });

  test("returns 'file' for null/undefined", () => {
    assert.equal(sanitizeFilename(null), "file");
    assert.equal(sanitizeFilename(undefined), "file");
  });

  test("truncates long filenames to 120 characters", () => {
    const long = "a".repeat(200);
    assert.equal(sanitizeFilename(long).length, 120);
  });
});

describe("normalizeAddressObject", () => {
  test("returns empty array for null input", () => {
    assert.deepEqual(normalizeAddressObject(null), []);
  });

  test("returns empty array when value property is missing", () => {
    assert.deepEqual(normalizeAddressObject({}), []);
  });

  test("maps address entries correctly", () => {
    const input = {
      value: [
        { name: "Alice", address: "alice@example.com" },
        { name: "", address: "bob@example.com" }
      ]
    };
    assert.deepEqual(normalizeAddressObject(input), [
      { name: "Alice", address: "alice@example.com" },
      { name: "", address: "bob@example.com" }
    ]);
  });

  test("fills in empty strings for missing name/address", () => {
    const input = { value: [{}] };
    assert.deepEqual(normalizeAddressObject(input), [{ name: "", address: "" }]);
  });
});

describe("formatError", () => {
  test("returns the message of an Error instance", () => {
    assert.equal(formatError(new Error("boom")), "boom");
  });

  test("stringifies non-Error values", () => {
    assert.equal(formatError("raw string"), "raw string");
    assert.equal(formatError(42), "42");
  });
});

// ===========================================================================
// Unit tests for storage helpers (listMessages, getMessageMetadata, deleteMessage)
// ===========================================================================

describe("listMessages", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mailmatrix-test-"));
  });

  after(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array when storage dir does not exist", async () => {
    const missing = path.join(tmpDir, "nonexistent");
    const result = await listMessages(missing);
    assert.deepEqual(result, []);
  });

  test("returns empty array when no messages are stored", async () => {
    const emptyDir = path.join(tmpDir, "empty");
    await fsPromises.mkdir(emptyDir);
    const result = await listMessages(emptyDir);
    assert.deepEqual(result, []);
  });

  test("lists stored messages as summaries sorted newest first", async () => {
    const storeDir = path.join(tmpDir, "messages");
    await fsPromises.mkdir(storeDir);

    await writeFakeMessage(storeDir, "msg-001", { receivedAt: "2026-01-01T10:00:00.000Z" });
    await writeFakeMessage(storeDir, "msg-002", { receivedAt: "2026-01-02T10:00:00.000Z" });

    const result = await listMessages(storeDir);

    assert.equal(result.length, 2);
    assert.equal(result[0].id, "msg-002");
    assert.equal(result[1].id, "msg-001");
    assert.ok("subject" in result[0]);
    assert.ok("attachmentCount" in result[0]);
    assert.ok(!("text" in result[0]), "summary should not include full text body");
  });

  test("skips directories without a valid message.json", async () => {
    const storeDir = path.join(tmpDir, "with-invalid");
    await fsPromises.mkdir(storeDir);
    await fsPromises.mkdir(path.join(storeDir, "bad-dir"));

    const result = await listMessages(storeDir);
    assert.deepEqual(result, []);
  });
});

describe("getMessageMetadata", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mailmatrix-test-"));
  });

  after(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns null when message does not exist", async () => {
    const result = await getMessageMetadata(tmpDir, "no-such-id");
    assert.equal(result, null);
  });

  test("returns parsed metadata for an existing message", async () => {
    await writeFakeMessage(tmpDir, "msg-abc");
    const result = await getMessageMetadata(tmpDir, "msg-abc");
    assert.equal(result.id, "msg-abc");
    assert.equal(result.subject, "Test Subject");
  });
});

describe("deleteMessage", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mailmatrix-test-"));
  });

  after(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns false when message does not exist", async () => {
    const result = await deleteMessage(tmpDir, "no-such-id");
    assert.equal(result, false);
  });

  test("deletes message directory and returns true", async () => {
    await writeFakeMessage(tmpDir, "msg-del");
    const result = await deleteMessage(tmpDir, "msg-del");
    assert.equal(result, true);

    const exists = await fsPromises.access(path.join(tmpDir, "msg-del")).then(() => true, () => false);
    assert.equal(exists, false);
  });
});

// ===========================================================================
// HTTP API integration tests
// ===========================================================================

describe("HTTP API", () => {
  let tmpDir;
  let srv;

  before(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mailmatrix-api-test-"));
    srv = await startTestServer(tmpDir);
  });

  after(async () => {
    await srv.close();
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  test("GET /health returns 200 with service info", async () => {
    const res = await request(srv.server, "GET", "/health");
    assert.equal(res.status, 200);
    assert.equal(res.json.service, "mailservice");
    assert.equal(res.json.status, "ok");
    assert.ok(res.json.smtp);
    assert.ok(res.json.metrics);
  });

  test("GET / returns 200 with service info", async () => {
    const res = await request(srv.server, "GET", "/");
    assert.equal(res.status, 200);
    assert.equal(res.json.service, "mailservice");
  });

  test("GET /unknown returns 404", async () => {
    const res = await request(srv.server, "GET", "/unknown");
    assert.equal(res.status, 404);
    assert.equal(res.json.error, "Not found");
  });

  describe("GET /messages", () => {
    test("returns empty list when no messages exist", async () => {
      const res = await request(srv.server, "GET", "/messages");
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.messages, []);
    });

    test("returns message summaries after messages are stored", async () => {
      await writeFakeMessage(tmpDir, "api-msg-001");
      const res = await request(srv.server, "GET", "/messages");
      assert.equal(res.status, 200);
      assert.equal(res.json.messages.length >= 1, true);
      const summary = res.json.messages.find(m => m.id === "api-msg-001");
      assert.ok(summary, "should include the stored message");
      assert.equal(summary.subject, "Test Subject");
      assert.ok(!("text" in summary), "summary should not include full text");
    });
  });

  describe("GET /messages/:id", () => {
    beforeEach(async () => {
      await writeFakeMessage(tmpDir, "api-get-msg");
    });

    test("returns 200 with full metadata for an existing message", async () => {
      const res = await request(srv.server, "GET", "/messages/api-get-msg");
      assert.equal(res.status, 200);
      assert.equal(res.json.id, "api-get-msg");
      assert.equal(res.json.subject, "Test Subject");
      assert.ok("text" in res.json, "full response should include text");
    });

    test("returns 404 for a nonexistent message", async () => {
      const res = await request(srv.server, "GET", "/messages/does-not-exist");
      assert.equal(res.status, 404);
      assert.equal(res.json.error, "Message not found");
    });

    test("path traversal attempt does not expose any message (returns 4xx)", async () => {
      const res = await request(srv.server, "GET", "/messages/../../etc/passwd");
      assert.ok(res.status >= 400, `expected 4xx status, got ${res.status}`);
    });
  });

  describe("GET /messages/:id/eml", () => {
    before(async () => {
      await writeFakeMessage(tmpDir, "api-eml-msg");
    });

    test("returns 200 with EML content for an existing message", async () => {
      const res = await request(srv.server, "GET", "/messages/api-eml-msg/eml");
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-type"], "message/rfc822");
      assert.ok(res.body.includes("From:"), "EML body should contain headers");
    });

    test("returns 404 for a nonexistent message", async () => {
      const res = await request(srv.server, "GET", "/messages/no-such-eml/eml");
      assert.equal(res.status, 404);
    });
  });

  describe("DELETE /messages/:id", () => {
    test("deletes an existing message and returns 200", async () => {
      await writeFakeMessage(tmpDir, "api-del-msg");
      const res = await request(srv.server, "DELETE", "/messages/api-del-msg");
      assert.equal(res.status, 200);
      assert.equal(res.json.deleted, true);

      const getRes = await request(srv.server, "GET", "/messages/api-del-msg");
      assert.equal(getRes.status, 404);
    });

    test("returns 404 when deleting a nonexistent message", async () => {
      const res = await request(srv.server, "DELETE", "/messages/ghost-message");
      assert.equal(res.status, 404);
      assert.equal(res.json.error, "Message not found");
    });
  });
});
