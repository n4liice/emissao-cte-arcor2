const { chromium, expect } = require('@playwright/test');
const { getAuthenticatedPage, limparSessao, eErrosDeSessao } = require('./session');

const CONFIG = {
  baseUrl: 'https://mandalog.eslcloud.com.br',
  headless: false,
  retries: 2,
  decisaoModalDuplicidade: 'sim',
  timeouts: {
    navigation: 30000,
    element: 10000,
    action: 7000,
    modal: 8000
  }
};

const CLASSIFICACOES = {
  'TRANSFERENCIA': '2186',
  'TRANSFERÊNCIA': '2186',
  'COLETA DE PALETES': '511'
};


function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim();
}


async function retry(fn, tentativas = CONFIG.retries, nomePasso = 'passo') {
  let ultimoErro;

  for (let i = 1; i <= tentativas; i++) {
    try {
      return await fn();
    } catch (error) {
      ultimoErro = error;
      console.warn(`[RETRY] ${nomePasso} tentativa ${i}/${tentativas}: ${error.message}`);

      if (i < tentativas) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  }

  throw ultimoErro;
}

async function tirarScreenshot(page, nome) {
  const path = `screenshots/${nome}_${Date.now()}.png`;

  try {
    await page.screenshot({ path, fullPage: true });
    return path;
  } catch {
    return null;
  }
}

function validarInput(input) {
  if (!input) {
    throw new Error('Input não informado.');
  }

  if (!input.oc) {
    throw new Error('Campo "oc" é obrigatório.');
  }

  if (!Array.isArray(input.notas_mercadoria) || input.notas_mercadoria.length === 0) {
    throw new Error('Campo "notas_mercadoria" deve ser um array com pelo menos uma nota.');
  }

  if (!input.tipo_veiculo) {
    throw new Error('Campo "tipo_veiculo" é obrigatório.');
  }

  if (!input.classificacao) {
    throw new Error('Campo "classificacao" é obrigatório.');
  }

  for (const nota of input.notas_mercadoria) {
    if (!nota.chave_nfe) {
      throw new Error('Todas as notas precisam ter "chave_nfe".');
    }

    const chave = String(nota.chave_nfe).replace(/\D/g, '');

    if (chave.length !== 44) {
      throw new Error(`Chave NF-e inválida: ${nota.chave_nfe}`);
    }

    if (!nota.grupo && !nota.cliente && !nota.destinatario) {
      throw new Error(`A chave ${nota.chave_nfe} está sem grupo/cliente/destinatário.`);
    }
  }
}

function agruparNotasPorCliente(notasMercadoria) {
  const grupos = {};

  for (const nota of notasMercadoria) {
    const grupo = normalizarTexto(nota.grupo || nota.cliente || nota.destinatario);

    if (!grupos[grupo]) {
      grupos[grupo] = {
        grupo,
        notas: []
      };
    }

    grupos[grupo].notas.push({
      ...nota,
      chave_nfe: String(nota.chave_nfe).replace(/\D/g, '')
    });
  }

  return Object.values(grupos);
}

async function selecionarSelect2PorLabel(page, selector, label) {
  await retry(async () => {
    const select = page.locator(selector);

    await select.scrollIntoViewIfNeeded();
    await expect(select).toBeAttached({ timeout: CONFIG.timeouts.element });

    try {
      await select.selectOption({ label });
    } catch {
      // fallback: busca pelo texto parcial nas options disponíveis
      const match = await page.evaluate(({ sel, lbl }) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const opt = Array.from(el.options).find(o =>
          o.text.toUpperCase().includes(lbl.toUpperCase())
        );
        return opt ? opt.value : null;
      }, { sel: selector, lbl: label });

      if (!match) {
        throw new Error(`Opção "${label}" não encontrada em ${selector}`);
      }

      await select.selectOption({ value: match });
    }

    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, selector);

    await page.waitForTimeout(500);
  }, CONFIG.retries, `selecionar ${label}`);
}

