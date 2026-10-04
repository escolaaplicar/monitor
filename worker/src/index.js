// Monitor de disponibilidade do PrediaLab, como Cloudflare Worker.
//
// ── Por que saiu do GitHub Actions ──
//
// O workflow pede `*/5 * * * *`, mas o GitHub trata o `schedule` como "quando
// der": entre 28/09 e 04/10/2026 ele rodou UMA vez a cada 4 a 6 horas. Na
// queda do Redis de 04/10 (43 minutos) o alerta só saiu porque, por sorte, uma
// dessas execuções caiu dentro da janela. O Cron Trigger da Cloudflare dispara
// no minuto pedido.
//
// Continua externo ao que vigia: a API está no Railway, e o app no Cloudflare
// Pages. Se a Cloudflare inteira cair, o app cai junto com o monitor — mas aí
// a queda é pública e não precisa de e-mail para ser notada.
//
// A lógica é a mesma do verificar.mjs; as diferenças são de plataforma:
// estado no KV em vez de numa branch, e e-mail pela API HTTP do Resend em vez
// de SMTP (Worker não fala SMTP sem reimplementar o protocolo em socket cru).

export const ALVOS = [
  {
    id: 'api',
    nome: 'PrediaLab API',
    url: 'https://predialab-api.escolaaplicar.com.br/saude',
    // 200 com {"ok":true} quando inteiro; 503 com {"ok":false} quando alguma
    // dependência caiu. O corpo é conferido também, para o dia em que alguém
    // devolver 200 com degradação dentro.
    olharCampoOk: true
  },
  {
    id: 'app',
    nome: 'PrediaLab App',
    url: 'https://predialab.escolaaplicar.com.br',
    olharCampoOk: false
  }
]

const TENTATIVAS = 3
const ESPERA_ENTRE_TENTATIVAS_MS = 20_000
const LIMITE_POR_REQUISICAO_MS = 10_000
const CARACTERES_DO_CORPO_NO_EMAIL = 500
const CHAVE_DO_ESTADO = 'estado'

/**
 * Uma requisição. Nunca lança: "não conectou" é resultado tão informativo
 * quanto "respondeu 503", e os dois precisam caber no e-mail.
 */
async function tentar (url, token) {
  const inicio = Date.now()
  try {
    const resposta = await fetch(url, {
      signal: AbortSignal.timeout(LIMITE_POR_REQUISICAO_MS),
      redirect: 'follow',
      headers: {
        'user-agent': 'PrediaLab-Monitor/2.0 (Cloudflare Worker)',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    })
    const corpo = await resposta.text().catch(() => '')
    return { ok: resposta.ok, status: resposta.status, corpo, ms: Date.now() - inicio, erro: null }
  } catch (e) {
    return {
      ok: false,
      status: null,
      corpo: '',
      ms: Date.now() - inicio,
      erro: e.name === 'TimeoutError' ? `sem resposta em ${LIMITE_POR_REQUISICAO_MS / 1000}s` : String(e.message || e)
    }
  }
}

/** Até três tentativas espaçadas; para na primeira que der certo. */
export async function verificar (alvo, { token, espera = ESPERA_ENTRE_TENTATIVAS_MS } = {}) {
  const tentativas = []

  for (let n = 1; n <= TENTATIVAS; n++) {
    if (n > 1) await new Promise((r) => setTimeout(r, espera))

    const r = await tentar(alvo.url, token)
    let saudavel = r.ok

    if (saudavel && alvo.olharCampoOk) {
      try {
        if (JSON.parse(r.corpo)?.ok === false) {
          saudavel = false
          r.erro = 'HTTP 200, mas o corpo trouxe "ok": false'
        }
      } catch {
        // Corpo que não é JSON costuma ser página de erro de um intermediário
        // (Cloudflare, Railway) no lugar da resposta da aplicação.
        saudavel = false
        r.erro = 'HTTP 200, mas o corpo não é o JSON esperado'
      }
    }

    tentativas.push({ ...r, saudavel, numero: n })
    if (saudavel) break
  }

  return { saudavel: tentativas.some((t) => t.saudavel), tentativas, ultima: tentativas[tentativas.length - 1] }
}

// ── E-mail ────────────────────────────────────────────────────────────────

const formatador = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium'
})
const emSaoPaulo = (iso) => `${formatador.format(new Date(iso))} (horário de Brasília)`

function duracaoDesde (iso, agora) {
  if (!iso) return 'tempo desconhecido'
  const minutos = Math.round((agora - new Date(iso).getTime()) / 60_000)
  if (minutos < 60) return `${minutos}min`
  const horas = Math.floor(minutos / 60)
  const resto = minutos % 60
  if (horas < 24) return resto ? `${horas}h${String(resto).padStart(2, '0')}` : `${horas}h`
  return `${Math.floor(horas / 24)}d${horas % 24}h`
}

