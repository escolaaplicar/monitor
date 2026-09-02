// Cliente SMTP mínimo, sem dependências.
//
// ── Por que não nodemailer ──
//
// Este script roda a cada 5 minutos, num runner limpo. Uma dependência externa
// significa `npm install` a cada execução — rede, tempo, e um terceiro no
// caminho de um alerta cuja razão de existir é funcionar quando outras coisas
// não funcionam. O que precisamos do SMTP aqui é a sequência mínima
// (EHLO, STARTTLS, AUTH LOGIN, MAIL, RCPT, DATA), que cabe neste arquivo.
//
// ── O que ele NÃO faz ──
//
// Anexos, HTML, múltiplos destinatários com falha parcial, pool de conexões.
// Se um dia precisar disso, troque por nodemailer sem dó — a interface aqui é
// uma função só.

import net from 'node:net'
import tls from 'node:tls'

// Sem isto, um servidor que aceita a conexão e nunca responde deixa o job
// pendurado até o teto do GitHub (6 h). O alerta que não chega em 30 s já é um
// alerta atrasado.
const LIMITE_MS = 30_000

/**
 * Conversa uma sessão SMTP inteira e devolve quando a mensagem foi aceita.
 * Rejeita — nunca engole — em qualquer resposta fora do esperado.
 */
export async function enviarEmail ({ host, port, user, pass, from, to, subject, text }) {
  let socket = net.createConnection({ host, port })
  socket.setTimeout(LIMITE_MS)

  const conversa = criarConversa(socket)

  try {
    await conversa.esperar(220, 'saudação do servidor')

    await conversa.mandar(`EHLO ${nomeLocal(from)}`, 250, 'EHLO inicial')

    // O Gmail na 587 exige STARTTLS: a conexão nasce em texto puro e é
    // promovida a criptografada antes de qualquer senha trafegar. Mandar AUTH
    // antes disto entrega a senha em claro — e o Gmail recusa, corretamente.
    await conversa.mandar('STARTTLS', 220, 'pedido de STARTTLS')

    socket = await promoverParaTls(socket, host)
    socket.setTimeout(LIMITE_MS)
    conversa.trocarSocket(socket)

    // O EHLO tem que ser repetido depois do TLS: as extensões anunciadas antes
    // não valem mais, e AUTH normalmente só aparece na segunda rodada.
    await conversa.mandar(`EHLO ${nomeLocal(from)}`, 250, 'EHLO após TLS')

    await conversa.mandar('AUTH LOGIN', 334, 'início da autenticação')
    await conversa.mandar(base64(user.trim()), 334, 'usuário')
    // O Google mostra a senha de aplicativo em quatro blocos de quatro letras
    // ("abcd efgh ijkl mnop"), e é assim que ela costuma ser copiada. Os espaços
    // são só apresentação: a senha real são as 16 letras. Mandá-los junto rende
    // um 535 "Username and Password not accepted" idêntico ao de senha errada,
    // que manda a pessoa procurar o problema no lugar errado. Como este cliente
    // só fala com o Gmail, tirar todo espaço em branco é seguro aqui.
    await conversa.mandar(base64(pass.replace(/\s+/g, '')), 235, 'senha')

    await conversa.mandar(`MAIL FROM:<${from}>`, 250, 'remetente')
    for (const destinatario of listaDe(to)) {
      await conversa.mandar(`RCPT TO:<${destinatario}>`, 250, `destinatário ${destinatario}`)
    }

    await conversa.mandar('DATA', 354, 'abertura do corpo')
    await conversa.mandar(montarMensagem({ from, to, subject, text }), 250, 'corpo da mensagem')

    // QUIT pode falhar sem que isso invalide o envio: a mensagem já foi aceita
    // no passo anterior. Por isso ele fica fora do try que decide sucesso.
    await conversa.mandar('QUIT', 221, 'encerramento').catch(() => {})
  } finally {
    socket.destroy()
  }
}

