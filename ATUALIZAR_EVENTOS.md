# Bloodline BI v2.2.5 — Eventos e inscrições

## Envio dos arquivos ao GitHub

Envie os quatro arquivos do ZIP de atualização preservando a estrutura:

- `server.py` → raiz do repositório
- `static/app.js` → pasta `static/`
- `static/index.html` → pasta `static/`
- `static/style.css` → pasta `static/`

No Railway, confira **Deploy Latest Commit** (quando necessário). Acesse o site, faça Ctrl+Shift+R e entre em **Administração → Eventos e inscrições**.

## O que foi adicionado

- Criar e editar evento: data brasileira DD/MM/AAAA, nome, season e EP.
- Visualizar eventos cadastrados e seus totais.
- Vincular jogadores existentes e suas tribos a um evento (sem duplicar jogador no mesmo evento).
- Atualizar a tribo de um inscrito.
- Indicadores independentes de check-in, pagamento e decklist aprovada; por padrão ficam pendentes.
- Remover uma inscrição criada por engano, sem excluir jogador nem partidas.
- Dados persistem no mesmo SQLite (`/data/bloodline.db` no Railway).
- Disponível apenas para administradores autenticados.

**Importante:** a administração de eventos é somente organizacional nesta etapa. Inscrições e indicadores não alteram ranking, pontos, decklists nem resultados. Pareamento e aba pública de inscrição são etapas futuras.

**Atualização segura:** não substitua nem reenvie `bloodline.db`; as duas novas tabelas são criadas ao iniciar a aplicação, mantendo as tabelas anteriores. O pacote não contém banco de dados.

**Cuidado:** sem backups pagos no Railway, mantenha ao menos cópias locais independentes dos resultados que exportar.
