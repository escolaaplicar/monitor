#!/usr/bin/env node
// Monitor de disponibilidade do PrediaLab.
//
// Roda no GitHub Actions a cada 5 minutos. Confere os dois endereços, compara
// com o estado da execução anterior e manda e-mail SÓ quando o estado muda.
//
// A explicação de cada decisão está no README.md desta pasta.

import fs from 'node:fs'
import path from 'node:path'
import { enviarEmail } from './smtp.mjs'

// ── Configuração ──────────────────────────────────────────────────────────

const ALVOS = [
  {
    id: 'api',
    nome: 'PrediaLab API',
    url: 'https://predialab-api.escolaaplicar.com.br/saude',
    // O /saude devolve 200 com {"ok":true} quando está inteiro e 503 com
    // {"ok":false, "verificacoes":{...}} quando alguma dependência caiu.
    // Conferido no ar e no código (backend/app/controllers/saude_controller.rb)
    // em 02/09/2026. Como ele já usa o status HTTP, "!= 200" basta — mas
    // olhamos o `ok` do corpo também, para o dia em que alguém mudar o
    // controller e devolver 200 com degradação dentro.
    olharCampoOk: true
  },
  {
    id: 'app',
    nome: 'PrediaLab App',
    url: 'https://predialab.escolaaplicar.com.br',
    // É uma página estática no Cloudflare Pages: não há JSON para inspecionar,
    // só o status.
    olharCampoOk: false
  }
]

// O /saude entrega o veredito (`ok` e o status HTTP) a qualquer um, e o
// DIAGNÓSTICO — qual dependência caiu e com que erro — só a quem manda o token.
// Sem o segredo cadastrado o monitor continua funcionando e continua acertando
// se caiu; o que ele perde é a parte do e-mail que diz o porquê.
const TOKEN_DO_SAUDE = (process.env.SAUDE_TOKEN ?? '').trim()

const TENTATIVAS = 3
const ESPERA_ENTRE_TENTATIVAS_MS = 20_000
const LIMITE_POR_REQUISICAO_MS = 10_000
const CARACTERES_DO_CORPO_NO_EMAIL = 500

const ARQUIVO_DE_ESTADO = process.env.ARQUIVO_DE_ESTADO ?? 'estado/estado.json'

// ── Verificação ───────────────────────────────────────────────────────────

/**
 * Uma requisição. Nunca lança: devolve sempre um retrato do que aconteceu,
 * porque "não consegui nem conectar" é um resultado tão informativo quanto
 * "respondeu 503" e os dois precisam caber no e-mail.
 */
async function tentar (url) {
  const inicio = Date.now()
  try {
    const resposta = await fetch(url, {
      signal: AbortSignal.timeout(LIMITE_POR_REQUISICAO_MS),
      redirect: 'follow',
      headers: {
        'user-agent': 'PrediaLab-Monitor/1.0 (GitHub Actions)',
        ...(TOKEN_DO_SAUDE ? { authorization: `Bearer ${TOKEN_DO_SAUDE}` } : {})
      }
    })
    const corpo = await resposta.text().catch(() => '')
    return {
      ok: resposta.ok,
      status: resposta.status,
      corpo,
      ms: Date.now() - inicio,
      erro: null
    }
  } catch (e) {
    // Timeout, DNS que não resolve, TLS recusado, conexão fechada. Do ponto de
    // vista de quem usa o sistema, tudo isso é a mesma coisa: não abriu.
    return {
      ok: false,
      status: null,
      corpo: '',
      ms: Date.now() - inicio,
      // O `fetch` do Node embrulha todo erro de rede como "TypeError: fetch
      // failed", que não diz nada. O código real (ENOTFOUND, ECONNREFUSED,
      // ECONNRESET, CERT_HAS_EXPIRED) vem em `cause` — e é a diferença entre
      // "o DNS caiu" e "o servidor recusou a conexão".
      erro: e.name === 'TimeoutError'
        ? `sem resposta em ${LIMITE_POR_REQUISICAO_MS / 1000}s`
        : `${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}${e.cause?.message && !e.cause.code ? ` (${e.cause.message})` : ''}`
    }
  }
}

