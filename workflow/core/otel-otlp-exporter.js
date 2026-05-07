'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const FLUSH_SIZE = 10;
const MAX_BUFFER_SIZE = 100;
const SOCKET_TIMEOUT_MS = 5000;

class OTLPOtlpExporter {
  constructor(options = {}) {
    this._endpoint = options.endpoint || null;
    this._outputDir = options.outputDir || null;
    this._buffer = [];
    this._headers = Object.assign({
      'Content-Type': 'application/json',
    }, this._parseOtelHeaders());
  }

  _parseOtelHeaders() {
    const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS || '';
    if (!raw) return {};
    const headers = {};
    for (const pair of raw.split(',')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const key = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      if (key && val) headers[key] = val;
    }
    return headers;
  }

  _toOTLPSpan(record) {
    const hashInput = record.runtime?.hash || '';
    const traceId = hashInput.padEnd(32, '0').slice(0, 32);
    const spanId = hashInput.padEnd(16, '0').slice(0, 16);
    const nowNano = record.generatedAt
      ? String(Date.parse(record.generatedAt) * 1_000_000)
      : String(Date.now() * 1_000_000);
    const durationNs = record.runtime?.latencyMs
      ? String(Math.round(record.runtime.latencyMs * 1_000_000))
      : '0';
    return {
      traceId,
      spanId,
      name: `llm.injection.${record.mode || 'unknown'}`,
      kind: 1,
      startTimeUnixNano: nowNano,
      endTimeUnixNano: String(Number(nowNano) + Number(durationNs)),
      attributes: [
        { key: 'llm.callsite', value: { stringValue: String(record.callSite || '') } },
        { key: 'llm.injection.mode', value: { stringValue: String(record.mode || '') } },
        { key: 'llm.runtime.hash', value: { stringValue: String(record.runtime?.hash || '') } },
        { key: 'llm.candidate.hash', value: { stringValue: String(record.candidate?.hash || '') } },
        { key: 'llm.quality.drift_score', value: { doubleValue: Number(record.qualityDriftScore ?? 0) } },
        { key: 'llm.canary.allowed', value: { boolValue: Boolean(record.canary?.allowed) } },
        { key: 'llm.canary.rollback', value: { boolValue: Boolean(record.canary?.rollback) } },
        { key: 'llm.changed_prompt_output', value: { boolValue: Boolean(record.changedPromptOutput) } },
      ],
      status: {},
    };
  }

  _toOTLPMetric(record) {
    const timeUnixNano = record.generatedAt
      ? String(Date.parse(record.generatedAt) * 1_000_000)
      : String(Date.now() * 1_000_000);
    return {
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [
            {
              name: 'llm_quality_drift_score',
              gauge: {
                dataPoints: [{
                  asDouble: Number(record.qualityDriftScore ?? 0),
                  timeUnixNano,
                }],
              },
            },
            {
              name: 'llm_runtime_latency_ms',
              histogram: {
                dataPoints: [{
                  asDouble: Number(record.runtime?.latencyMs ?? 0),
                  timeUnixNano,
                  count: '1',
                  sum: Number(record.runtime?.latencyMs ?? 0),
                }],
              },
            },
            {
              name: 'llm_canary_rollback_total',
              sum: {
                dataPoints: [{
                  asDouble: record.canary?.rollback ? 1 : 0,
                  timeUnixNano,
                }],
                isMonotonic: true,
              },
            },
          ],
        }],
      }],
    };
  }

  _buildTracePayload(records) {
    return {
      resourceSpans: [{
        scopeSpans: [{
          spans: records.map(r => this._toOTLPSpan(r)),
        }],
      }],
    };
  }

  _buildMetricPayload(records) {
    const allMetrics = [];
    for (const r of records) {
      const scopeMetrics = this._toOTLPMetric(r).resourceMetrics[0].scopeMetrics[0];
      allMetrics.push(...scopeMetrics.metrics);
    }
    return {
      resourceMetrics: [{
        scopeMetrics: [{ metrics: allMetrics }],
      }],
    };
  }

  _post(urlPath, payload, callback) {
    if (!this._endpoint) return callback(null, { skipped: true });
    let url;
    try {
      url = new URL(this._endpoint);
    } catch (_) {
      return callback(new Error('Invalid OTLP endpoint'), null);
    }
    const transport = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: urlPath,
      method: 'POST',
      headers: Object.assign({}, this._headers, { 'Content-Length': Buffer.byteLength(body) }),
      timeout: SOCKET_TIMEOUT_MS,
    };
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          callback(null, { statusCode: res.statusCode });
        } else {
          callback(new Error(`OTLP POST ${urlPath} returned ${res.statusCode}`), null);
        }
      });
    });
    req.on('error', (err) => callback(err, null));
    req.on('timeout', () => { req.destroy(); callback(new Error('OTLP POST timeout'), null); });
    req.write(body);
    req.end();
  }

  _fallback(records) {
    if (!this._outputDir) return;
    try {
      const fp = path.join(this._outputDir, 'otel-fallback.jsonl');
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      for (const r of records) {
        fs.appendFileSync(fp, JSON.stringify(r) + '\n', 'utf-8');
      }
    } catch (_) { /* silent */ }
  }

  export(record) {
    if (!this._endpoint) return;
    this._buffer.push(record);
    if (this._buffer.length > MAX_BUFFER_SIZE) {
      this._buffer.shift();
    }
    if (this._buffer.length >= FLUSH_SIZE) {
      this.flush();
    }
  }

  flush(callback) {
    if (typeof callback !== 'function') callback = () => {};
    if (this._buffer.length === 0) return callback(null, { flushed: 0 });
    const records = this._buffer.splice(0);
    const tracePayload = this._buildTracePayload(records);
    const metricPayload = this._buildMetricPayload(records);
    let pending = 2;
    let hadError = false;
    const done = (err) => {
      if (err && !hadError) {
        hadError = true;
        this._fallback(records);
      }
      pending--;
      if (pending === 0) callback(hadError ? new Error('OTLP flush partial failure') : null, { flushed: records.length });
    };
    this._post('/v1/traces', tracePayload, done);
    this._post('/v1/metrics', metricPayload, done);
  }
}

module.exports = { OTLPOtlpExporter };
