# Monitor de disponibilidade do PrediaLab

Confere, a cada 5 minutos, se os dois endereços públicos do PrediaLab estão no
ar. Manda e-mail quando cai e quando volta — **e só nessas duas horas**, nunca a
cada verificação.

| o que ele olha | endereço |
|---|---|
| API | `https://predialab-api.escolaaplicar.com.br/saude` |
| App | `https://predialab.escolaaplicar.com.br` |

## Por que este repositório é separado do PrediaLab

**Porque ele precisa ser externo ao que vigia.** Um monitor hospedado na mesma
infraestrutura do sistema cai junto com ele, e fica em silêncio exatamente
quando deveria falar.

**E porque repositório privado paga minutos de Actions.** A cada 5 minutos são
288 execuções por dia, e o GitHub arredonda cada uma para 1 minuto cheio: cerca
de 8.640 minutos/mês contra 2.000 de cota gratuita — algo como US$ 53/mês, e
ainda dividindo a cota com o CI do projeto. Repositório público tem minutos
ilimitados.

**Ele pode ser público sem expor nada.** Não há aqui uma linha do produto: o
monitor só sabe abrir dois endereços que qualquer pessoa já acessa pelo
navegador. As credenciais de e-mail ficam em GitHub Secrets, que são privados
mesmo num repositório público.

---

## Para ligar: três passos

Enquanto os três segredos não estiverem cadastrados, o monitor roda, detecta
tudo certinho e **falha na hora de mandar o e-mail** — de propósito, com o erro
visível. Ele nunca finge que enviou.

### Passo 1 — Criar uma senha de aplicativo no Google

O Gmail não aceita sua senha normal vindo de um programa. Ele exige uma senha
separada, criada só para isso, que você pode revogar depois sem mexer na sua
conta.

**Pré-requisito:** a verificação em duas etapas precisa estar ligada na conta.
Sem ela o Google nem mostra a opção de senha de aplicativo.

1. Entre em `https://myaccount.google.com/apppasswords` com a conta que vai
   **enviar** os alertas (pode ser a sua do Workspace).
2. Se pedir, confirme sua senha.
3. No campo de nome, escreva algo que você reconheça depois — sugestão:
   `PrediaLab Monitor`.
4. Clique em **Criar**.
5. O Google mostra **16 letras em quatro blocos**, tipo `abcd efgh ijkl mnop`.
   **Copie agora**: essa tela não volta. Se perder, apague e crie outra.
6. Os espaços não importam — pode colar com ou sem eles.

> Se a página disser que a opção não está disponível, quase sempre é a
> verificação em duas etapas desligada, ou o administrador do Workspace ter
> bloqueado senhas de aplicativo para o domínio. Nos dois casos a solução está
> no painel de admin do Google, não aqui.

### Passo 2 — Cadastrar os três segredos no GitHub

1. Abra **este** repositório no GitHub (o do monitor, não o do PrediaLab —
   os segredos precisam estar onde o workflow roda).
2. **Settings** (aba no topo do repositório, não a do seu perfil).
3. No menu da esquerda: **Secrets and variables** → **Actions**.
4. Botão **New repository secret**, uma vez para cada linha da tabela:

| Name | Secret |
|---|---|
| `SMTP_USER` | o e-mail que **envia** — ex.: `allan@escolaaplicar.com.br` |
| `SMTP_PASS` | as 16 letras do Passo 1 |
| `ALERT_TO` | quem **recebe** o alerta. Vários separados por vírgula |
| `SAUDE_TOKEN` | **opcional** — ver abaixo |

### O quarto segredo, que é opcional

O `/saude` responde a qualquer um, porque um monitor externo não tem sessão para
apresentar. Mas ele não entrega tudo a qualquer um:

| quem pergunta | recebe |
|---|---|
| qualquer pessoa | o veredito: `{"ok": false}` e o status HTTP 503 |
| quem manda o token | isso **mais** o diagnóstico: qual dependência caiu e com que erro |

O diagnóstico fica atrás do token porque as mensagens de erro nomeiam peças
internas e podem conter endereço de servidor ou trecho de credencial recusada.
O veredito não é segredo — é o mesmo que qualquer pessoa deduz tentando usar o
sistema — e mantê-lo aberto deixa qualquer monitor genérico funcionar.

Se `SAUDE_TOKEN` estiver cadastrado aqui **com o mesmo valor** que está no
Railway, o e-mail de queda chega dizendo *o que* falhou. Sem ele, o monitor
funciona igual e acerta que caiu; só o trecho explicativo do e-mail some, e ele
mesmo avisa que sumiu por isso.

O nome tem que estar exatamente assim, em maiúsculas. Depois de salvo, o GitHub
nunca mais mostra o valor — só permite substituir. Isso é o esperado.

### Passo 3 — Testar agora, sem esperar cair

Você não precisa esperar o sistema quebrar para saber se o alerta funciona.

1. No repositório, aba **Actions**.
2. Na lista à esquerda, clique em **Monitor**.
3. Botão **Run workflow**, à direita.
4. Em **"Forçar falha"**, escolha **`api`**. Deixe a URL de teste vazia.
5. **Run workflow**.

O monitor vai apontar a API para um endereço que não existe, tentar três vezes,
concluir que caiu e **te mandar o e-mail de queda**. Leva cerca de um minuto.

Assunto esperado:

```
[CAÍDO] PrediaLab API - sem resposta
```

