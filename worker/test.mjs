// Testes do Worker sem Wrangler nem rede: `node --test worker/test.mjs`.
//
// O `fetch` global é trocado por um falso que responde pelos alvos e pelo
// Resend, e o KV é um Map. O que se trava aqui é o contrato que importa:
// e-mail só na mudança de estado, e estado gravado só depois do e-mail.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { executar } from './src/index.js'

const API = 'https://predialab-api.escolaaplicar.com.br/saude'
const APP = 'https://predialab.escolaaplicar.com.br'

let respostas, emails, resendFalha

function kv (inicial) {
  const m = new Map(inicial ? [['estado', JSON.stringify(inicial)]] : [])
  return {
    m,
    async get (k, tipo) { const v = m.get(k); return v == null ? null : (tipo === 'json' ? JSON.parse(v) : v) },
    async put (k, v) { m.set(k, v) }
  }
}

const env = (estado) => ({
  ESTADO: kv(estado), RESEND_API_KEY: 're_x', ALERT_FROM: 'Monitor <noreply@x.br>', ALERT_TO: 'a@x.br, b@x.br'
})

beforeEach(() => {
  respostas = { [API]: () => new Response('{"ok":true}', { status: 200 }), [APP]: () => new Response('<html>', { status: 200 }) }
  emails = []
  resendFalha = false
  globalThis.fetch = async (url, opcoes = {}) => {
    if (url === 'https://api.resend.com/emails') {
      if (resendFalha) return new Response('quota', { status: 429 })
      emails.push(JSON.parse(opcoes.body))
      return new Response('{"id":"1"}', { status: 200 })
    }
    return respostas[url]()
  }
})

test('tudo no ar e sem mudança: nenhum e-mail, nenhuma gravação', async () => {
  const e = env({ api: { estado: 'up' }, app: { estado: 'up' } })
  const antes = e.ESTADO.m.get('estado')
  await executar(e, { espera: 0 })
  assert.equal(emails.length, 0)
  assert.equal(e.ESTADO.m.get('estado'), antes)
})

test('API em 503: um e-mail [CAÍDO] para os dois destinatários, estado vira down', async () => {
  respostas[API] = () => new Response('{"ok":false}', { status: 503 })
  const e = env()
  await executar(e, { espera: 0 })
  assert.equal(emails.length, 1)
  assert.match(emails[0].subject, /^\[CAÍDO\] PrediaLab API - HTTP 503$/)
  assert.deepEqual(emails[0].to, ['a@x.br', 'b@x.br'])
  assert.match(emails[0].text, /As 3 tentativa/)
  assert.equal(JSON.parse(e.ESTADO.m.get('estado')).api.estado, 'down')
})

test('200 com "ok": false conta como caído', async () => {
  respostas[API] = () => new Response('{"ok":false}', { status: 200 })
  await executar(env(), { espera: 0 })
  assert.match(emails[0].subject, /\[CAÍDO\]/)
})

test('sem resposta (erro de rede) conta como caído', async () => {
  respostas[API] = () => { throw new TypeError('fetch failed') }
  await executar(env(), { espera: 0 })
  assert.match(emails[0].subject, /sem resposta$/)
})

test('falha só na 1ª tentativa: não alerta', async () => {
  let n = 0
  respostas[API] = () => (++n === 1 ? new Response('', { status: 502 }) : new Response('{"ok":true}', { status: 200 }))
  await executar(env(), { espera: 0 })
  assert.equal(emails.length, 0)
})

test('volta: e-mail [OK] com a duração', async () => {
  const desde = new Date(Date.UTC(2026, 9, 4, 6, 51)).toISOString()
  const agora = Date.UTC(2026, 9, 4, 7, 34)
  await executar(env({ api: { estado: 'down', desde }, app: { estado: 'up', desde } }), { espera: 0, agora })
  assert.equal(emails.length, 1)
  assert.equal(emails[0].subject, '[OK] PrediaLab API voltou após 43min')
})

test('Resend falhou: estado NÃO é gravado, para a próxima execução tentar de novo', async () => {
  respostas[API] = () => new Response('', { status: 503 })
  resendFalha = true
  const e = env({ api: { estado: 'up' }, app: { estado: 'up' } })
  const antes = e.ESTADO.m.get('estado')
  await assert.rejects(executar(e, { espera: 0 }), /Resend recusou/)
  assert.equal(e.ESTADO.m.get('estado'), antes)
})
