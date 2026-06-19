const { executarEmissaoCTe } = require('./emissao');

const input = {
  oc: '52170642',          // <<< ajuste o número da OC
  nr_referencia: '52170642',
  tipo_veiculo: 'CARRETA',        // <<< ajuste para o label exato do select
  classificacao: 'TRANSFERENCIA',

  notas_mercadoria: [
    {
      chave_nfe: '31260606042467001900550910001210121163973011',
      grupo: 'BAGLEY DO BRASIL ALIMENTOS LTDA'
    },
    {
      chave_nfe: '31260654360656003089550910001580551163973025',
      grupo: 'ARCOR DO BRASIL LTDA'
    }
  ]
};

(async () => {
  console.log('Iniciando emissão de CTe...\n');
  const resultado = await executarEmissaoCTe(input);
  console.log('\nResultado:');
  console.log(JSON.stringify(resultado, null, 2));
})();
