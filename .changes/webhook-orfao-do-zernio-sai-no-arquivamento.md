---
impacto: nada_mudou
secao: corrigido
titulo: Desconectar uma rede social apaga a assinatura de webhook que ficou órfã no provedor
---

Conectar uma rede social cria a assinatura no provedor e grava o id dela no canal só no fim; quando essa gravação falhava, o canal ficava `FAILED` com a assinatura viva lá fora e sem nenhuma referência a ela aqui. Desconectar então arquivava o canal e rotacionava o token do webhook, e a assinatura seguia mandando evento para uma URL que acabou de virar 404 — para sempre, sem erro na tela: o operador via a conta desconectada e o provedor reenviando. Agora, sem o id gravado, a assinatura é encontrada pela URL do próprio canal (o mesmo casamento que a conexão já faz, para não duplicar) e apagada antes do arquivamento. Quem tem o id gravado continua exatamente pelo caminho de antes, e uma falha do provedor segura a desconexão com a linha intacta para poder ser tentada de novo. Correção entregue no PR #2412, issue #2364.
