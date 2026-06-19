require('dotenv').config();

const http = require('http');
const { executarEmissaoCTe } = require('./emissao');

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/emitir') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ erro: 'Rota não encontrada. Use POST /emitir' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let input;
    try {
      input = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ erro: 'Body inválido. Envie JSON.' }));
      return;
    }

    console.log(`[SERVER] Nova requisição — OC: ${input?.oc}`);

    try {
      const resultado = await executarEmissaoCTe(input);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resultado));
    } catch (err) {
      console.error(`[SERVER] Erro fatal: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sucesso: false, erro: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[SERVER] Rodando na porta ${PORT}`);
  console.log(`[SERVER] Endpoint: POST http://localhost:${PORT}/emitir`);
});