/**
 * Decide se o alvo está de pé, com as três tentativas espaçadas.
 *
 * Para na primeira que der certo: se respondeu, está no ar, e esperar mais 40
 * segundos para confirmar só atrasaria o próximo alvo. As três só acontecem
 * inteiras quando de fato há problema — que é quando vale a pena ter certeza.
 */
async function verificar (alvo) {
  const tentativas = []

  for (let n = 1; n <= TENTATIVAS; n++) {
    if (n > 1) await dormir(ESPERA_ENTRE_TENTATIVAS_MS)

    const r = await tentar(alvo.url)
    let saudavel = r.ok

    // O corpo só é consultado quando o status já disse que está tudo bem. Um
    // 503 é queda mesmo que o JSON venha ilegível.
    if (saudavel && alvo.olharCampoOk) {
      try {
        if (JSON.parse(r.corpo)?.ok === false) {
          saudavel = false
          r.erro = 'HTTP 200, mas o corpo trouxe "ok": false'
        }
      } catch {
        // Corpo que não é JSON numa rota que deveria devolver JSON é sintoma:
        // costuma ser página de erro de um intermediário (Cloudflare, Railway)
        // no lugar da resposta da aplicação.
        saudavel = false
        r.erro = 'HTTP 200, mas o corpo não é o JSON esperado'
      }
    }

    tentativas.push({ ...r, saudavel, numero: n })
    if (saudavel) break
  }

  return {
    saudavel: tentativas.some((t) => t.saudavel),
    tentativas,
    ultima: tentativas[tentativas.length - 1]
  }
}

// ── Estado entre execuções ────────────────────────────────────────────────

function lerEstado () {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_DE_ESTADO, 'utf8'))
  } catch {
    // Primeira execução, ou branch de estado recém-criada. Assumir "no ar" é a
    // escolha certa: assumir "caído" mandaria um e-mail de recuperação falso na
    // primeira vez que rodasse.
    return {}
  }
}

function gravarEstado (estado) {
  fs.mkdirSync(path.dirname(ARQUIVO_DE_ESTADO), { recursive: true })
  fs.writeFileSync(ARQUIVO_DE_ESTADO, `${JSON.stringify(estado, null, 2)}\n`)
}

// ── E-mail ────────────────────────────────────────────────────────────────

function montarAssunto (alvo, resultado, anterior) {
  if (!resultado.saudavel) {
    const u = resultado.ultima
    const motivo = u.status ? `HTTP ${u.status}` : 'sem resposta'
    return `[CAÍDO] ${alvo.nome} - ${motivo}`
  }
  return `[OK] ${alvo.nome} voltou após ${duracaoDesde(anterior?.desde)}`
}

