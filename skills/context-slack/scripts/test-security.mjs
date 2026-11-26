#!/usr/bin/env node
/**
 * context-slack — testes de seguranca (redacao de credenciais e YAML seguro).
 *
 * Executa sem dependencias externas (assert nativo do Node).
 *   node scripts/test-security.mjs
 */

import assert from 'node:assert/strict'
import {
  redactSecrets as redactAudit,
  parseYaml,
} from './audit.mjs'
import { redactSecrets as redactCompact } from './compact.mjs'

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`ok  - ${name}`)
  } catch (e) {
    failures += 1
    console.log(`not ok - ${name}: ${e.message}`)
  }
}

// ── Redacao de credenciais (audit.mjs) ──
check('redige chave privada RSA/PKCS8', () => {
  const out = redactAudit('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----', {})
  assert.ok(out.includes('[REDACTED:private-key]'))
  assert.ok(!out.includes('AAAA'))
})
check('redige chave privada com algoritmo', () => {
  const out = redactAudit('-----BEGIN RSA PRIVATE KEY-----\nBBBB\n-----END RSA PRIVATE KEY-----', {})
  assert.ok(out.includes('[REDACTED:private-key]'))
})
check('redige token GitHub (ghp_)', () => {
  const out = redactAudit('token ghp_1234567890abcdef1234567890abcdef12345678 aqui', {})
  assert.ok(out.includes('[REDACTED:github-token]'))
  assert.ok(!out.includes('ghp_1234'))
})
check('redige token GitHub (gho, ghu, ghs, ghr)', () => {
  for (const prefix of ['gho', 'ghu', 'ghs', 'ghr']) {
    const out = redactAudit(`x ${prefix}_1234567890abcdef1234567890abcdef12345678 y`, {})
    assert.ok(out.includes('[REDACTED:github-token]'), `falhou para ${prefix}`)
  }
})
check('redige chave OpenAI sk-', () => {
  const out = redactAudit('chave sk-1234567890abcdef1234567890abcdef1234567890ab', {})
  assert.ok(out.includes('[REDACTED:api-key]'))
})
check('redige JWT', () => {
  const out = redactAudit('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.abcdefgh12345678', {})
  assert.ok(out.includes('[REDACTED:jwt]'))
})
check('redige Authorization Bearer', () => {
  const out = redactAudit('Authorization: Bearer ABCDEFGHIJKLMNOP1234567890', {})
  assert.ok(out.includes('[REDACTED:auth-header]'))
})
check('redige credenciais em URL', () => {
  const out = redactAudit('https://usuario:senha@exemplo.com/path', {})
  assert.ok(out.includes('[REDACTED:credentials-in-url]@'))
  assert.ok(!out.includes('usuario:senha@'))
})
check('nao redige quando redact_secrets=false', () => {
  const segredo = 'ghp_1234567890abcdef1234567890abcdef12345678'
  const out = redactAudit(segredo, { redact_secrets: false })
  assert.ok(out.includes(segredo))
})

// ── Mesmo conjunto no compact.mjs ──
check('compact: redige token GitHub', () => {
  const out = redactCompact('ghp_1234567890abcdef1234567890abcdef12345678', {})
  assert.ok(out.includes('[REDACTED:github-token]'))
})
check('compact: redige chave privada', () => {
  const out = redactCompact('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----', {})
  assert.ok(out.includes('[REDACTED:private-key]'))
})

// ── parseYaml seguro (bloqueia prototipo) ──
check('parseYaml bloqueia __proto__', () => {
  const out = parseYaml('__proto__\n  polluted: true\n')
  assert.ok(!('polluted' in out))
})
check('parseYaml bloqueia constructor', () => {
  const out = parseYaml('constructor\n  prototype: { polluted: true }\n')
  assert.ok(!('polluted' in out))
})
check('parseYaml parse mapa normal', () => {
  const out = parseYaml('audit_warn: 0.65\nredact_secrets: true\n')
  assert.strictEqual(out.audit_warn, 0.65)
  assert.strictEqual(out.redact_secrets, true)
})

console.log(`\n${failures === 0 ? 'Todos os testes passaram' : failures + ' falha(s)'}`)
process.exitCode = failures === 0 ? 0 : 1
