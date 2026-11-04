> **Pacote de publicação v2.2.2:** mantém o sistema v2.2.1 e acrescenta inicialização na nuvem, volume persistente, migração e proteção para não publicar o banco. Leia [PUBLICAR_NO_GITHUB.md](PUBLICAR_NO_GITHUB.md).

# Bloodline 50tinha — BI da Liga (v2.2.1)

**VERSÃO v2.2.1 — ATENÇÃO À RECUPERAÇÃO:** não substitua o `bloodline.db` da v2.2 por outro banco enquanto utiliza o sistema. Para trazer dados antigos **sem apagar os administradores**, use `importar_banco_antigo.bat` após fechar o servidor e leia [RECUPERACAO_DE_DADOS.md](RECUPERACAO_DE_DADOS.md). São feitos backups em `backups/` antes de importar.

Sistema web em português com **painel público sem login**, **formulário de mesas preenchido pelos jogadores**, **decklists com edição protegida por chave** e **acesso individual para múltiplos administradores**. Usa SQLite e Python 3.10+, sem pacotes extras.

## Início rápido (Windows)

1. Instale **Python 3.10 ou superior**.
2. Extraia o ZIP inteiro, preservando a pasta `static`.
3. Execute `run_windows.bat`. **Somente na primeira execução**, crie seu **usuário e sua senha principal** na janela do terminal. A senha não fica visível enquanto é digitada e é salva com hash seguro no banco.
4. Abra **http://127.0.0.1:8000** no navegador.
5. Acesse **Administração > Jogadores e temporadas** para cadastrar a temporada atual, jogadores e tribos.
6. Acesse **Enviar mesa** para lançar resultados; use **Decklists** para registrar links de decks.

Em Linux/macOS, execute `python3 server.py` em um terminal interativo e siga as perguntas de primeiro acesso. **Depois de criado o administrador principal, o sistema não pede a senha no terminal novamente.** Ela é informada somente na tela de login. `python server.py --demo` gera dados *fictícios*, somente com banco vazio.

## Pontuação oficial

| Resultado | Pontos |
|---|---:|
| Vitória (V) | **3** |
| Empate (E) | **1** |
| Derrota (D) | **0** |

**Não há pontuação por combo nem pontos manuais.** Quando um banco antigo da v1 é aberto, os registros antigos `C` são transformados em `V` (3 pontos), e pontos personalizados antigos são desconsiderados. Confira o histórico antes de colocar o sistema em produção.

**Tribos bloqueadas:** em Administração > Tribos sem pontuação, marque os bloqueios **por temporada**. A participação permanece no histórico e conta para partidas jogadas, mas o jogador recebe **zero ponto válido** nessa temporada, inclusive se ganhou ou empatou. Resultados de outras temporadas não são alterados.

**Ranking oficial por jogador + tribo:** cada par forma uma inscrição independente, com posição, pontos, partidas e resultados **V / E / D** próprios. Se o Jogador Alfa fez 10 pontos com Robôs e 9 com Clérigos, ele aparece **duas vezes** (uma linha por tribo), em suas posições respectivas. Pontos de tribos distintas **nunca são somados para definir a colocação**. Os resultados de tribos bloqueadas continuam no histórico e contam como partidas, mas valem zero pontos válidos na temporada bloqueada. Decklists do mesmo jogador seguem reunidas em seu perfil.

Ranking: ordenação por pontos válidos, depois número de vitórias elegíveis, quantidade de partidas elegíveis e, por último, nome do jogador e nome da tribo. O ranking e o histórico exibem resultados **aprovados**. O desempate OMW%/OGW% ainda não está implementado.

## Como funciona a aba Enviar mesa

Os jogadores podem abrir a página **sem login** e preencher:

- **Temporada, EP do torneio, data, rodada e número da mesa**.
- **3 ou 4 retângulos**, um para cada participante, indicando jogador, deck (opcional), tribo e resultado.
- **Quem enviou**: seleciona um dos participantes; a escolha identifica o remetente, mas **não comprova sua identidade**.

Uma mesa é válida quando ocorre **exatamente uma vitória (V) e os demais recebem D**, ou **2, 3 ou 4 empates (E), com os demais recebendo D**. Não é permitido misturar vitória e empate na mesma mesa. Cada pessoa pode aparecer somente uma vez por mesa; mesas simultâneas na mesma rodada não podem repetir jogadores. Para evitar duplicação, cada número de mesa é único dentro da combinação temporada + data + EP + rodada.

