# Bloodline BI v2.2.3 — importar banco antigo sem PowerShell

A versão v2.2.3 permite importar o `bloodline.db` pelo painel do site, sem instalar Python, Node ou Railway CLI no computador.

## Antes da atualização

- Confirme que seu BI **já está online e funcionando** no Railway com volume persistente montado em `/data`.
- **Não apague o projeto Railway** e **não altere o volume**. A atualização modifica apenas os arquivos do aplicativo; o banco atual continua salvo no volume.
- Se você configurou `BLOODLINE_IMPORT_DB` anteriormente, **remova essa variável** antes de atualizar. Ela pertence ao procedimento antigo por linha de comando.
- Guarde uma cópia do `bloodline.db` antigo em seu computador.

## Enviar a atualização ao GitHub pelo navegador

O pacote `ATUALIZACAO_SOMENTE_3_ARQUIVOS_v2.2.3.zip` contém os únicos três arquivos que você precisa substituir no seu repositório GitHub:

1. Na página principal do repositório, abra **Add file > Upload files** e envie o novo `server.py` do ZIP. Confirme em **Commit changes**. Substitua o arquivo anterior se o GitHub pedir confirmação.
2. Dentro da pasta `static` do repositório, use **Add file > Upload files** e envie os arquivos `app.js` e `index.html` que estão na pasta `static` do ZIP. Confirme em **Commit changes**.
3. Volte ao Railway > serviço Bloodline > **Deployments**. Em geral, cada commit na branch conectada inicia um deploy automaticamente. Aguarde o deploy terminar antes de fazer a importação.

**Alternativa:** faça upload de todos os arquivos extraídos do ZIP `Bloodline_50tinha_GitHub_Railway_v2.2.3.zip`, mantendo as pastas originais. Nunca envie `bloodline.db` ao GitHub.

## Importar o banco sem comandos

1. **Feche a versão antiga do Bloodline em execução no Windows**, se ainda estiver aberta. Isso evita copiar um banco incompleto caso o SQLite esteja usando arquivos auxiliares.
2. No navegador, abra o endereço público do site que já funciona.
3. Entre na **Administração** com a **conta principal** (`owner`). Outros administradores não podem fazer esta operação.
4. Acesse **Importar / exportar > Importar banco antigo (.db)**.
5. Clique em **Escolher arquivo** e selecione o `bloodline.db` da instalação antiga com os resultados.
6. Clique em **Importar dados do campeonato**, confirme e aguarde o relatório na tela.
7. Confira **ranking, jogadores, decks, mesas, tribos bloqueadas e administradores**. A importação usa o banco ONLINE como destino; nunca substitui esse arquivo.

## Proteções da importação

- **Backups automáticos** no volume Railway, na pasta `/data/backups/`.
- Importação por combinação de nomes/identificadores de referência, preservando os administradores online.
- Se um resultado já existe com os mesmos dados, não é duplicado.
- Se houver conflito de resultados, a transação de importação é cancelada e os dados online permanecem intactos.
- O arquivo enviado é recebido temporariamente pelo servidor via HTTPS e é apagado após a importação. Não passa pelo repositório GitHub.
- Tamanho máximo do arquivo enviado: **64 MB**. Para bancos maiores, use a ferramenta de migração anterior.

## Caso o botão não apareça

- Confira se o novo deploy terminou e a página foi atualizada com **Ctrl + F5**.
- O botão aparece apenas para a **conta principal**, não para administradores comuns.
- Confira se `server.py`, `static/app.js` e `static/index.html` foram todos atualizados no GitHub na mesma versão.

## Importante

Evite enviar um `bloodline.db` do computador enquanto o servidor local estiver funcionando, pois dados mais recentes podem estar no arquivo auxiliar SQLite `-wal`. Faça o upload depois de encerrar a versão antiga. Caso os dados não apareçam na origem, procure o backup local mais recente.
