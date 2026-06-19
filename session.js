/**
 * session.js - Gestão de sessão e login no TMS.
 * Reutiliza sessão salva em disco e mantém a janela aberta entre requisições.
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const SESSION_FILE = process.env.SESSION_FILE || './data/session.json';
const BASE_URL     = 'https://mandalog.eslcloud.com.br';
const LOGIN_URL    = `${BASE_URL}/users/sign_in`;
const BATCHES_URL  = `${BASE_URL}/edi/import/batches`;

let _context = null;
let _page    = null;

/**
 * Retorna { page, context } autenticada.
 * 1. Reutiliza a janela atual se ainda estiver aberta e logada.
 * 2. Tenta sessão salva em disco.
 * 3. Se expirada, faz login e salva nova sessão.
 */
async function getAuthenticatedPage(browser) {
  if (_context && _page) {
    try {
      if (!_page.isClosed()) {
        await _page.goto(BATCHES_URL, { waitUntil: 'networkidle', timeout: 20000 });
        if (!_page.url().includes('/users/sign_in')) {
          console.info('[SESSION] Reutilizando janela existente do Chromium.');
          return { page: _page, context: _context };
        }
      }
      await _fecharContextoAtivo();
    } catch (e) {
      console.warn(`[SESSION] Falha ao reutilizar janela existente: ${e.message}`);
      await _fecharContextoAtivo();
    }
  }

  if (fs.existsSync(SESSION_FILE)) {
    console.info('[SESSION] Sessão encontrada - verificando validade...');
    let context;
    try {
      context = await browser.newContext({
        storageState: SESSION_FILE,
        viewport: { width: 1440, height: 900 }
      });
      const page = await context.newPage();
      await page.goto(BATCHES_URL, { waitUntil: 'networkidle', timeout: 20000 });
      if (!page.url().includes('/users/sign_in')) {
        console.info('[SESSION] Sessão válida reutilizada.');
        _context = context;
        _page    = page;
        return { page, context };
      }
      console.warn('[SESSION] Sessão expirada - refazendo login...');
      await context.close();
    } catch (e) {
      console.warn(`[SESSION] Erro ao carregar sessão: ${e.message}`);
      try { await context?.close(); } catch {}
    }
  }

  return _fazerLogin(browser);
}

async function _fazerLogin(browser) {
  const email = process.env.TMS_EMAIL;
  const senha = process.env.TMS_PASSWORD;

  if (!email || !senha) {
    throw new Error('TMS_EMAIL e TMS_PASSWORD não configurados no .env');
  }

  console.info(`[SESSION] Fazendo login com: ${email}`);

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 20000 });
    await page.fill('#user_email', email);
    await page.fill('#user_password', senha);
    await page.click('input[type=submit]');
    await page.waitForFunction(
      () => !window.location.href.includes('/users/sign_in'),
      { timeout: 15000 }
    );
    console.info(`[SESSION] Login realizado. URL: ${page.url()}`);
  } catch (e) {
    await context.close();
    throw new Error(`Falha no login: ${e.message}`);
  }

  try {
    const dir = path.dirname(path.resolve(SESSION_FILE));
    fs.mkdirSync(dir, { recursive: true });
    await context.storageState({ path: SESSION_FILE });
    console.info(`[SESSION] Sessão salva em: ${SESSION_FILE}`);
  } catch (e) {
    console.warn(`[SESSION] Não foi possível salvar sessão: ${e.message}`);
  }

  _context = context;
  _page    = page;
  return { page, context };
}

async function limparSessao() {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
    console.info('[SESSION] Sessão removida.');
  }
  await _fecharContextoAtivo();
}

async function _fecharContextoAtivo() {
  const context = _context;
  _context = null;
  _page    = null;
  if (context) {
    try { await context.close(); } catch {}
  }
}

function eErrosDeSessao(mensagem, page) {
  const msg = (mensagem || '').toLowerCase();
  const isSessionError =
    msg.includes('sessão expirada') ||
    msg.includes('session') ||
    msg.includes('sign_in') ||
    msg.includes('login necessário') ||
    msg.includes('unauthorized');

  const pageOnLogin = page && typeof page.url === 'function' && page.url().includes('/users/sign_in');

  return isSessionError || !!pageOnLogin;
}

module.exports = { getAuthenticatedPage, limparSessao, eErrosDeSessao };
