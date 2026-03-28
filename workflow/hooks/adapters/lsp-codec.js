/**
 * LSP Codec – JSON-RPC 2.0 message encoding/decoding for LSP protocol
 *
 * Extracted from lsp-adapter.js (ADR-33 Phase 4) to isolate the
 * wire protocol codec and server configuration from the adapter logic.
 *
 * This module provides:
 *   - LSPCodec class – Content-Length header based message framing
 *   - LSP_SERVERS constant – Language server configurations
 *
 * @module lsp-codec
 */

'use strict';

// ─── LSP Message Codec ────────────────────────────────────────────────────────

/**
 * Encodes/decodes LSP JSON-RPC 2.0 messages with Content-Length headers.
 */
class LSPCodec {
  constructor() {
    this._buffer = Buffer.alloc(0);
    this._contentLength = -1;
    /** @type {Function[]} */
    this._listeners = [];
  }

  /** Register a listener for decoded messages */
  onMessage(fn) {
    this._listeners.push(fn);
  }

  /** Feed raw bytes from the LSP server's stdout */
  feed(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    this._tryParse();
  }

  /** Encode a JSON-RPC message to an LSP wire-format Buffer */
  static encode(msg) {
    const json = JSON.stringify(msg);
    const len = Buffer.byteLength(json, 'utf-8');
    return Buffer.from(`Content-Length: ${len}\r\n\r\n${json}`, 'utf-8');
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _tryParse() {
    while (true) {
      if (this._contentLength === -1) {
        // Look for header boundary
        const headerEnd = this._buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const header = this._buffer.slice(0, headerEnd).toString('utf-8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Skip malformed header
          this._buffer = this._buffer.slice(headerEnd + 4);
          continue;
        }
        this._contentLength = parseInt(match[1], 10);
        this._buffer = this._buffer.slice(headerEnd + 4);
      }

      if (this._buffer.length < this._contentLength) return;

      const body = this._buffer.slice(0, this._contentLength).toString('utf-8');
      this._buffer = this._buffer.slice(this._contentLength);
      this._contentLength = -1;

      try {
        const msg = JSON.parse(body);
        for (const fn of this._listeners) fn(msg);
      } catch (err) {
        console.warn(`[LSPAdapter] Failed to parse LSP message: ${err.message}`);
      }
    }
  }
}

// ─── Language Server Configurations ───────────────────────────────────────────

const LSP_SERVERS = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    languages: ['.ts', '.tsx', '.js', '.jsx'],
    installHint: 'npm install -g typescript-language-server typescript',
  },
  pyright: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    languages: ['.py'],
    installHint: 'npm install -g pyright',
  },
  pylsp: {
    command: 'pylsp',
    args: [],
    languages: ['.py'],
    installHint: 'pip install python-lsp-server',
  },
  gopls: {
    command: 'gopls',
    args: ['serve'],
    languages: ['.go'],
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  'rust-analyzer': {
    command: 'rust-analyzer',
    args: [],
    languages: ['.rs'],
    installHint: 'rustup component add rust-analyzer',
  },
  omnisharp: {
    command: 'OmniSharp',
    args: ['--languageserver'],
    languages: ['.cs'],
    installHint: 'dotnet tool install -g omnisharp',
  },
};

module.exports = {
  LSPCodec,
  LSP_SERVERS,
};