**Moderação:** resultados enviados sem login ficam **pendentes**. O administrador confere em **Administração > Mesas para aprovar**, aprova ou rejeita. Somente a aprovação cria as participações que entram no ranking. O administrador pode lançar mesas diretamente (são aprovadas automaticamente), e pode excluir uma mesa inteira para corrigir o resultado; ele deve relançá-la após a exclusão. Ações públicas têm limites básicos de frequência para reduzir spam.

## Decklists e perfil de jogador

Em **Decklists**, escolha **Player**, **Tribo**, nome do deck e o **link HTTPS** da decklist (LigaMagic ou outra plataforma). O link aparece publicamente. No cadastro, a aplicação fornece uma **chave secreta de edição**. Ela é guardada no navegador usado para o cadastro e pode ser copiada e utilizada em outro navegador. **Guarde a chave**: não há recuperação automática por e-mail, porque não existem contas de jogador. Outra pessoa sem essa chave não consegue editar a decklist, salvo o administrador autenticado.

Ao editar, o jogador pode atualizar o nome e o link do próprio deck. **Jogador e tribo vinculados permanecem fixos**; cadastre um novo deck ao mudar de tribo. Por segurança, a identidade do proprietário *não* é verificada no cadastro inicial: por isso o formulário não deve ser tratado como comprovação oficial de autoria.

Clicando em qualquer linha jogador + tribo no ranking, o perfil unificado do jogador mostra suas tribos, **vitórias, partidas e pontos válidos por tribo**, além das **decklists, vitórias, partidas e pontos por deck**. Para os pontos específicos de um deck, é necessário selecioná-lo ao lançar a mesa (ou no lançamento manual administrativo). Resultados antigos importados por CSV, que não identificavam o deck, continuam somando normalmente para **jogador e tribo**, mas não são atribuídos retroativamente a um deck.

## Importação do histórico por CSV

Em **Administração > Importar/exportar**:

```csv
DATA;PLAYER;TRIBO;R1;R2;R3
12/02/2026;Jogador A;Robôs;V;D;E
```

Ou uma linha por participação:

```csv
TEMPORADA;DATA;EPISODIO;RODADA;JOGADOR;TRIBO;RESULTADO
S7;21/04/2026;EP 1;1;Jogador A;Robôs;V
```

Aceita separador `;`, `,` ou tabulação e arquivos UTF-8 ou Windows-1252. Utilize **somente `V/E/D` ou `3/1/0`**. Arquivos antigos com resultado `C` precisam ser revisados e convertidos para `V` antes de importar. Colunas auxiliares, como `TOTAL_DIA`, `Win%`, `OW1%` e `OW2%`, são ignoradas. Se existir uma coluna `PONTOS`, seu valor deve corresponder exatamente ao resultado (3, 1 ou 0); não é permitido sobrescrever a regra fixa.

A importação gera resultados individuais já válidos, não mesas completas; os adversários daquela rodada não podem ser reconstruídos automaticamente só com as colunas listadas. Evite importar os mesmos episódios e rodadas duas vezes; o sistema ignora registros repetidos por temporada/data/EP/rodada/jogador.

## Atualizar da v1/v2 para a v2.1

1. **Feche a versão anterior**, faça uma cópia de segurança do arquivo `bloodline.db` e, se possível, da pasta inteira.
2. Para preservar administradores e importar dados de outro banco, use `importar_banco_antigo.bat` na versão v2.2.1, com ambos os servidores fechados. Veja `RECUPERACAO_DE_DADOS.md`.
3. Execute a v2.1. Novas tabelas e campos serão criados automaticamente, sem descartar jogadores, partidas, temporadas ou bloqueios.
4. **Confira os registros antigos de combo e de pontos manuais**: passam a seguir V=3/E=1/D=0. A classificação será automaticamente separada por jogador + tribo, sem alterar ou duplicar registros no banco.
5. Somente então divulgue o endereço do sistema atualizado para a liga.

Se você **não tinha banco persistente** ou só usou o protótipo com dados fictícios, inicie com uma pasta sem `bloodline.db` e cadastre dados reais.

## Vários administradores (novo na v2.2)

Na versão 2.1 havia **uma única senha global**, digitada no terminal. A partir da versão 2.2, cada administrador tem **usuário próprio e senha própria**, persistidos no banco SQLite em forma de *hash PBKDF2-HMAC-SHA256 com salt individual* (não em texto puro). **Não existe senha padrão**. As senhas novas devem conter pelo menos 10 caracteres.

