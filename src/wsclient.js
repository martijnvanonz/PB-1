// Minimal WebSocket client over node:tls. Zero dependencies.
//
// Node's global WebSocket cannot be told to trust one specific self-signed
// certificate, and TrueNAS serves a self-signed one on its LAN address. This
// client does the RFC 6455 client side that the TrueNAS JSON-RPC session
// needs: the HTTP upgrade (with the Sec-WebSocket-Accept check), masked text
// frames out, and text frames in — 7-, 16- and 64-bit lengths, continuation
// frames, ping -> pong, close.
//
// Certificate handling happens BEFORE any byte is written:
//   - pinSha256 set:   rejectUnauthorized:false, then the peer's SHA-256
//                      fingerprint must match. A mismatch destroys the
//                      socket; the upgrade request (and so everything the
//                      caller would send afterwards, such as an API key) is
//                      never written.
//   - pinSha256 empty: normal CA verification (rejectUnauthorized:true).
//
// Events (EventEmitter): 'open', 'message' (string), 'error' (Error), 'close'.
// Errors carry .code === 'CERT_UNTRUSTED' or 'CERT_PIN_MISMATCH' when the
// failure is about the certificate.

const tls = require('node:tls');
const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// OpenSSL verify-failure codes that mean "this certificate is not trusted"
// (as opposed to the network being down).
const UNTRUSTED_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizeFingerprint(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function tlsOptionsFor(url, rejectUnauthorized) {
  const opts = {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 443),
    rejectUnauthorized,
  };
  // SNI must be a hostname; an IP literal as servername is invalid.
  if (!net.isIP(opts.host)) opts.servername = opts.host;
  return opts;
}

// Encodes one masked client frame.
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN set: no outgoing fragmentation
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

