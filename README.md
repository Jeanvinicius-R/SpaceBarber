# SpaceBarber — agenda e gestão

Identidade visual: preto, marrom e dourado, com seletor claro/escuro no topo. O tema claro vem por padrão e a escolha fica salva neste navegador. O nome está aplicado provisoriamente no projeto local. Há uso público de “Space Barber” no mesmo segmento em https://spacebarber.com.br/sistema-para-barbearia/; esta pesquisa não verifica registro de marca.

Primeira versão funcional local para múltiplas barbearias e clientes. Interface em português, responsiva, com API Node.js e banco SQLite persistente. Agenda e gestão funcionam localmente; avisos por WhatsApp dependem da API externa configurada.

## Abrir

Requer Node.js 22.13 ou superior (validado com Node 24). Na pasta do projeto:

```powershell
node server.mjs
```

Você também pode executar `Iniciar SpaceBarber.cmd`. Abra http://localhost:3000. Alternativamente, `npm.cmd start` no Windows. Não é preciso instalar dependências para usar o sistema. O SQLite nativo pode apresentar um aviso de recurso experimental.

Use **Entrar → Testar como cliente** ou **Testar como barbearia**. As contas locais são `cliente@demo.local` e `barbeiro@demo.local`, senha `Demo@12345`. As três barbearias e os endereços iniciais são fictícios e identificados na interface. Cadastre outra conta para testar uma barbearia independente.

## Funcionalidades

- Cadastro e login separados para clientes e proprietários; senha protegida com scrypt, sessões HttpOnly e autorização no servidor.
- Várias barbearias, cada uma com seus próprios serviços, profissionais, agenda, despesas e configurações.
- Busca por nome, bairro e cidade; favoritos salvos neste navegador. “Perto de mim” solicita geolocalização e lista estabelecimentos em até 25 km quando têm coordenadas cadastradas.
- Serviços com preço e duração, edição e desativação sem apagar o histórico.
- Cadastro de profissionais. Cada profissional tem reservas independentes; nesta versão todos compartilham o expediente da barbearia.
- Expediente semanal; domingo inicialmente fechado. Horários em Brasília (America/Sao_Paulo, UTC−03:00).
- Cliente escolhe um ou mais serviços, profissional, data e horário; os preços e as durações são somados para uma reserva contínua com o mesmo profissional; servidor impede sobreposição, inclusive em reservas simultâneas. O preço e a duração ficam preservados na reserva.
- Histórico do cliente, cancelamento futuro, conclusão de atendimento pelo proprietário e registro manual de recebimento.
- Financeiro com recebimentos, valores a receber, despesas, saldo e exportação CSV. Cancelamentos não fazem estorno automático; os totais excluem reservas canceladas.
- Layout adaptado a celular e manifesto para atalho à tela inicial. Ainda não há suporte offline nem aplicativo publicado nas lojas.

## Dados e configuração

O banco é criado em `data/barbeiro.sqlite` na primeira inicialização. Não apague essa pasta para atualizar o sistema. Faça backup do banco com o servidor parado, incluindo eventuais arquivos `-wal` e `-shm`, ou use uma ferramenta de backup compatível com SQLite. Não exponha a pasta `data` em um servidor estático.

Variáveis opcionais: `PORT` (padrão 3000), `HOST` (padrão 127.0.0.1), `DATABASE_PATH` (arquivo do banco), `SEED_DEMO=false` (não criar demonstração em banco novo) e `NODE_ENV=production` (cookie Secure, requer HTTPS).

Para acessar pelo celular na mesma rede de confiança:

```powershell
$env:HOST = '0.0.0.0'
node server.mjs
```

No celular, abra `http://IP-DO-COMPUTADOR:3000`. O firewall do Windows pode precisar liberar a porta. Geolocalização e instalação avançada exigem contexto seguro (HTTPS, exceto localhost); nessa conexão use a busca por cidade. Não configure encaminhamento de porta para a internet. A publicação online ainda não foi feita: o conector Sites retornou `sites_access_disabled` neste workspace.

## Avisos pelo WhatsApp

Confirmação após a reserva e lembrete programado para 30 minutos antes, mediante telefone e autorização do cliente em cada agendamento. A fila fica no SQLite; cancelar a reserva suspende avisos pendentes. Reservas feitas com menos de 30 minutos de antecedência recebem somente a confirmação.

O envio real permanece desativado até configurar o número, credenciais, modelos aprovados e webhook da API oficial. Veja [configuração do WhatsApp](docs/whatsapp.md) e `.env.whatsapp.example`. Os testes usam transporte simulado, sem enviar mensagens reais. Para cumprir os horários, o servidor deve permanecer ligado e conectado; a operação online exige hospedagem contínua.

## Verificação

Validação realizada nesta entrega: **21 testes de integração, 13 testes de notificações e 9 roteiros de navegador aprovados**, além da verificação de sintaxe. Navegador: Microsoft Edge, incluindo viewport móvel de 390 × 844. Os cenários incluem cadastro dos dois perfis, isolamento, concorrência de reservas, conservação do preço, despesas, geolocalização simulada, busca sem acentos, agendamento, cancelamento e avisos de WhatsApp. Isso não equivale a homologação em aparelhos físicos ou validação de entrega real pela Meta.

```powershell
npm.cmd test
npm.cmd run build
npm.cmd ci
npx.cmd playwright test
```

`test` usa um banco temporário exclusivo, sem tocar em `data`. `build` verifica a sintaxe: este servidor não precisa de compilação. As dependências de desenvolvimento servem apenas aos testes de navegador. O Playwright usa Edge ou Chrome instalado no Windows; em outro ambiente, configure `PLAYWRIGHT_CHROMIUM_EXECUTABLE` ou instale o navegador do Playwright. A suíte visual também cria banco temporário e grava capturas em `test-results/`.

## Próximas etapas para operação real

Pagamento antecipado não está implementado. A interface permite somente pagamento no local e informa a pendência. É necessário escolher/configurar um provedor com recebimento por barbearia, checkout, webhooks verificados, idempotência, taxas, cancelamentos e estornos, e validar em sandbox. Nunca coletar dados de cartão nesta versão.

Também faltam hospedagem HTTPS, recuperação e verificação de e-mail, documentos definitivos de privacidade e termos, bloqueios/intervalos e jornadas individuais, gestão de acesso da equipe, backups automáticos e testes de carga. A limitação de tentativas atual é por IP de conexão, em memória e por processo; atrás de proxy precisa de configuração explícita de proxies confiáveis e armazenamento compartilhado. As imagens ilustrativas e fontes usam serviços externos; o funcionamento da agenda independe delas.

O esqueleto inicial do Sites foi preservado em `.starter-reference/` (ignorado pelo Git); ele não participa da execução deste aplicativo. Os arquivos ativos são `server.mjs`, `public/`, `tests/`, `playwright.config.mjs` e `package.json`.

Seleção de vários serviços: a tabela `appointment_services` guarda o nome, preço e duração de cada item no momento da reserva. A criação da tabela é aditiva; reservas antigas continuam usando seus registros e totais existentes.
