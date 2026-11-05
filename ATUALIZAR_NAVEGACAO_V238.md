# Bloodline BI — ajuste de navegação v2.3.8

Mudança pontual sobre a v2.3.7: clicar normalmente no cartão de um evento, na agenda da administração, abre os detalhes **na aba atual**, usando `#/admin/events/ID`.

A navegação continua por link HTML real: botão direito > Abrir em nova aba continua disponível, assim como Voltar, Avançar, F5 e link direto.

## Publicar no GitHub

1. No repositório, abra `static/app.js`.
2. Substitua o conteúdo pelo `app.js` fornecido na pasta `static` do ZIP reduzido, fazendo commit.
3. No Railway, confira o deploy do último commit com sucesso.
4. No BI, pressione Ctrl+Shift+R e teste clicando no cartão de um evento da agenda.

**Não é necessário modificar** `server.py`, `index.html`, `style.css` ou `bloodline.db`.

Esta atualização altera apenas um atributo de link, não as inscrições, pareamentos ou resultados.