class WsClient extends EventEmitter {
  // `url` is a wss:// URL. opts: { pinSha256, timeoutMs }.
  constructor(rawUrl, opts = {}) {
    super();
    this.url = new URL(rawUrl);
    this.pin = normalizeFingerprint(opts.pinSha256);
    this.state = 'connecting'; // connecting | open | closing | closed
    this.chunks = [];
    this.buffered = 0;
    this.needed = 0; // bytes required before parsing is worth attempting
    this.handshakeDone = false;
    this.fragments = null; // { opcode, parts, size } while a message is split
    this.expectedAccept = null;

    if (this.url.protocol !== 'wss:') {
      // Never speak plain ws: TrueNAS revokes keys used over an insecure link.
      setImmediate(() => this._fail(codedError('TrueNAS needs an https:// URL.', 'WS_INSECURE')));
      return;
    }

    const socket = tls.connect(tlsOptionsFor(this.url, !this.pin));
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('secureConnect', () => this._onSecureConnect());
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._fail(this._classify(err)));
    socket.on('close', () => this._closed());
  }

  _classify(err) {
    if (err && UNTRUSTED_CODES.has(err.code)) {
      return codedError('The TrueNAS certificate is not trusted.', 'CERT_UNTRUSTED');
    }
    return err;
  }

  _onSecureConnect() {
    if (this.pin) {
      const cert = this.socket.getPeerCertificate();
      const presented = normalizeFingerprint(cert && cert.fingerprint256);
      if (!presented || presented !== this.pin) {
        // Destroy before writing a single byte of the upgrade request.
        const err = codedError(
          'The certificate TrueNAS presented does not match the pinned fingerprint.',
          'CERT_PIN_MISMATCH'
        );
        err.presentedFingerprint = presented || null;
        this._fail(err);
        return;
      }
    }
    const key = crypto.randomBytes(16).toString('base64');
    this.expectedAccept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    const host = this.url.host;
    const path = `${this.url.pathname || '/'}${this.url.search}`;
    this.socket.write(
      `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
    );
  }

  _onData(chunk) {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    if (this.buffered < this.needed) return; // big frame still arriving
    try {
      if (!this.handshakeDone) this._parseHandshake();
      if (this.handshakeDone) this._parseFrames();
    } catch (e) {
      this._fail(e);
    }
  }

  _takeAll() {
    const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = [];
    this.buffered = 0;
    return buf;
  }

  _unshift(buf) {
    if (buf.length === 0) return;
    this.chunks = [buf];
    this.buffered = buf.length;
  }

  _parseHandshake() {
    const buf = this._takeAll();
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) {
      if (buf.length > MAX_HEADER_BYTES) throw new Error('TrueNAS sent an oversized handshake response.');
      this._unshift(buf);
      return;
    }
    const head = buf.subarray(0, end).toString('latin1');
    const lines = head.split('\r\n');
    if (!/^HTTP\/1\.1 101\b/.test(lines[0])) {
      throw new Error(`TrueNAS refused the WebSocket upgrade (${lines[0].slice(0, 40)}).`);
    }
    let accept = null;
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0 && line.slice(0, i).trim().toLowerCase() === 'sec-websocket-accept') {
        accept = line.slice(i + 1).trim();
      }
    }
    if (accept !== this.expectedAccept) throw new Error('TrueNAS sent a bad Sec-WebSocket-Accept value.');
    this.handshakeDone = true;
    this.state = 'open';
    this._unshift(buf.subarray(end + 4));
    this.emit('open');
  }

  _parseFrames() {
    while (this.state !== 'closed') {
      if (this.buffered < 2) return;
      const buf = this._takeAll();
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return this._wait(buf, 4);
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return this._wait(buf, 10);
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error('TrueNAS sent a frame that is too large.');
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_MESSAGE_BYTES) throw new Error('TrueNAS sent a frame that is too large.');
      const maskLen = masked ? 4 : 0;
      const total = offset + maskLen + len;
      if (buf.length < total) return this._wait(buf, total);

      let payload = buf.subarray(offset + maskLen, total);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        payload = Buffer.from(payload); // own copy before unmasking in place
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this._unshift(buf.subarray(total));
      this.needed = 0;
      this._onFrame(fin, opcode, payload);
    }
  }

  // Not enough bytes yet: put them back and remember how many we need, so
  // _onData does not re-concatenate a large frame on every small chunk.
  _wait(buf, needed) {
    this._unshift(buf);
    this.needed = needed;
  }

  _onFrame(fin, opcode, payload) {
    if (opcode === OP_PING) {
      this._writeFrame(OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG) return;
    if (opcode === OP_CLOSE) {
      if (this.state === 'open') this._writeFrame(OP_CLOSE, payload.subarray(0, 2));
      this.state = 'closing';
      this.socket.end();
      return;
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this.fragments) throw new Error('TrueNAS sent a new message before finishing the last one.');
      this.fragments = { opcode, parts: [], size: 0 };
    } else if (opcode !== OP_CONT || !this.fragments) {
      throw new Error('TrueNAS sent an unexpected WebSocket frame.');
    }
    const frag = this.fragments;
    frag.size += payload.length;
    if (frag.size > MAX_MESSAGE_BYTES) throw new Error('TrueNAS sent a message that is too large.');
    frag.parts.push(payload);
    if (!fin) return;
    this.fragments = null;
    if (frag.opcode === OP_TEXT) this.emit('message', Buffer.concat(frag.parts).toString('utf8'));
  }

  _writeFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return;
    this.socket.write(encodeFrame(opcode, payload));
  }

  send(text) {
    if (this.state !== 'open') throw new Error('The WebSocket is not open.');
    this._writeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  close() {
    if (this.state === 'closed' || this.state === 'closing') return;
    const wasOpen = this.state === 'open';
    this.state = 'closing';
    if (!this.socket) return;
    if (wasOpen) this._writeFrame(OP_CLOSE, Buffer.alloc(0));
    this.socket.end();
    const t = setTimeout(() => this.socket.destroy(), 1000);
    t.unref();
  }

  _fail(err) {
    if (this.state === 'closed') return;
    if (this.socket) this.socket.destroy();
    this.state = 'closed';
    this.emit('error', err);
    this.emit('close');
  }

  _closed() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.emit('close');
  }
}

// Connects with verification off, reads the certificate the server presents,
// and hangs up without sending anything. Used only to SHOW the user a
// fingerprint to trust; a fingerprint is public, not a secret.
function probeFingerprint(rawUrl, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return resolve(null);
    }
    const socket = tls.connect(tlsOptionsFor(url, false));
    const done = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      done(cert && cert.fingerprint256 ? normalizeFingerprint(cert.fingerprint256) : null);
    });
    socket.on('error', () => done(null));
  });
}

module.exports = { WsClient, probeFingerprint, encodeFrame };