/** Mantém o estado da leitura, que muda de socket no meio (antes e depois do TLS). */
function criarConversa (socketInicial) {
  let socket = socketInicial
  let buffer = ''
  let pendente = null

  const aoReceber = (pedaco) => {
    buffer += pedaco.toString('utf8')
    // Resposta SMTP pode ter várias linhas: `250-EXTENSAO` continua, `250 FIM`
    // termina. Ler só o primeiro pedaço que chegou deixaria o resto no buffer e
    // desalinharia todos os comandos seguintes.
    const linhas = buffer.split(/\r?\n/)
    const ultimaFechada = linhas.length >= 2 ? linhas[linhas.length - 2] : null
    const completa = ultimaFechada !== null && /^\d{3} /.test(ultimaFechada)
    if (completa && pendente) {
      const resposta = buffer
      buffer = ''
      const { resolver } = pendente
      pendente = null
      resolver(resposta)
    }
  }

  const aoFalhar = (erro) => {
    if (pendente) { const { rejeitar } = pendente; pendente = null; rejeitar(erro) }
  }

  const ligar = (s) => {
    s.on('data', aoReceber)
    s.on('error', aoFalhar)
    s.on('timeout', () => aoFalhar(new Error(`SMTP sem resposta em ${LIMITE_MS / 1000}s`)))
    s.on('close', () => aoFalhar(new Error('SMTP fechou a conexão no meio da sessão')))
  }
  ligar(socket)

  const ler = () => new Promise((resolver, rejeitar) => { pendente = { resolver, rejeitar } })

  return {
    trocarSocket (novo) { socket = novo; buffer = ''; ligar(novo) },

    async esperar (esperado, oQue) {
      const resposta = await ler()
      conferir(resposta, esperado, oQue)
      return resposta
    },

    async mandar (comando, esperado, oQue) {
      const espera = ler()
      // DATA é o único comando cujo conteúdo já vem com o terminador próprio.
      socket.write(comando.endsWith('\r\n.\r\n') ? comando : `${comando}\r\n`)
      const resposta = await espera
      conferir(resposta, esperado, oQue)
      return resposta
    }
  }
}

function conferir (resposta, esperado, oQue) {
  // Numa resposta de várias linhas, quem traz o veredito é a última: as
  // anteriores vêm com hífen (`250-EXTENSAO`) e são só o catálogo de extensões.
  const linhas = resposta.trim().split(/\r?\n/)
  const codigo = Number.parseInt(linhas[linhas.length - 1].slice(0, 3), 10)
  if (codigo !== esperado) {
    // A resposta inteira entra no erro: o Gmail explica a recusa nela
    // ("Username and Password not accepted", "Application-specific password
    // required"), e sem isso alguém abriria o log para descobrir só o número.
    // O 535 tem três causas comuns e indistinguíveis pela resposta do Google.
    // Listá-las aqui evita que alguém troque a senha três vezes antes de
    // descobrir que o problema era a conta.
    const dica = codigo === 535
      ? '\n\nO Google recusou a credencial. As três causas, em ordem de frequência:' +
        '\n  1. SMTP_PASS não é uma senha de aplicativo, e sim a senha normal da conta.' +
        '\n     A senha normal nunca funciona por SMTP; é preciso gerar uma em' +
        '\n     https://myaccount.google.com/apppasswords (exige verificação em duas etapas).' +
        '\n  2. SMTP_USER não é a MESMA conta que gerou a senha de aplicativo.' +
        '\n  3. O administrador do Workspace bloqueou senhas de aplicativo no domínio.'
      : ''
    throw new Error(`SMTP recusou ${oQue}: esperado ${esperado}, veio ${codigo}. Resposta: ${resposta.trim()}${dica}`)
  }
}

function promoverParaTls (socket, host) {
  return new Promise((resolver, rejeitar) => {
    socket.removeAllListeners('data')
    socket.removeAllListeners('error')
    socket.removeAllListeners('close')
    socket.removeAllListeners('timeout')
    const seguro = tls.connect({ socket, servername: host }, () => resolver(seguro))
    seguro.once('error', rejeitar)
  })
}

/**
 * Monta a mensagem RFC 5322.
 *
 * O corpo vai em base64 de propósito, e não em texto puro: o assunto e o corpo
 * têm acento ("[CAÍDO]", "após"), e o corpo carrega a resposta do servidor, que
 * pode conter qualquer coisa — inclusive uma linha começando com ponto, que em
 * SMTP significaria "acabou a mensagem aqui". Base64 elimina os dois riscos.
 */
function montarMensagem ({ from, to, subject, text }) {
  const cabecalhos = [
    `From: PrediaLab Monitor <${from}>`,
    `To: ${listaDe(to).join(', ')}`,
    `Subject: ${assuntoCodificado(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ]
  const corpo = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
  return `${cabecalhos.join('\r\n')}\r\n\r\n${corpo}\r\n.\r\n`
}

// Cabeçalho de e-mail é ASCII. Acento no assunto precisa da codificação do
// RFC 2047, senão chega como "[CAÃDO]" em boa parte dos leitores.
const assuntoCodificado = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`

const base64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const listaDe = (to) => String(to).split(',').map((e) => e.trim()).filter(Boolean)
const nomeLocal = (from) => from.split('@')[1] ?? 'localhost'