async function selecionarSelect2Autocomplete(page, selectId, texto) {
  await retry(async () => {
    const containerSelector = `#select2-${selectId}-container`;
    const container = page.locator(containerSelector);

    await container.scrollIntoViewIfNeeded();
    await expect(container).toBeVisible({ timeout: CONFIG.timeouts.element });
    await container.click();

    const searchInput = page.locator('.select2-search__field').last();
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    // digita os primeiros 4 chars para acionar AJAX (ESL não responde com texto longo)
    const termoBusca = texto.substring(0, 4);
    await searchInput.fill('');
    await searchInput.type(termoBusca, { delay: 80 });

    // aguarda AJAX terminar: "Buscando…" desaparecer e opções reais aparecerem
    await page.waitForFunction(() => {
      const opts = Array.from(document.querySelectorAll('.select2-results__option'));
      const loading = opts.some(el => /buscando|searching|carregando/i.test(el.textContent));
      const hasResults = opts.some(el => !/buscando|searching|carregando/i.test(el.textContent) && el.textContent.trim());
      return !loading && hasResults;
    }, { timeout: 8000 }).catch(() => null);

    const clicked = await page.evaluate((alvo) => {
      const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
      const target = norm(alvo);
      const opts = Array.from(document.querySelectorAll(
        '.select2-results__option:not(.select2-results__option--disabled)'
      )).filter(el => {
        const txt = norm(el.textContent);
        return txt && !txt.includes('SEARCHING') && !txt.includes('CARREGANDO') && !txt.includes('BUSCANDO');
      });

      // prioridade: exato > começa com > contém
      const match = opts.find(el => norm(el.textContent) === target)
        || opts.find(el => norm(el.textContent).startsWith(target))
        || opts.find(el => norm(el.textContent).includes(target) && !norm(el.textContent).includes(' - ' + target) && !norm(el.textContent).includes('3/4'));

      if (!match) return null;
      match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      match.click();
      return match.textContent.trim();
    }, texto);

    if (!clicked) {
      const disponiveis = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.select2-results__option')).map(el => el.textContent.trim())
      );
      throw new Error(`Opção "${texto}" não encontrada. Disponíveis: ${JSON.stringify(disponiveis)}`);
    }

    await page.waitForTimeout(500);
    console.log(`[SELECT2] "${selectId}" → "${clicked}"`);
  }, CONFIG.retries, `select2 autocomplete ${texto}`);
}

async function selecionarSelect2PorValue(page, selector, value) {
  await retry(async () => {
    const select = page.locator(selector);

    await select.scrollIntoViewIfNeeded();
    await expect(select).toBeAttached({ timeout: CONFIG.timeouts.element });

    await select.selectOption({ value });

    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, selector);

    await page.waitForTimeout(500);
    await expect(select).toHaveValue(value, { timeout: CONFIG.timeouts.action });
  }, CONFIG.retries, `selecionar value ${value}`);
}

async function navegarNovoFreteNormal(page) {
  await retry(async () => {
    await page.goto(`${CONFIG.baseUrl}/freight/normals/new`, {
      waitUntil: 'networkidle',
      timeout: CONFIG.timeouts.navigation
    });

    if (page.url().includes('/users/sign_in') || page.url().includes('/login')) {
      throw new Error('Sessão expirada. Login necessário.');
    }

    await expect(page).toHaveURL(/\/freight\/normals\/new/, {
      timeout: CONFIG.timeouts.navigation
    });

    const campoChave = page.getByPlaceholder('Nº Chave da DANFE ou DACTE');
    await expect(campoChave).toBeVisible({ timeout: CONFIG.timeouts.element });
  }, CONFIG.retries, 'abrir novo frete normal');
}

async function importarChaveNFe(page, chaveNFe) {
  const chave = String(chaveNFe).replace(/\D/g, '');

  if (chave.length !== 44) {
    throw new Error(`Chave NF-e inválida: ${chaveNFe}`);
  }

  await retry(async () => {
    const campo = page.getByPlaceholder('Nº Chave da DANFE ou DACTE');

    await expect(campo).toBeVisible({ timeout: CONFIG.timeouts.element });

    await campo.click();
    await campo.fill(chave);
    await expect(campo).toHaveValue(chave, { timeout: CONFIG.timeouts.action });

    await campo.press('Enter');
    await page.waitForTimeout(1500);

    await tratarModalDuplicidade(page);
    await tratarPopupSwal(page);
  }, CONFIG.retries, `importar chave ${chave}`);
}

