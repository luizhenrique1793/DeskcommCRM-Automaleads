---
impacto: capacidade_nova
secao: corrigido
titulo: O token com "gerente" e "administrador" marcados passa a valer como administrador
---

Em **Configurações › API Tokens**, quem marcava as duas caixas, "Tratar o token como gerente" e "Tratar o token como administrador", podia receber um token que valia só como gerente. O papel saía do primeiro `role:` da lista de escopos, e a tela grava os escopos na ordem em que as caixas são clicadas. Quem clicava em gerente antes de administrador, a ordem natural de cima para baixo, ficava com um token de gerente: nas portas que exigem administrador, como editar, testar e publicar o agente de IA por token (`config:write`), a chamada voltava `403 forbidden_role` com _"Role 'manager' insufficient (required: 'admin')"_, mesmo com a caixa de administrador marcada. Quem clicava na ordem inversa já recebia um token de administrador.

Agora vale o maior papel marcado, em qualquer ordem. Token sem papel continua valendo como atendente (`agent`), como antes, e um token marcado só como leitor (`role:viewer`) continua leitor: o conserto não sobe o papel de ninguém além do que a própria tela concedeu.

Um token que já existe com as duas caixas marcadas **pode** passar a agir como administrador depois da atualização: só muda o que teve a caixa de gerente marcada antes da de administrador, e a ordem aparece na lista de permissões do token na tela. Era isso que a caixa de administrador prometia. Se não era essa a intenção, revogue o token e crie outro só com "gerente". Tokens sem a caixa de administrador não mudam.
