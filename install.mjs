#!/usr/bin/env node
/**
 * Instala o servidor MCP da OutSystems Developer Cloud (ODC) no Google Antigravity.
 *
 * O que este script faz (somente no perfil do usuário atual):
 *   1. Instala o proxy local `mcp-remote` (versão fixada + package-lock) em
 *      ~/.gemini/antigravity/outsystems-mcp-proxy via `npm ci --ignore-scripts`.
 *   2. Registra o servidor "outsystems" em ~/.gemini/antigravity/mcp_config.json
 *      (com backup), apontando para https://<tenant>/mcp através do proxy.
 *   3. Instala a skill "outsystems-odc" em ~/.gemini/antigravity/skills/.
 *
 * Por que um proxy: o Antigravity usa um callback OAuth HTTPS que o servidor da
 * OutSystems recusa (só aceita callback http://localhost). O `mcp-remote` faz o
 * login OAuth no navegador com callback local e renova o token sozinho — nenhum
 * token ou segredo é gravado em arquivos de configuração.
 *
 * Uso:
 *   node install.mjs --tenant minhaempresa.outsystems.dev
 *   node install.mjs                 (pergunta o tenant)
 *   node install.mjs --uninstall
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "outsystems";
const SKILL_NAME = "outsystems-odc";
const MIN_NODE_MAJOR = 20;
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY_SRC = path.join(REPO_DIR, "mcp-proxy");
const SKILL_SRC = path.join(REPO_DIR, "skills", SKILL_NAME);

const GEMINI_HOME = path.join(os.homedir(), ".gemini");
const AG_HOME = path.join(GEMINI_HOME, "antigravity");
const PROXY_DIR = path.join(AG_HOME, "outsystems-mcp-proxy");
const PROXY_ENTRY = path.join(PROXY_DIR, "node_modules", "mcp-remote", "dist", "proxy.js");
const SKILL_DST = path.join(AG_HOME, "skills", SKILL_NAME);

// Arquivo principal lido pelo Antigravity + arquivo legado que versões
// anteriores deste projeto também alteravam (só é tocado se já existir).
const PRIMARY_CONFIG = path.join(AG_HOME, "mcp_config.json");
const LEGACY_CONFIGS = [path.join(GEMINI_HOME, "config", "mcp_config.json")];

// ---------------------------------------------------------------- utilidades

const log = (msg = "") => console.log(msg);
const step = (msg) => console.log(`\n▶ ${msg}`);
const ok = (msg) => console.log(`  ✔ ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);

class InstallError extends Error {}

function parseArgs(argv) {
  const opts = { tenant: null, uninstall: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--uninstall") opts.uninstall = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--tenant") opts.tenant = argv[++i] ?? "";
    else if (a.startsWith("--tenant=")) opts.tenant = a.slice("--tenant=".length);
    else throw new InstallError(`Argumento desconhecido: ${a}`);
  }
  return opts;
}

function normalizeTenant(raw) {
  let t = String(raw ?? "").trim().toLowerCase();
  t = t.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\/mcp$/, "").replace(/\/+$/, "");
  if (!t || !HOSTNAME_RE.test(t) || !t.includes(".")) {
    throw new InstallError(
      `Tenant inválido: "${raw}". Informe apenas o hostname, ex.: minhaempresa.outsystems.dev`
    );
  }
  return t;
}

async function askTenant() {
  if (!process.stdin.isTTY) {
    throw new InstallError("Informe o tenant com --tenant <hostname> (ex.: minhaempresa.outsystems.dev).");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question("Hostname do seu tenant ODC (ex.: minhaempresa.outsystems.dev): ");
  } finally {
    rl.close();
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

function readConfig(file) {
  if (!fs.existsSync(file)) return { mcpServers: {} };
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  if (!text.trim()) return { mcpServers: {} };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new InstallError(`${file} não é um JSON válido (${e.message}). Corrija-o manualmente e rode de novo.`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new InstallError(`${file} não contém um objeto JSON.`);
  }
  if (typeof data.mcpServers !== "object" || data.mcpServers === null) data.mcpServers = {};
  return data;
}

function writeConfig(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-${timestamp()}`;
    fs.copyFileSync(file, backup);
    ok(`Backup: ${backup}`);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function run(cmd, cwd) {
  // Comando fixo, sem entrada do usuário; shell necessário para npm.cmd no Windows.
  const r = spawnSync(cmd, { cwd, shell: true, stdio: "inherit" });
  if (r.status !== 0) throw new InstallError(`Falha ao executar: ${cmd} (código ${r.status ?? r.error?.message})`);
}

// ------------------------------------------------------------------- passos

function checkPrerequisites() {
  step("Verificando pré-requisitos");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new InstallError(`Node.js ${MIN_NODE_MAJOR}+ é necessário (encontrado ${process.versions.node}).`);
  }
  ok(`Node.js ${process.versions.node} (${process.execPath})`);

  const npm = spawnSync("npm --version", { shell: true, encoding: "utf8" });
  if (npm.status !== 0) throw new InstallError("npm não encontrado no PATH.");
  ok(`npm ${npm.stdout.trim()}`);

  for (const f of [path.join(PROXY_SRC, "package.json"), path.join(PROXY_SRC, "package-lock.json"), path.join(SKILL_SRC, "SKILL.md")]) {
    if (!fs.existsSync(f)) throw new InstallError(`Arquivo do projeto ausente: ${f}`);
  }

  if (!fs.existsSync(AG_HOME)) {
    warn(`${AG_HOME} não existe — o Antigravity parece nunca ter sido aberto neste usuário. A pasta será criada.`);
  } else {
    ok(`Antigravity encontrado em ${AG_HOME}`);
  }
}

function installProxy() {
  step(`Instalando o proxy mcp-remote em ${PROXY_DIR}`);
  fs.mkdirSync(PROXY_DIR, { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(PROXY_SRC, f), path.join(PROXY_DIR, f));
  }
  // npm ci: respeita exatamente o package-lock (versões e hashes de integridade).
  // --ignore-scripts: nenhuma dependência executa scripts de instalação.
  run("npm ci --ignore-scripts --no-audit --no-fund --loglevel=error", PROXY_DIR);
  if (!fs.existsSync(PROXY_ENTRY)) throw new InstallError(`Entrypoint do proxy não encontrado: ${PROXY_ENTRY}`);
  const version = JSON.parse(fs.readFileSync(path.join(PROXY_DIR, "node_modules", "mcp-remote", "package.json"), "utf8")).version;
  ok(`mcp-remote ${version} instalado`);
}

function serverEntry(tenant) {
  return {
    command: process.execPath,
    args: [PROXY_ENTRY, `https://${tenant}/mcp`],
  };
}

function registerServer(tenant) {
  step("Registrando o servidor MCP no Antigravity");
  const entry = serverEntry(tenant);

  const primary = readConfig(PRIMARY_CONFIG);
  primary.mcpServers[SERVER_NAME] = entry;
  writeConfig(PRIMARY_CONFIG, primary);
  ok(`"${SERVER_NAME}" → https://${tenant}/mcp em ${PRIMARY_CONFIG}`);

  // Substitui entradas antigas (ex.: com token Bearer fixo) em arquivos legados.
  for (const file of LEGACY_CONFIGS) {
    if (!fs.existsSync(file)) continue;
    const cfg = readConfig(file);
    if (!(SERVER_NAME in cfg.mcpServers)) continue;
    cfg.mcpServers[SERVER_NAME] = entry;
    writeConfig(file, cfg);
    ok(`Entrada antiga substituída em ${file}`);
  }
}

function installSkill(tenant) {
  step(`Instalando a skill "${SKILL_NAME}"`);
  fs.rmSync(SKILL_DST, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(SKILL_DST), { recursive: true });
  fs.cpSync(SKILL_SRC, SKILL_DST, { recursive: true });
  const skillFile = path.join(SKILL_DST, "SKILL.md");
  fs.writeFileSync(skillFile, fs.readFileSync(skillFile, "utf8").replaceAll("{{TENANT}}", tenant), "utf8");
  ok(SKILL_DST);
}

function uninstall() {
  step("Removendo a integração OutSystems ODC do Antigravity");
  for (const file of [PRIMARY_CONFIG, ...LEGACY_CONFIGS]) {
    if (!fs.existsSync(file)) continue;
    const cfg = readConfig(file);
    if (!(SERVER_NAME in cfg.mcpServers)) continue;
    delete cfg.mcpServers[SERVER_NAME];
    writeConfig(file, cfg);
    ok(`Servidor "${SERVER_NAME}" removido de ${file}`);
  }
  for (const dir of [SKILL_DST, PROXY_DIR]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      ok(`Removido: ${dir}`);
    }
  }
  log("\nO login OAuth salvo pelo mcp-remote fica em ~/.mcp-auth (compartilhado com outros servidores que usem o mesmo proxy); não foi alterado.");
  log("Reinicie o Antigravity para concluir.");
}

// --------------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log("Uso: node install.mjs [--tenant <hostname>] | --uninstall");
    return;
  }
  if (opts.uninstall) return uninstall();

  log("OutSystems ODC MCP → Antigravity");
  const tenant = normalizeTenant(opts.tenant ?? process.env.OUTSYSTEMS_TENANT ?? (await askTenant()));

  checkPrerequisites();
  installProxy();
  registerServer(tenant);
  installSkill(tenant);

  log(`
✅ Instalação concluída para o tenant ${tenant}.

Próximos passos:
  1. Reinicie o Antigravity (feche todas as janelas e abra de novo).
  2. Na tela de MCP Servers do Antigravity, confira se "${SERVER_NAME}" aparece na lista.
  3. Na primeira chamada de ferramenta, o navegador abre o login do seu tenant ODC.
     Entre com o seu usuário OutSystems; o token é renovado automaticamente.
  4. Teste pedindo ao agente: "liste minhas aplicações no OutSystems".

Se o tenant responder "tenant_not_allowed", o MCP ainda não foi habilitado para ele no ODC Portal.`);
}

main().catch((err) => {
  if (err instanceof InstallError) {
    console.error(`\n✖ ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