async function tratarModalDuplicidade(page) {
  const modal = page.getByRole('dialog');
  const modalVisivel = await modal.isVisible().catch(() => false);

  if (!modalVisivel) {
    return;
  }

  const textoModal = await modal.textContent().catch(() => '');

  if (!textoModal.includes('já vinculado a outro frete')) {
    throw new Error(`Modal inesperado detectado: ${textoModal}`);
  }

  if (CONFIG.decisaoModalDuplicidade === 'sim') {
    const btnSim = page.getByRole('button', { name: 'Sim' });

    await expect(btnSim).toBeEnabled({
      timeout: CONFIG.timeouts.action
    });

    await btnSim.click();
  } else {
    const btnCancelar = page.getByRole('button', { name: 'Cancelar' });

    await expect(btnCancelar).toBeEnabled({
      timeout: CONFIG.timeouts.action
    });

    await btnCancelar.click();
  }

  await expect(modal).not.toBeVisible({
    timeout: CONFIG.timeouts.modal
  });

  await page.getByText('Nota fiscal adicionada')
    .waitFor({ timeout: 5000 })
    .catch(() => null);
}

async function preencherDadosFrete(page, dados) {
  await tratarPopupSwal(page);

  await selecionarSelect2Autocomplete(
    page,
    'freight_normal_vehicle_type_id',
    dados.tipo_veiculo
  );

  await tratarPopupSwal(page);

  const campoReferencia = page.locator('#freight_normal_reference_number');

  await campoReferencia.scrollIntoViewIfNeeded();
  await expect(campoReferencia).toBeVisible({
    timeout: CONFIG.timeouts.element
  });

  await campoReferencia.fill(String(dados.nr_referencia));
  await campoReferencia.press('Tab');

  await expect(campoReferencia).toHaveValue(String(dados.nr_referencia), {
    timeout: CONFIG.timeouts.action
  });

  await tratarPopupSwal(page);

  const classificacaoNormalizada = normalizarTexto(dados.classificacao);

  if (!CLASSIFICACOES[classificacaoNormalizada]) {
    throw new Error(`Classificação inválida: ${dados.classificacao}`);
  }

  await selecionarSelect2Autocomplete(
    page,
    'freight_normal_freight_classification_id',
    dados.classificacao
  );

  // popup SweetAlert que pode aparecer após selecionar a classificação
  await tratarPopupSwal(page);
}

async function tratarPopupSwal(page) {
  try {
    const btnSim = page.locator('#swal-confirm, button.swal2-confirm.swal2-styled');
    const visivel = await btnSim.first().isVisible({ timeout: 5000 });
    if (!visivel) return;

    await btnSim.first().click({ force: true });
    await expect(btnSim.first()).not.toBeVisible({ timeout: CONFIG.timeouts.modal });
    console.log('[SWAL] Popup confirmado com "Sim".');
  } catch {
    // popup não apareceu, seguir normalmente
  }
}


async function salvarComoRascunhoECapturarId(page) {
  const btnSalvar = page.getByRole('button', { name: /salvar/i });

  await expect(btnSalvar).toBeVisible({
    timeout: CONFIG.timeouts.element
  });

  await expect(btnSalvar).toBeEnabled({
    timeout: CONFIG.timeouts.element
  });

  await tratarPopupSwal(page);
  await btnSalvar.click();
  await page.waitForTimeout(2000); // aguarda popup de confirmação aparecer
  await tratarPopupSwal(page);
  await page.waitForTimeout(1000);
  await tratarPopupSwal(page);     // segunda tentativa caso apareça com delay

  // aguarda redirect para /freight/normals/:id OU toast/alert de sucesso
  await Promise.race([
    page.waitForURL(/\/freight\/normals\/\d+/, { timeout: CONFIG.timeouts.navigation }),
    page.waitForSelector('.alert-success, .toast-success, .toast-message', { timeout: CONFIG.timeouts.navigation }),
    page.waitForFunction(() => /\/freight\/normals\/\d+/.test(window.location.href), { timeout: CONFIG.timeouts.navigation })
  ]).catch(() => null);

  await page.waitForTimeout(1500);

  const urlFinal = page.url();
  let idCte = urlFinal.match(/\/freight\/normals\/(\d+)/)?.[1];

  // fallback: tentar extrair ID de links/formulários na página
  if (!idCte) {
    idCte = await page.evaluate(() => {
      const m = (document.querySelector('form[action]')?.getAttribute('action') || '')
        .match(/\/freight\/normals\/(\d+)/);
      if (m) return m[1];
      const link = document.querySelector('a[href*="/freight/normals/"]');
      return link?.getAttribute('href')?.match(/\/freight\/normals\/(\d+)/)?.[1] || null;
    });
  }

  if (!idCte) {
    throw new Error(`Não foi possível capturar o ID do CTe. URL atual: ${urlFinal}`);
  }

  return {
    id_cte: idCte,
    url: urlFinal
  };
}

