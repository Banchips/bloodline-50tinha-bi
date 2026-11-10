# Bloodline 50tinha BI — atualização v2.4.2

## Mesas para aprovar

A área de moderação agora deixa **todas as mesas pendentes** visíveis logo no início.
Os registros **já analisados**, aprovados ou rejeitados, ficam em **Histórico de mesas**, uma caixa retrátil fechada inicialmente.
Ambas as seções exibem a quantidade de mesas. A contagem pendente na aba principal permanece.

Os botões **Aprovar**, **Rejeitar** e **Excluir mesa** continuam funcionando como antes.
O histórico não é apagado ou modificado, apenas reorganizado na interface.

## Atualizar GitHub + Railway

Envie os três arquivos a seguir no repositório atual:

- `static/index.html`
- `static/app.js`
- `static/style.css`

Confirme o deploy no Railway e force a atualização do site com Ctrl + Shift + R.
**Não substitua `server.py` nem `bloodline.db`.** Nenhuma alteração no banco ou no servidor é necessária.

## Teste recomendado

1. Acesse Administração > Mesas para aprovar.
2. Confira se as pendências estão fora do histórico.
3. Expanda e recolha o histórico; veja as mesas aprovadas e rejeitadas.
4. Aprove uma mesa pendente: ela deve sair da lista principal e entrar no histórico.
5. Confira os pontos no ranking como antes.
