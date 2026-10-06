---
impacto: nada_mudou
secao: corrigido
titulo: A consulta de CNPJ volta a funcionar — a BrasilAPI recusava o cabeçalho padrão do Node
---

Em **Empresas**, o botão "Consultar CNPJ" respondia sempre _"Não foi possível consultar o CNPJ"_, com a dica de que seria um bloqueio temporário e que valia tentar mais tarde. Não era: quando o código não define o cabeçalho `User-Agent`, o Node manda `User-Agent: node` sozinho, e a borda que serve a BrasilAPI recusa esse valor. A consulta nunca funcionou em instalação nenhuma — não era o seu IP, nem limite de uso, nem indisponibilidade do serviço.

Medido contra o mesmo CNPJ, na mesma rodada: **recusa** (403 ou 429, conforme a medição) com `User-Agent: node`, sem o cabeçalho ou com ele vazio; **200** com o valor neutro que a consulta passa a mandar.

O conserto alcança os três caminhos que falam com a BrasilAPI: a consulta do cadastro de empresa, o enriquecimento automático de uma empresa já criada e a importação em lote. Quem recebia o erro pode repetir a consulta — o formulário volta a ser preenchido com razão social, nome fantasia, telefone e endereço completo. Se a BrasilAPI recusar uma consulta mesmo assim, a dica na tela deixa de prometer que é temporário e só diz o código e o que fazer.

O valor enviado é neutro e não leva o nome da marca: o cabeçalho sai para um terceiro, e uma instalação de marca própria não deve entregar o nome de quem a revende à BrasilAPI.

Crédito: @LeonardoMarcelo.