async function capturarNotasFiscais(page) {
  // aguarda a tabela estar no DOM (pode estar em aba inativa, por isso 'attached' e não 'visible')
  await page.locator('#resource_invoices_table').first().waitFor({ state: 'attached', timeout: 10000 });

  // aguarda o Vue renderizar os dados da tabela (AJAX)
  await page.waitForFunction(
    () => !!document.querySelector('#resource_invoices_table td.invoice-key'),
    { timeout: 8000 }
  ).catch(() => null);

  const todasNFs = [];
  let pagina = 1;

  while (true) {
    console.log(`[NOTAS] Lendo NFs — página ${pagina}`);

    // lê via evaluate com textContent para funcionar mesmo em elemento "hidden" para o Playwright
    const { chaves, numeros, footerText } = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('#resource_invoices_table'));
      // escolhe a tabela que contém dados de invoice
      const target = tables.find(t => t.querySelector('td.invoice-key')) || tables[0];
      if (!target) return { chaves: [], numeros: [], footerText: '' };

      const chaves  = Array.from(target.querySelectorAll('td.invoice-key')).map(el => el.textContent.trim());
      const numeros = Array.from(target.querySelectorAll('td.invoice-number')).map(el => el.textContent.trim());
      const footer  = target.querySelector('td.vue-footer');
      return { chaves, numeros, footerText: footer ? footer.textContent.trim() : '' };
    });

    for (let i = 0; i < chaves.length; i++) {
      const chave  = chaves[i];
      const numero = numeros[i] ?? '';

      if (!chave) continue;

      if (!/^\d{44}$/.test(chave)) {
        throw new Error(`RPA_ERROR: Chave NF-e inválida na linha ${i + 1}: "${chave}"`);
      }
      if (!/^\d+$/.test(numero)) {
        throw new Error(`RPA_ERROR: Número de NF inválido na linha ${i + 1}: "${numero}"`);
      }

      todasNFs.push({ chave, numero });
    }

    const m = footerText.match(/Exibindo\s+\d+\s+-\s+(\d+)\s+de\s+(\d+)/);
    const exibindoAte = m ? parseInt(m[1]) : 0;
    const total       = m ? parseInt(m[2]) : 0;

    if (exibindoAte >= total || total === 0) break;

    // clica no botão de próxima página via JS (funciona mesmo se elemento for hidden para Playwright)
    const clicou = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('#resource_invoices_table'));
      const target = tables.find(t => t.querySelector('td.invoice-key')) || tables[0];
      if (!target) return false;
      const btn = target.querySelector('.vue-footer [aria-label="Next"], .vue-footer button');
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    });

    if (!clicou) break;
    await page.waitForTimeout(1000);
    pagina++;
  }

  console.log(`[NOTAS] ${todasNFs.length} nota(s) fiscal(is) capturada(s).`);
  return todasNFs;
}

async function criarNovoFrete(page, dados) {
  await navegarNovoFreteNormal(page);

  for (const nota of dados.notas) {
    await importarChaveNFe(page, nota.chave_nfe);
  }

  await preencherDadosFrete(page, {
    tipo_veiculo: dados.tipo_veiculo,
    nr_referencia: dados.nr_referencia,
    classificacao: dados.classificacao
  });

  const rascunho = await salvarComoRascunhoECapturarId(page);

  const notasFiscais = await capturarNotasFiscais(page);

  return {
    id_cte: rascunho.id_cte,
    url: rascunho.url,
    grupo: dados.grupo,
    chaves_nfe: dados.notas.map(nota => nota.chave_nfe),
    notas_fiscais: notasFiscais
  };
}