1. Ao executar o sistema **pela primeira vez**, informe o usuário principal (padrão sugerido `admin`) e uma senha forte no terminal. Cria-se a conta **Principal**. Na próxima execução, as credenciais já estarão no banco: não será necessário cadastrá-las novamente.
2. Abra **Administração**, informe **Usuário** e **Senha** e clique em Entrar.
3. Vá até **Administração > Acessos**. Como conta Principal, preencha **Criar administrador** para cadastrar quantas pessoas forem necessárias, cada uma com senha diferente.
4. Na mesma aba, a conta Principal pode **desativar/reativar** usuários e **redefinir a senha** de outros administradores. A desativação bloqueia o acesso imediatamente. Redefinir a senha encerra as sessões abertas daquela conta.
5. Cada administrador, inclusive a conta Principal, pode usar **Alterar minha senha**. A troca exige a senha atual e encerra outras sessões da mesma conta.

**Permissões:** administradores comuns podem gerenciar os resultados, mesas, jogadores, tribos, temporadas e importações como antes. **Somente a conta Principal** pode criar, desativar ou redefinir senhas de outros administradores. A própria conta Principal não pode ser desativada pela interface.

**Migração sem apagar dados:** feche a versão antiga e faça cópia do `bloodline.db`. Para *mesclar um banco antigo a um banco da v2.2 já utilizado*, use o programa `importar_banco_antigo.bat`, conforme `RECUPERACAO_DE_DADOS.md`; nunca substitua o banco da v2.2 com o sistema em funcionamento. Na primeira execução da v2.2, a estrutura do banco será ampliada automaticamente, preservando pontuação, jogadores, temporadas, mesas, tribos e decks. A conta Principal será criada no terminal, pois a senha antiga da v2.1 não fazia parte do banco. Caso a variável antiga `BLOODLINE_ADMIN_PASSWORD` ainda esteja definida no ambiente, a v2.2 poderá converter **uma única vez** essa senha em uma conta Principal chamada `admin`. Depois da conversão, a variável não será necessária.

**Se perder a senha da conta Principal:** com acesso ao computador e ao banco, feche o servidor, abra o terminal na pasta do projeto e execute `py -3 server.py --reset-owner-password` (Windows) ou `python3 server.py --reset-owner-password` (Linux/macOS). Informe o usuário principal e a nova senha. Esse procedimento encerra sessões anteriores da conta.

## Hospedagem e segurança

- Por padrão o servidor atende **só na própria máquina** (`127.0.0.1`). Para acessar de outros PCs na mesma rede use `python server.py --host 0.0.0.0`, liberando a porta no firewall conforme sua necessidade.
- **Não publique esse servidor HTTP simples diretamente na internet.** Para uso público da liga, hospede atrás de um **proxy HTTPS**/infraestrutura gerenciada, com backups e limitação de acesso. Configure `BLOODLINE_COOKIE_SECURE=1` quando o site estiver atrás de HTTPS.
- As senhas administrativas são armazenadas com hash PBKDF2-HMAC-SHA256, salt único e 480 mil iterações. As sessões ficam em cookies HttpOnly/SameSite=Strict, com duração de 12 horas, associadas a um administrador específico. Credenciais nunca são incluídas na resposta pública ou no `backup.json`.
- Pessoas não autenticadas conseguem **enviar resultados pendentes** e **cadastrar decklists**, portanto a moderação é essencial. Não confunda a escolha de um jogador com autenticação de identidade.
- O banco principal é `bloodline.db`. **Para preservar também as contas dos administradores**, faça backup desse arquivo com o servidor fechado. O backup JSON exporta resultados e decks, **não** as contas/senhas e não oferece restauração automática. A exportação JSON inclui hashes das chaves de edição de decks: proteja o arquivo.
- Sem integração automática com TopDeck.gg/Google Sheets, sem contas individuais de jogadores, sem recuperação de chave de edição por e-mail e sem cálculo de OMW%/OGW%.

## Arquivos

- `server.py` — API HTTP e banco SQLite.
- `static/index.html`, `static/app.js`, `static/style.css` — interface responsiva.
- `run_windows.bat` — execução no Windows, com configuração da conta principal no primeiro uso.
- `tests/test_admin_accounts.py` — testes de sessões, permissões, senhas e migração do banco.
- `exemplo_importacao.csv` — planilha demonstrativa, sem jogadores reais.

O sistema é um **aplicativo local funcional**, não uma hospedagem pública pronta. Faça testes com resultados fictícios antes de importar a planilha oficial da liga.
