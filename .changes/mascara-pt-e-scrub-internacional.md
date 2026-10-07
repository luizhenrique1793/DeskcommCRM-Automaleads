---
impacto: nada_mudou
secao: corrigido
titulo: A máscara de PII de Portugal cobre as formas reais, e o scrub não desfigura número internacional
---

A máscara do perfil de Portugal só via o NIF em nove dígitos colados e o código postal com hífen: NIF com prefixo `PT` ou separado (`123 456 789`), IBAN (`PT50 …`) e o telefone `+351` passavam na ingestão para o RAG. Agora a máscara cobre essas formas — com o telefone ANTES do NIF, para não comer o miolo do número, e com o NIF deixando o CPF separado para o padrão brasileiro. E no scrub da telemetria (que o Jev usa) o número internacional deixa de sair como `+[CPF]8` e o NIF/telemóvel em três blocos deixa de passar; o CPF separado continua saindo inteiro, como antes.

O telefone brasileiro (+55) sai exatamente como antes.

Crédito: @Tong-bit-art.
