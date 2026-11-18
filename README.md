# OutSystems ODC MCP para o Google Antigravity

Instala o servidor **MCP da OutSystems Developer Cloud (ODC)** no **Antigravity** do usuário, para que o agente de IA do Antigravity consulte, edite (via Mentor), publique e faça deploy de aplicações do seu tenant ODC.

## Pré-requisitos

- **Google Antigravity** instalado (e aberto ao menos uma vez).
- **Node.js 20+** (inclui o `npm`). Verifique com `node --version`.
- Um usuário no tenant ODC com o **MCP habilitado** para o tenant.

Nenhuma credencial, Client ID ou Client Secret é necessário: o login é feito no navegador com o seu próprio usuário OutSystems.

### Instalando o Node.js

Se `node --version` não funcionar, ou mostrar uma versão menor que 20, instale a versão LTS:

**Windows** (PowerShell):
```powershell
winget install --id OpenJS.NodeJS.LTS -e
```

**macOS** ([Homebrew](https://brew.sh)):
```bash
brew install node@22
brew link --overwrite node@22
```

**Linux** (via [nvm](https://github.com/nvm-sh/nvm), sem precisar de `sudo`):
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install --lts
```

Se preferir, use o instalador oficial em https://nodejs.org (versão LTS).

Depois de instalar, **feche e abra o terminal** e confira:
```bash
node --version   # v20 ou superior
npm --version
```

> Se você atualizar ou mover o Node.js depois, rode `node install.mjs` de novo. O caminho do `node` fica gravado na configuração do Antigravity.

## Instalação

```bash
git clone https://github.com/arturscl/antigravity-mcp-outsystems.git
cd antigravity-mcp-outsystems
node install.mjs --tenant minhaempresa.outsystems.dev
```

Sem `--tenant`, o script pergunta o hostname. Depois:

1. **Reinicie o Antigravity.**
2. Peça ao agente algo como *"liste minhas aplicações no OutSystems"*.
3. Na primeira chamada, o navegador abre o login do seu tenant. Entre com o seu usuário. O token é renovado automaticamente.

Para atualizar ou reparar, rode o mesmo comando de novo. Ele é idempotente.

## O que o instalador faz

Tudo fica no perfil do usuário (`~/.gemini/antigravity/`), e nada é instalado globalmente:

| Passo | Destino |
|---|---|
| Instala o proxy [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) com versão fixada pelo `package-lock.json` (`npm ci --ignore-scripts`) | `~/.gemini/antigravity/outsystems-mcp-proxy/` |
| Registra o servidor `outsystems` → `https://<tenant>/mcp`, preservando os outros servidores e com backup `.bak-<data>` | `~/.gemini/antigravity/mcp_config.json` |
| Instala a skill que ensina o agente a usar as ferramentas da ODC (confirmação antes de publish/deploy, polling de operações longas etc.) | `~/.gemini/antigravity/skills/outsystems-odc/` |

### Por que um proxy local?

O servidor MCP da ODC usa OAuth e só aceita callback de login em `http://localhost`. O Antigravity conectado direto envia um callback HTTPS (`https://antigravity.google/oauth-callback`), que é recusado com `invalid_redirect_uri`. O `mcp-remote` faz o login com callback local e repassa as chamadas para o Antigravity via stdio. Essa é a mesma abordagem que a [OutSystems documenta](https://github.com/OutSystems/outsystems-mcp) para clientes nessa situação.

## Desinstalar

```bash
node install.mjs --uninstall
```

O comando remove o servidor da configuração (com backup), a skill e o proxy. O login salvo do proxy fica em `~/.mcp-auth`.

## Solução de problemas

| Sintoma | Causa / ação |
|---|---|
| `tenant_not_allowed` | O MCP não está habilitado para o tenant, ou o hostname está errado. Habilite no ODC Portal ou reinstale com o hostname correto. |
| O servidor `outsystems` não aparece ou não conecta | Reinicie o Antigravity. Se continuar, rode `node install.mjs` de novo. Se o Node.js foi atualizado ou movido, reinstale, porque o caminho do `node` fica gravado na configuração. |
| A janela de login reabre sem concluir | Veja a seção *Reset* em https://github.com/OutSystems/outsystems-mcp#troubleshooting |

## Atualizar a versão do proxy (mantenedores)

A versão do `mcp-remote` e as dependências transitivas ficam fixadas em [mcp-proxy/package.json](mcp-proxy/package.json) e [mcp-proxy/package-lock.json](mcp-proxy/package-lock.json). Ao atualizar:

- use apenas versões publicadas há **≥ 7 dias**;
- verifique em socket.dev e osv.dev;
- regenere o lock com `npm install --package-lock-only --ignore-scripts` dentro de `mcp-proxy/`;
- confira se nenhuma dependência transitiva tem menos de 7 dias (use `overrides` se precisar);
- rode `npm audit --package-lock-only`.