async function lerNumeroCte(page) {
  const locator = page.locator(
    'div.col-sm-3.lbl-sm.margin-top span.caption-helper.font-dark:not(.bold)'
  ).first();

  for (let tentativa = 1; tentativa <= 5; tentativa++) {
    try {
      const texto = await locator.textContent({ timeout: 5000 });
      const valor = texto?.trim();
      console.log(`[EMISSAO] CT-e lido (tentativa ${tentativa}): "${valor}"`);

      if (valor && valor !== 'Pendente' && /\d/.test(valor)) {
        return valor.split(' ')[0]; // "2782 - Autorizado" → "2782"
      }
    } catch {}

    if (tentativa < 5) {
      console.log(`[EMISSAO] Ainda pendente — aguardando 5s e recarregando...`);
      await page.waitForTimeout(5000);
      await page.reload({ waitUntil: 'networkidle', timeout: CONFIG.timeouts.navigation });
    }
  }

  throw new Error('CT-e não emitido após 5 tentativas de recarga.');
}

async function emitirCTePorId(page, cte) {
  await retry(async () => {
    await page.goto(cte.url, {
      waitUntil: 'networkidle',
      timeout: CONFIG.timeouts.navigation
    });
    if (page.url().includes('/login') || page.url().includes('/users/sign_in')) {
      throw new Error('Sessão expirada ao tentar emitir CTe.');
    }
  }, CONFIG.retries, `abrir CTe ${cte.id_cte}`);

  // idempotência: verifica se já foi emitido
  try {
    const locator = page.locator(
      'div.col-sm-3.lbl-sm.margin-top span.caption-helper.font-dark:not(.bold)'
    ).first();
    const texto = await locator.textContent({ timeout: 3000 });
    const valor = texto?.trim();
    if (valor && valor !== 'Pendente' && /\d/.test(valor)) {
      const numero = valor.split(' ')[0];
      console.log(`[EMISSAO] CT-e já emitido: ${numero}`);
      return { id_cte: cte.id_cte, numero_cte: numero, grupo: cte.grupo, chaves_nfe: cte.chaves_nfe, notas_fiscais: cte.notas_fiscais };
    }
  } catch {}

  // abre menu "Ações" e clica em "Emitir CT-e"
  await retry(async () => {
    const acoesBtn = page.locator('.page-footer button:has-text("Ações"), button.btn:has-text("Ações")').last();
    await expect(acoesBtn).toBeVisible({ timeout: CONFIG.timeouts.element });
    await acoesBtn.click();

    const emitirItem = page.locator('button:has-text("Emitir CT-e")');
    await expect(emitirItem).toBeVisible({ timeout: 5000 });
    await emitirItem.click();

    console.log('[EMISSAO] Clique em "Emitir CT-e" realizado.');
  }, CONFIG.retries, `emitir CTe ${cte.id_cte}`);

  // aguarda processamento e recarrega
  await page.waitForTimeout(2000);
  await page.reload({ waitUntil: 'networkidle', timeout: CONFIG.timeouts.navigation });

  const numeroCte = await lerNumeroCte(page);

  console.log(`[EMISSAO] CT-e ${cte.id_cte} emitido com número: ${numeroCte}`);

  return {
    id_cte: cte.id_cte,
    numero_cte: numeroCte,
    grupo: cte.grupo,
    chaves_nfe: cte.chaves_nfe,
    notas_fiscais: cte.notas_fiscais
  };
}