6. Agora rode de novo, com **"Forçar falha" = `nenhum`**. Como o estado gravado
   diz "caído" e a API responde, ele manda o e-mail de recuperação:

```
[OK] PrediaLab API voltou após 3min
```

Se os dois e-mails chegaram, está tudo funcionando. **Olhe o spam** na primeira
vez — mensagem de remetente novo costuma cair lá, e marcá-la como "não é spam"
uma vez resolve para sempre.

---

## Como ele decide que caiu

**Três tentativas espaçadas em 20 segundos, e só alerta se as três falharem.**
Uma requisição sozinha falha por soluço de rede o tempo todo; três seguidas, ao
longo de 40 segundos, não. Se a primeira der certo ele para ali mesmo — não
adianta esperar para confirmar que está no ar.

Cada tentativa tem 10 segundos para responder. Passou disso, conta como falha.

**O que é "falhou":**

| situação | conta como queda? |
|---|---|
| HTTP 200 | não |
| HTTP 503, 502, 500, 404… | sim |
| não resolveu o DNS, conexão recusada, TLS quebrado | sim |
| demorou mais de 10s | sim |
| HTTP 200 mas o corpo diz `"ok": false` | sim |

A última linha merece explicação. O `/saude` **já usa o status HTTP**:
responde 200 com `{"ok":true}` quando está inteiro, e 503 com `{"ok":false}`
quando alguma dependência caiu. Conferido no ar e no código-fonte do backend em
02/09/2026 — não foi suposto. Então olhar o status bastaria hoje.

O monitor olha o corpo **além** do status, como rede de segurança: se algum dia
alguém mexer no controller e ele passar a devolver 200 com a degradação
escondida no JSON, o monitor continua acertando em vez de ficar cego em
silêncio.

E o corpo entra no e-mail (500 primeiros caracteres) porque o `/saude` não
responde só "não estou bem": ele nomeia qual dependência falhou e com que erro.
Um alerta que diz apenas "503" manda alguém abrir o log para descobrir o quê;
este já chega com metade da investigação feita.

---

## Por que ele só avisa quando o estado muda

Se ele mandasse e-mail a cada verificação, um fim de semana fora do ar
renderiam mais de 500 mensagens. Depois da terceira ninguém lê mais nenhuma —
e a que importa, a de recuperação, chega no meio de um monte de repetição.

Então ele guarda em qual estado cada endereço estava na execução anterior e só
escreve quando muda: **no ar → caído** e **caído → no ar**.

### Onde esse estado fica, e por que não na `main`

Num arquivo `estado.json`, commitado pelo próprio workflow numa branch chamada
**`monitor-estado`**.

A branch separada não é preciosismo. **Um push na `main` republica o sistema
inteiro**: o Railway reconstrói o backend e o Cloudflare Pages reconstrói a
tela. Se o estado morasse lá, cada queda dispararia um deploy de produção — e
justamente no pior momento, com algo já quebrado. A `monitor-estado` não é
observada por nenhum dos dois.

Ela é uma branch **órfã**: nasce sem histórico e sem cópia do projeto, guardando
um arquivo só. Ela é criada sozinha no primeiro alerta — antes disso não existe,
e isso é normal.

Foram consideradas e descartadas duas alternativas: o cache do GitHub Actions
(some depois de 7 dias sem uso — o monitor perderia a memória exatamente num
período calmo) e os artefatos de execução (têm prazo de validade e exigem
chamar a API para ler a execução anterior).

### A ordem que evita o alerta perdido

O script manda o e-mail **primeiro** e grava o estado **depois**.

Ao contrário, se o envio falhasse, o arquivo já diria "caído", a execução
seguinte não veria mudança nenhuma, e o alerta estaria perdido para sempre —
silêncio no exato caso em que o sistema está fora do ar. Na ordem certa, uma
falha de e-mail deixa o estado antigo no lugar e a próxima execução tenta de
novo.

---

## Coisas que valem saber

**O horário é o de Brasília.** O GitHub trabalha em UTC; o e-mail converte para
`America/Sao_Paulo` antes de mostrar.

**O agendamento não é pontual.** O `schedule` do GitHub Actions atrasa sob
carga, e 5 minutos podem virar 10 ou 15. Para avisar que caiu, serve; para medir
disponibilidade com precisão, não. Se um dia a precisão importar, aí vale um
serviço dedicado.

**O job fica verde mesmo com o sistema caído.** Isso é escolha: o GitHub manda
e-mail automático quando um workflow falha, e um workflow vermelho a cada 5
minutos produziria exatamente a enxurrada que este desenho evita. O job só fica
vermelho quando **o monitor** tem problema — e-mail que não saiu, segredo
faltando. O alerta de queda é o e-mail, não a cor do job.

**Sem dependências.** Nenhum `npm install`. O cliente SMTP está em `smtp.mjs`,
com a sequência mínima que o Gmail exige. Foi escrito assim porque este script
existe para funcionar quando outras coisas não estão funcionando — quanto menos
peças no caminho, melhor.

---

## Arquivos

| arquivo | o que é |
|---|---|
| `.github/workflows/monitor.yml` | o agendamento, os segredos e o commit do estado |
| `verificar.mjs` | verificação, retentativas, decisão de alerta, montagem do e-mail |
| `smtp.mjs` | envio por SMTP, sem bibliotecas |

Para rodar na sua máquina, sem mexer no estado de verdade:

```bash
ARQUIVO_DE_ESTADO=/tmp/estado.json node verificar.mjs
```