export function montarEmail (alvo, resultado, anterior, agora, temToken) {
  const u = resultado.ultima
  const assunto = resultado.saudavel
    ? `[OK] ${alvo.nome} voltou após ${duracaoDesde(anterior?.desde, agora)}`
    : `[CAÍDO] ${alvo.nome} - ${u.status ? `HTTP ${u.status}` : 'sem resposta'}`

  const linhas = [
    resultado.saudavel ? `${alvo.nome} voltou a responder.` : `${alvo.nome} não está respondendo.`,
    '',
    `URL:      ${alvo.url}`,
    `Quando:   ${emSaoPaulo(new Date(agora).toISOString())}`
  ]
  if (resultado.saudavel && anterior?.desde) {
    linhas.push(`Ficou fora: ${duracaoDesde(anterior.desde, agora)} (desde ${emSaoPaulo(anterior.desde)})`)
  }
  linhas.push(`Status:   ${u.status ?? '— não houve resposta —'}`)
  if (u.erro) linhas.push(`Erro:     ${u.erro}`)
  linhas.push('', `As ${resultado.tentativas.length} tentativa(s):`)
  for (const t of resultado.tentativas) {
    const veredito = t.saudavel ? 'ok' : (t.status ? `HTTP ${t.status}` : t.erro)
    linhas.push(`  ${t.numero}. ${String(t.ms).padStart(5)}ms  ${veredito}`)
  }
  if (u.corpo) {
    linhas.push('')
    if (!temToken && u.corpo.includes('"ok"') && !u.corpo.includes('verificacoes')) {
      linhas.push('(O diagnóstico detalhado exige o segredo SAUDE_TOKEN neste Worker.)', '')
    }
    linhas.push(`Primeiros ${CARACTERES_DO_CORPO_NO_EMAIL} caracteres da resposta:`, '─'.repeat(60),
      u.corpo.slice(0, CARACTERES_DO_CORPO_NO_EMAIL), '─'.repeat(60))
  }
  linhas.push('', 'Enviado pelo Worker predialab-monitor (repositório escolaaplicar/monitor, pasta worker/).')

  return { assunto, texto: linhas.join('\n') }
}

async function enviarEmail (env, { assunto, texto }) {
  for (const nome of ['RESEND_API_KEY', 'ALERT_FROM', 'ALERT_TO']) {
    if (!env[nome]) throw new Error(`Falta ${nome}. Ver worker/README.md.`)
  }
  const resposta = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.ALERT_FROM,
      // Vários destinatários separados por vírgula, como no ALERT_TO do workflow.
      to: env.ALERT_TO.split(',').map((s) => s.trim()).filter(Boolean),
      subject: assunto,
      text: texto
    })
  })
  if (!resposta.ok) {
    throw new Error(`Resend recusou o e-mail: HTTP ${resposta.status} ${(await resposta.text()).slice(0, 300)}`)
  }
}

// ── Execução ──────────────────────────────────────────────────────────────

export async function executar (env, { agora = Date.now(), espera } = {}) {
  const token = (env.SAUDE_TOKEN ?? '').trim()
  const estado = (await env.ESTADO.get(CHAVE_DO_ESTADO, 'json')) ?? {}
  const novo = { ...estado }
  const mudancas = []

  // Em paralelo: um alvo caído leva ~40s nas três tentativas, e não há razão
  // para o outro esperar por ele.
  const resultados = await Promise.all(ALVOS.map((alvo) => verificar(alvo, { token, espera })))

  ALVOS.forEach((alvo, i) => {
    const resultado = resultados[i]
    const atual = resultado.saudavel ? 'up' : 'down'
    const anterior = estado[alvo.id]
    // Sem estado anterior, assume "no ar": assumir "caído" mandaria um e-mail
    // de recuperação falso na primeira execução.
    const antes = anterior?.estado ?? 'up'

    console.log(`${atual === 'up' ? 'OK' : 'CAIDO'} ${alvo.nome} (antes: ${antes}) ` +
      resultado.tentativas.map((t) => t.status ?? 'x').join(' '))

    if (atual !== antes) mudancas.push({ alvo, resultado, anterior })
    novo[alvo.id] = {
      estado: atual,
      desde: atual === antes ? (anterior?.desde ?? new Date(agora).toISOString()) : new Date(agora).toISOString()
    }
  })

  if (mudancas.length === 0) return { mudancas: 0 }

  // E-mail primeiro, estado depois. Se o envio falhar, o estado antigo fica e
  // a próxima execução tenta de novo; o contrário perderia o alerta para
  // sempre — silêncio justamente com o sistema fora do ar.
  //
  // Por isso também o KV só é gravado quando algo muda: a cota gratuita é de
  // 1.000 gravações por dia, e gravar a cada 5 minutos gastaria 288 delas à toa.
  for (const { alvo, resultado, anterior } of mudancas) {
    await enviarEmail(env, montarEmail(alvo, resultado, anterior, agora, Boolean(token)))
  }
  await env.ESTADO.put(CHAVE_DO_ESTADO, JSON.stringify(novo))
  return { mudancas: mudancas.length }
}

export default {
  async scheduled (_evento, env, ctx) {
    ctx.waitUntil(executar(env))
  }
}