function montarCorpo (alvo, resultado, anterior, forcado = false) {
  const linhas = []

  if (forcado) {
    linhas.push('*** ESTE É UM TESTE. A falha foi forçada de propósito pelo')
    linhas.push('*** botão "Run workflow", e não reflete o estado real do sistema.')
    linhas.push('')
  }

  linhas.push(resultado.saudavel
    ? `${alvo.nome} voltou a responder.`
    : `${alvo.nome} não está respondendo.`)
  linhas.push('')
  linhas.push(`URL:      ${alvo.url}`)
  linhas.push(`Quando:   ${agoraEmSaoPaulo()}`)

  if (resultado.saudavel && anterior?.desde) {
    linhas.push(`Ficou fora: ${duracaoDesde(anterior.desde)} (desde ${emSaoPaulo(anterior.desde)})`)
  }

  const u = resultado.ultima
  linhas.push(`Status:   ${u.status ?? '— não houve resposta —'}`)
  if (u.erro) linhas.push(`Erro:     ${u.erro}`)

  linhas.push('')
  linhas.push(`As ${resultado.tentativas.length} tentativa(s):`)
  for (const t of resultado.tentativas) {
    const veredito = t.saudavel ? 'ok' : (t.status ? `HTTP ${t.status}` : t.erro)
    linhas.push(`  ${t.numero}. ${String(t.ms).padStart(5)}ms  ${veredito}`)
  }

  if (u.corpo) {
    linhas.push('')
    // Condição baseada no conteúdo, e não numa propriedade do alvo: no modo de
    // teste o alvo é substituído, e uma condição sobre ele deixaria justamente
    // o teste sem exercitar este aviso.
    if (!TOKEN_DO_SAUDE && u.corpo.includes('"ok"') && !u.corpo.includes('verificacoes')) {
      linhas.push('(O diagnóstico detalhado exige o segredo SAUDE_TOKEN, que não')
      linhas.push(' está cadastrado neste repositório. Ver o README.)')
      linhas.push('')
    }
    linhas.push(`Primeiros ${CARACTERES_DO_CORPO_NO_EMAIL} caracteres da resposta:`)
    linhas.push('─'.repeat(60))
    linhas.push(u.corpo.slice(0, CARACTERES_DO_CORPO_NO_EMAIL))
    linhas.push('─'.repeat(60))
  }

  linhas.push('')
  linhas.push('Enviado pelo monitor em .github/workflows/monitor.yml')
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID) {
    linhas.push(`Execução: ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`)
  }

  return linhas.join('\n')
}

// ── Programa ──────────────────────────────────────────────────────────────

async function principal () {
  const forcarFalha = (process.env.FORCAR_FALHA ?? 'nenhum').trim()
  const urlDeTeste = (process.env.URL_DE_TESTE ?? '').trim()

  const estado = lerEstado()
  const mudancas = []

  for (const alvoOriginal of ALVOS) {
    const forcado = forcarFalha === 'ambos' || forcarFalha === alvoOriginal.id
    const alvo = forcado
      ? { ...alvoOriginal, url: urlDeTeste || URL_QUE_NAO_EXISTE, olharCampoOk: false }
      : alvoOriginal

    if (forcado) console.log(`⚠️  ${alvo.nome}: falha FORÇADA para teste, apontando para ${alvo.url}`)

    const resultado = await verificar(alvo)
    const agora = resultado.saudavel ? 'up' : 'down'
    const anterior = estado[alvo.id]
    const antes = anterior?.estado ?? 'up'

    console.log(`${agora === 'up' ? '✅' : '❌'} ${alvo.nome}: ${agora} (antes: ${antes})` +
      `  ${resultado.tentativas.map((t) => t.status ?? 'x').join(' ')}`)

    if (agora !== antes) {
      // `alvo`, e não `alvoOriginal`: numa falha forçada o e-mail precisa dizer
      // qual endereço foi de fato consultado. Mostrar o de produção faria o
      // teste parecer um alerta verdadeiro.
      mudancas.push({ alvo, forcado, resultado, anterior })
    }

    estado[alvo.id] = {
      estado: agora,
      // `desde` só se move quando o estado muda: é ele que mede quanto tempo
      // ficou fora. Regravá-lo a cada execução zeraria a conta.
      desde: agora === antes ? (anterior?.desde ?? new Date().toISOString()) : new Date().toISOString(),
      ultima_verificacao: new Date().toISOString()
    }
  }

  if (mudancas.length === 0) {
    console.log('Nenhuma mudança de estado — nada a enviar.')
    return
  }

  // ── A ordem aqui é deliberada: e-mail primeiro, estado depois ──
  //
  // Se gravássemos o estado antes de enviar e o envio falhasse, o arquivo
  // diria "caído", a próxima execução não veria mudança nenhuma, e o alerta
  // estaria perdido para sempre — silêncio exatamente no caso em que o sistema
  // está fora do ar. Enviando primeiro, uma falha de e-mail deixa o estado
  // antigo no lugar e a execução seguinte tenta de novo.
  // Retrato da credencial que não expõe a credencial. O 535 do Google não
  // distingue "senha errada" de "senha do tipo errado", e sem isto a
  // investigação vira tentativa e erro às cegas. O comprimento basta: uma senha
  // de aplicativo tem exatamente 16 caracteres depois de tirados os espaços;
  // qualquer outro número é quase certamente a senha normal da conta.
  const senhaLimpa = exigir('SMTP_PASS').replace(/\s+/g, '')
  const usuario = exigir('SMTP_USER').trim()
  console.log(`SMTP: usuário em @${usuario.split('@')[1] ?? '(sem domínio!)'}, ` +
    `senha de ${senhaLimpa.length} caracteres ` +
    `${senhaLimpa.length === 16 ? '(formato de senha de aplicativo)' : '(NÃO tem os 16 caracteres de uma senha de aplicativo)'}`)

  for (const { alvo, forcado, resultado, anterior } of mudancas) {
    const assunto = montarAssunto(alvo, resultado, anterior)
    console.log(`Enviando: ${assunto}`)
    await enviarEmail({
      // Fixos no Gmail em produção. As duas variáveis existem para poder
      // apontar a um servidor de teste local sem tocar no código — é como a
      // conversa SMTP inteira foi verificada antes de ir para o ar.
      // `||`, e nunca `??`: uma variavel declarada no workflow e nao definida no
      // repositorio chega como string VAZIA, e `??` so cai no padrao quando o
      // valor e ausente. Com `??`, o monitor tentava conectar em host "" e
      // porta 0 e morria em 60ms sem nunca falar com o Gmail.
      host: process.env.SMTP_HOST?.trim() || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT?.trim() || 587),
      user: exigir('SMTP_USER'),
      pass: exigir('SMTP_PASS'),
      from: exigir('SMTP_USER'),
      to: exigir('ALERT_TO'),
      subject: forcado ? `${assunto} [TESTE]` : assunto,
      text: montarCorpo(alvo, resultado, anterior, forcado)
    })
    console.log('  enviado.')
  }

  gravarEstado(estado)
  console.log(`Estado gravado em ${ARQUIVO_DE_ESTADO}.`)
}

