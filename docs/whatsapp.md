# Confirmação e lembrete pelo WhatsApp

O aplicativo está preparado para a API oficial WhatsApp Cloud da Meta, usando um número remetente central do SpaceBarber. Cada mensagem identifica a barbearia da reserva. Ainda não há onboarding de um número remetente por barbearia.

Sem configuração, nenhuma mensagem é enviada: a interface informa que o WhatsApp está em preparação e os avisos aparecem como **Aguardando ativação do WhatsApp**. Os testes usam respostas simuladas, sem chamadas reais à Meta.

## Ativação

1. Prepare um aplicativo Meta com WhatsApp Cloud API, número remetente, token com permissão de envio e os modelos abaixo aprovados. Para testar, use o número de teste da Meta e um destinatário autorizado no ambiente de teste.
2. Copie `.env.whatsapp.example` para `.env.whatsapp`. Preencha o token, identificador do número, versão suportada da Graph API, nomes dos modelos, idioma e segredo do aplicativo. Defina um token de verificação de webhook aleatório.
3. Disponibilize o servidor em HTTPS. No aplicativo Meta, configure o webhook `https://SEU-DOMINIO/api/webhooks/whatsapp`, informe o mesmo token de verificação e assine o campo `messages`. O servidor verifica a assinatura HMAC SHA-256 do corpo bruto antes de aceitar atualizações de entrega.
4. Mude `WHATSAPP_ENABLED=true` e reinicie o servidor. Criar uma reserva com autorização passa a disparar envios reais. Ative primeiro com destinatários de teste e acompanhe a entrega em **Avisos WhatsApp**.

O arquivo `.env.whatsapp` é carregado pelo servidor e está ignorado pelo Git. As credenciais nunca são retornadas ao navegador. O exemplo contém apenas nomes e valores vazios. Não envie tokens pelo chat nem os coloque no código.

## Modelos

Crie modelos de utilidade em português do Brasil (`pt_BR`), com corpo de texto, variáveis **posicionais**, sem cabeçalho, rodapé ou botões adicionais. Ajuste os nomes no arquivo de configuração se forem diferentes. A aprovação e a classificação são feitas pela Meta.

`spacebarber_confirmacao`:

```text
Olá, {{1}}! Seu agendamento está confirmado na {{2}}.

Serviços: {{3}}
Data: {{4}}
Horário: {{5}} (Brasília)
Profissional: {{6}}
Duração: {{7}}
Valor: {{8}}
Endereço: {{9}}

Acompanhe sua reserva no SpaceBarber.
```

`spacebarber_lembrete`:

```text
Olá, {{1}}! Lembrete do seu agendamento na {{2}}.

Serviços: {{3}}
Data: {{4}}
Horário: {{5}} (Brasília)
Profissional: {{6}}
Duração: {{7}}
Valor: {{8}}
Endereço: {{9}}

Estamos esperando por você! Acompanhe sua reserva no SpaceBarber.
```

Os nove parâmetros são, na ordem: cliente, barbearia, serviços, data, hora, profissional, duração total, preço total e endereço. Preços e serviços são os contratados na reserva. Textos longos permanecem sujeitos aos limites e à validação da Meta; rejeições ficam visíveis como falha de envio.

## Funcionamento

- O cliente informa um número brasileiro com DDD e autoriza os avisos daquela reserva. A autorização vem desmarcada; o último número autorizado fica disponível para preencher a próxima reserva.
- Reserva e avisos são gravados na mesma transação. Sem autorização não são criados avisos; reservas anteriores não recebem notificações retroativas.
- A confirmação entra na fila imediatamente após reservar. O lembrete vence 30 minutos antes, usando Brasília (UTC−03:00).
- O processador verifica a fila a cada 15 segundos e ao iniciar. Horário de entrega no celular depende também da Meta e da conexão do destinatário.
- Para reservas feitas com 30 minutos ou menos de antecedência, somente a confirmação é enviada.
- Ao cancelar ou concluir o atendimento, os avisos que ainda aguardam envio são cancelados. Mensagens já aceitas ou em trânsito não podem ser recolhidas.
- Confirmações expiram após 30 minutos ou no início do atendimento, o que ocorrer primeiro. Lembretes têm tolerância de cinco minutos; depois disso ficam expirados, evitando avisos atrasados após indisponibilidade prolongada.
- A fila fica em SQLite e sobrevive a reinícios. A combinação reserva/tipo é única e cada envio é reivindicado atomicamente. Rejeições por limite de chamadas têm até quatro tentativas com espera progressiva.
- Timeout, erro de rede, erro HTTP 5xx ou interrupção durante um envio ficam como resultado incerto e não são reenviados automaticamente, pois a Meta pode já ter recebido a solicitação. O operador precisa verificar no provedor antes de qualquer reenvio. Esta versão não oferece botão de reenvio manual.
- **Aceito pelo WhatsApp** significa que a API aceitou a solicitação; **Entregue** só aparece depois do webhook de entrega/leitura assinado. Eventos de entrega recebidos antes da resposta HTTP são conciliados; eventos antigos não rebaixam uma mensagem entregue.
- Cliente e proprietário da barbearia podem consultar a mensagem preparada e seu status. Outros usuários não têm acesso. O número é mascarado nessa consulta.

O computador local precisa permanecer ligado, conectado e com o servidor executando. Para operar continuamente, hospede a aplicação em um servidor sempre disponível, com HTTPS e armazenamento persistente. A simples publicação do frontend não executa o agendador. Valide o ciclo real no ambiente da Meta antes de disponibilizar aos clientes.

Referências: [envio de modelos, coleção oficial da Meta](https://www.postman.com/meta/whatsapp-business-platform/request/o65u5m5/send-message-template-text), [verificação de webhooks, referência oficial do SDK arquivado](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/). O projeto usa `fetch` diretamente, sem depender desse SDK arquivado.