function construirSaida(input, retorno) {
  const rateioNecessario = retorno.ctes_rateio.length > 0;

  const notasSaida = (input?.notas_mercadoria || []).map(nota => {
    const chave = String(nota.chave_nfe).replace(/\D/g, '');

    const cteEmitido  = retorno.ctes_emitidos.find(c => c.chaves_nfe?.includes(chave));
    const cteRateio   = retorno.ctes_rateio.find(c => c.chaves_nfe?.includes(chave));
    const cteRascunho = retorno.ctes_rascunhados.find(c => c.chaves_nfe?.includes(chave));
    const cte = cteEmitido || cteRateio || cteRascunho;

    const item = {
      chave_nfe: nota.chave_nfe,
      grupo:     nota.grupo || nota.cliente || nota.destinatario || null,
      id_frete:  cte?.id_cte || null,
      url:       cte?.url || null
    };

    if (cteEmitido) item.numero_cte = cteEmitido.numero_cte;

    return item;
  });

  const saida = {
    sucesso:           retorno.sucesso,
    oc:                retorno.oc,
    nr_referencia:     input?.nr_referencia || input?.oc || null,
    tipo_veiculo:      input?.tipo_veiculo || null,
    classificacao:     input?.classificacao || null,
    rateio_necessario: rateioNecessario,
    notas_mercadoria:  notasSaida
  };

  if (retorno.motivo)          saida.motivo          = retorno.motivo;
  if (retorno.codigo_erro)     saida.codigo_erro     = retorno.codigo_erro;
  if (retorno.screenshot_erro) saida.screenshot_erro = retorno.screenshot_erro;

  return saida;
}

async function executarEmissaoCTe(input) {
  const retorno = {
    sucesso: false,
    oc: input?.oc || null,
    ctes_rascunhados: [],
    ctes_emitidos: [],
    ctes_rateio: [],
    erros: []
  };

  let browser;
  let page;

  try {
    validarInput(input);

    const grupos = agruparNotasPorCliente(input.notas_mercadoria);

    browser = await chromium.launch({
      headless: CONFIG.headless
    });

    let tentativa = 0;

    while (tentativa < 2) {
      tentativa++;
      try {
        const sessao = await getAuthenticatedPage(browser);
        page = sessao.page;

        page.on('response', response => {
          if (response.status() >= 400) {
            console.error(`[HTTP ERROR] ${response.status()} - ${response.url()}`);
          }
        });

        for (const grupo of grupos) {
          const rascunho = await criarNovoFrete(page, {
            oc: input.oc,
            grupo: grupo.grupo,
            notas: grupo.notas,
            tipo_veiculo: input.tipo_veiculo,
            classificacao: input.classificacao,
            nr_referencia: input.nr_referencia || input.oc
          });

          retorno.ctes_rascunhados.push(rascunho);
        }

        break;

      } catch (e) {
        if (tentativa === 1 && eErrosDeSessao(e.message, page)) {
          console.warn('[SESSION] Sessão inválida — limpando e retentando...');
          retorno.ctes_rascunhados = [];
          await limparSessao();
          continue;
        }
        throw e;
      }
    }

    const emissaoSimples =
      retorno.ctes_rascunhados.length === 1 &&
      retorno.ctes_rascunhados[0].chaves_nfe.length === 1;

    for (const cte of retorno.ctes_rascunhados) {
      if (emissaoSimples) {
        const emitido = await emitirCTePorId(page, cte);
        retorno.ctes_emitidos.push(emitido);
      } else {
        console.log(`[RATEIO] CTe ${cte.id_cte} (${cte.grupo}) → rateio necessário.`);
        retorno.ctes_rateio.push({
          id_cte: cte.id_cte,
          url: cte.url,
          grupo: cte.grupo,
          chaves_nfe: cte.chaves_nfe,
          notas_fiscais: cte.notas_fiscais,
          motivo: 'rateio_necessario'
        });
      }
    }

    retorno.sucesso = true;
    retorno.motivo = 'Processamento concluído.';

    return construirSaida(input, retorno);

  } catch (error) {
    const screenshot = page
      ? await tirarScreenshot(page, 'erro_fatal')
      : null;

    retorno.sucesso = false;
    retorno.codigo_erro = 'ERRO_FATAL';
    retorno.motivo = error.message;
    retorno.screenshot_erro = screenshot;

    return construirSaida(input, retorno);

  } finally {
    // Se quiser fechar o navegador ao final, descomente:
    // if (browser) await browser.close();
  }
}

module.exports = {
  executarEmissaoCTe
};
