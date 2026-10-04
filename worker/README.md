# Monitor como Cloudflare Worker

Mesma vigilância do workflow do GitHub, com o mesmo `/saude`, as mesmas três
tentativas e o e-mail só quando o estado muda. A diferença é que ele **roda de
fato a cada 5 minutos**.

## Por que saiu do GitHub Actions

O workflow pede `*/5 * * * *`, mas o GitHub trata o `schedule` como "quando
der". Entre 28/09 e 04/10/2026 ele rodou **uma vez a cada 4 a 6 horas**. Na
queda do Redis de 04/10, que durou 43 minutos, o alerta só saiu porque uma
dessas execuções raras caiu, por sorte, dentro da janela.

O Cron Trigger da Cloudflare dispara no minuto pedido, e é grátis nesse
volume: 288 execuções por dia contra 100 mil requisições diárias do plano free.

## O que muda em relação ao workflow

| | workflow | Worker |
|---|---|---|
| frequência real | 4–6 h | 5 min |
| estado | branch `monitor-estado` | Workers KV |
| e-mail | SMTP do Gmail | API do Resend |

O Resend foi escolhido porque Worker não fala SMTP sem reimplementar o
protocolo em socket cru, e porque o backend já envia por ele: o domínio
`escolaaplicar.com.br` já está verificado.

## Para ligar (uma vez)

Rode tudo dentro desta pasta `worker/`.

**1. Entrar na conta Cloudflare** que tem o `escolaaplicar.com.br`:

```bash
npx wrangler login
```

**2. Criar o KV** e colar o `id` que ele imprime no `wrangler.toml`, no lugar
de `COLE_AQUI_O_ID_DO_KV`:

```bash
npx wrangler kv namespace create ESTADO
```

**3. Cadastrar os segredos.** Cada comando pede o valor no terminal; nada fica
em arquivo.

```bash
npx wrangler secret put RESEND_API_KEY
```

Use uma chave **nova** do Resend, criada só para isto e com permissão apenas
de envio, e não a do backend: assim dá para revogar uma sem derrubar a outra.

```bash
npx wrangler secret put ALERT_TO
```

O mesmo destinatário do workflow (vários separados por vírgula).

```bash
npx wrangler secret put SAUDE_TOKEN
```

Opcional: o mesmo valor do `SAUDE_TOKEN` do Railway. Sem ele o alerta acerta
se caiu, mas não diz o quê.

**4. Publicar:**

```bash
npx wrangler deploy
```

**5. Conferir que está rodando**, no painel da Cloudflare: Workers & Pages →
`predialab-monitor` → Logs. A cada 5 minutos aparece uma execução com
`OK PrediaLab API (antes: up) 200`.

**6. Desligar o agendamento do workflow**, para não chegarem dois alertas por
queda: em `.github/workflows/monitor.yml`, apague o bloco `schedule:`. Mantenha
o `workflow_dispatch`, que continua útil para disparar o teste de falha
forçada.

## Testes

Rodam em Node puro, sem Wrangler e sem rede:

```bash
node --test worker/test.mjs
```