// ── Utilidades ────────────────────────────────────────────────────────────

// Subdomínio que não existe na zona: o DNS não resolve e a falha é imediata e
// inequívoca, sem depender de nenhum serviço de terceiro estar no ar.
const URL_QUE_NAO_EXISTE = 'https://forcado-para-teste-do-monitor.escolaaplicar.com.br/'

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

function exigir (nome) {
  const v = process.env[nome]
  if (!v) throw new Error(`Falta o secret ${nome}. Ver README.md.`)
  return v
}

const formatador = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium'
})
const emSaoPaulo = (iso) => `${formatador.format(new Date(iso))} (horário de Brasília)`
const agoraEmSaoPaulo = () => emSaoPaulo(new Date().toISOString())

function duracaoDesde (iso) {
  if (!iso) return 'tempo desconhecido'
  const minutos = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutos < 60) return `${minutos}min`
  const horas = Math.floor(minutos / 60)
  const resto = minutos % 60
  if (horas < 24) return resto ? `${horas}h${String(resto).padStart(2, '0')}` : `${horas}h`
  return `${Math.floor(horas / 24)}d${horas % 24}h`
}

principal().catch((e) => {
  // Falha visível, e não engolida: o job fica vermelho no GitHub e a mensagem
  // aparece no log. Vale tanto para o e-mail que não saiu quanto para um
  // secret ausente.
  // Nem todo erro que chega aqui e um Error com mensagem util: um socket que
  // morre no aperto de mao pode trazer so um `code`. Imprimir a mensagem vazia
  // transformava a falha visivel numa linha "FALHOU:" sem nada depois, que e
  // pior do que nao ter erro nenhum -- parece defeito do log, nao do envio.
  console.error(`\nFALHOU: ${e?.message || e?.code || String(e)}`)
  if (e?.cause) console.error(`Causa: ${e.cause.message ?? e.cause}`)
  process.exit(1)
})
