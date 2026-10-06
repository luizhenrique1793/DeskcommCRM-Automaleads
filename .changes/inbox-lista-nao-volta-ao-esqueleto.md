---
impacto: nada_mudou
secao: corrigido
titulo: A lista do inbox não volta ao esqueleto no meio da carga da Fila, nem some quando uma recarga falha
---

Quem abria a caixa de entrada via a lista de conversas aparecer, sumir e voltar como esqueletos: quando a leitura do atendimento automático respondia, a chave da busca da Fila mudava, a resposta que já tinha chegado era descartada e uma segunda requisição saía ~2 s depois — de 1 a 3 s de tela vazia a cada carga do inbox, medido no trace do #2360. Um refetch que falhava com a lista na tela também a apagava e trocava a tela cheia por "Erro ao carregar conversas". Agora, nessa troca (a mesma Fila, com a mesma busca e os mesmos filtros, só com a resposta do automático), a lista anterior fica visível até a nova chegar; uma recarga que falha deixa a lista onde está e o aviso de erro aparece sem destruir a tela; e a conversa aberta deixa de piscar junto. Trocar de aba ou de busca continua mostrando o esqueleto enquanto a lista nova carrega, para que nenhuma linha da aba anterior apareça como se fosse da nova. Nenhuma ação é necessária. Contribuição de @webtecnica (#2414).
