'use strict';

const http = require('http');
const https = require('https');

const ACTION_MAP = {
  critical: (id) => `Stop rollout, inspect ${id}`,
  high: (id) => `Investigate ${id} and consider rollback`,
};

function evaluateSLOAlerts(dashboard) {
  if (!dashboard || !Array.isArray(dashboard.checks)) return [];
  return dashboard.checks
    .filter(c => !c.passed)
    .map(c => ({
      severity: c.severity || 'high',
      checkId: c.id || 'unknown',
      actual: c.actual,
      expected: c.expected,
      message: `${c.id || 'unknown'} failed: actual=${c.actual}, expected=${c.expected}`,
      action: (ACTION_MAP[c.severity] || ACTION_MAP.high)(c.id || 'unknown'),
    }));
}

function formatAlertSignals(signals, options = {}) {
  const health = signals.length === 0 ? 'healthy' : 'unhealthy';
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    health,
    signals,
    webhookDispatched: false,
  };
  if (signals.length > 0 && options.sloAlertWebhook) {
    _dispatchWebhook(options.sloAlertWebhook, result, options);
    result.webhookDispatched = true;
  }
  return result;
}

function _dispatchWebhook(urlStr, payload, options = {}) {
  let url;
  try {
    url = new URL(urlStr);
  } catch (_) { return; }
  const transport = url.protocol === 'https:' ? https : http;
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (options.sloAlertWebhookToken) {
    headers['Authorization'] = `Bearer ${options.sloAlertWebhookToken}`;
  }
  const req = transport.request({
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers,
    timeout: 5000,
  }, () => {});
  req.on('error', () => {});
  req.on('timeout', () => { req.destroy(); });
  req.write(body);
  req.end();
}

module.exports = { evaluateSLOAlerts, formatAlertSignals };
