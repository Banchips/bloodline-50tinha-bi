#!/usr/bin/env python3
"""Importa dados de um banco Bloodline antigo, sem substituir admins do banco atual.

Uso: py -3 recuperar_banco.py "C:\\PastaAntiga\\bloodline.db"
Sem argumento: tenta abrir seletor de arquivo; se indisponível, pede caminho.
Não execute enquanto o BI estiver aberto em qualquer servidor.
"""
import argparse
from contextlib import closing
from datetime import datetime
from pathlib import Path
import socket
import sqlite3
import sys

import server

TABLES_REQUIRED = ('seasons', 'players', 'tribes', 'matches')


class RecoveryError(Exception):
    pass


def _count(db, table):
    return db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]


def _exists_table(db, table):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


def _rows(db, table):
    if not _exists_table(db, table):
        return []
    return [dict(r) for r in db.execute(f'SELECT * FROM {table} ORDER BY id')]


def _open_readonly(path):
    uri = path.resolve().as_uri() + '?mode=ro'
    db = sqlite3.connect(uri, uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    return db


def _backup(source, path):
    # API SQLite Backup captura também as transações confirmadas no WAL.
    with sqlite3.connect(path) as output:
        source.backup(output)
    return path


def _get_old_file():
    try:
        from tkinter import Tk, filedialog
        root = Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        selection = filedialog.askopenfilename(
            title='Selecione o bloodline.db ANTIGO (com os resultados)',
            filetypes=[('Bancos SQLite', '*.db'), ('Todos os arquivos', '*.*')])
        root.destroy()
        if selection:
            return Path(selection)
    except Exception:
        pass
    typed = input('Caminho completo do banco antigo (.db): ').strip().strip('"')
    return Path(typed) if typed else None


def _make_maps(src, dest, table):
    mapping = {}
    rows = _rows(src, table)
    for old in rows:
        name = old['name']
        match = dest.execute(f'SELECT id FROM {table} WHERE name=? COLLATE NOCASE', (name,)).fetchone()
        if match:
            new_id = match['id']
        else:
            if table == 'seasons':
                new_id = dest.execute('INSERT INTO seasons(name,sort_order) VALUES (?,?)',
                                      (name, old.get('sort_order', 1))).lastrowid
            else:
                new_id = dest.execute(f'INSERT INTO {table}(name) VALUES (?)', (name,)).lastrowid
        mapping[old['id']] = new_id
    return mapping


def _game_signature(db, table_id):
    return sorted((r['player_id'], r['tribe_id'], r['result']) for r in db.execute(
        'SELECT player_id, tribe_id, result FROM game_table_entries WHERE table_id=?', (table_id,)))


def import_into(source, dest):
    """Import transaction (caller must own it); refs remapped by natural keys.

    Source is validated separately before this function.
    """
    details = {'seasons': 0, 'players': 0, 'tribes': 0,
               'decks': 0, 'game_tables': 0, 'matches': 0, 'exclusions': 0,
               'duplicates': 0}
    maps = {}
    for table in ('seasons', 'players', 'tribes'):
        before = _count(dest, table)
        maps[table] = _make_maps(source, dest, table)
        details[table] = _count(dest, table) - before
    sid = maps['seasons']; pid = maps['players']; tid = maps['tribes']

    if _exists_table(source, 'exclusions'):
        for rec in source.execute('SELECT * FROM exclusions'):
            if rec['season_id'] not in sid or rec['tribe_id'] not in tid:
                raise RecoveryError('Bloqueio de tribo com referência inválida no banco antigo.')
            before = dest.total_changes
            dest.execute('INSERT OR IGNORE INTO exclusions(season_id,tribe_id) VALUES (?,?)',
                         (sid[rec['season_id']], tid[rec['tribe_id']]))
            details['exclusions'] += dest.total_changes - before

    deckmap = {}
    for rec in _rows(source, 'decks'):
        p = pid[rec['player_id']]; t = tid[rec['tribe_id']]
        # Deck é uma entidade distinta; nome e link exatos evitam sobrescrever atualizações.
        existing = dest.execute('''SELECT id FROM decks WHERE player_id=? AND tribe_id=?
              AND name=? AND url=?''', (p, t, rec['name'], rec['url'])).fetchone()
        if existing:
            deckmap[rec['id']] = existing['id']; details['duplicates'] += 1
        else:
            deckmap[rec['id']] = dest.execute('''INSERT INTO decks
                 (player_id,tribe_id,name,url,edit_token_hash,created_at,updated_at)
                 VALUES (?,?,?,?,?,?,?)''',
                 (p, t, rec['name'], rec['url'], rec['edit_token_hash'],
                  rec.get('created_at') or datetime.now().isoformat(),
                  rec.get('updated_at') or datetime.now().isoformat())).lastrowid
            details['decks'] += 1

    tablemap = {}
    for rec in _rows(source, 'game_tables'):
        s = sid[rec['season_id']]
        old_entries = [dict(r) for r in source.execute('SELECT * FROM game_table_entries WHERE table_id=?', (rec['id'],))]
        new_signature = sorted((pid[x['player_id']],tid[x['tribe_id']],x['result']) for x in old_entries)
        options = dest.execute('''SELECT id,status FROM game_tables WHERE season_id=?
           AND event_date=? AND episode=? AND round_no=? AND table_no=?''',
           (s, rec['event_date'], rec['episode'], rec['round_no'], rec['table_no'])).fetchall()
        same = next((opt for opt in options if opt['status'] == rec['status'] and
                     _game_signature(dest, opt['id']) == new_signature), None)
        if same:
            tablemap[rec['id']] = same['id']; details['duplicates'] += 1
            continue
        # Do not silently import conflicting approved/pending tables.
        if any(x['status'] in ('pending','approved') and rec['status'] in ('pending','approved') for x in options):
            raise RecoveryError('Mesa em conflito: temporada {}, episódio {}, rodada {}, mesa {}. '
                                'O banco atual e o antigo têm resultados diferentes; nenhuma alteração foi aplicada.'
                                .format(rec['season_id'], rec['episode'], rec['round_no'], rec['table_no']))
        cursor = dest.execute('''INSERT INTO game_tables
          (season_id,event_date,episode,round_no,table_no,status,submitted_by,created_at,reviewed_at,admin_note)
          VALUES(?,?,?,?,?,?,?,?,?,?)''',
          (s,rec['event_date'],rec['episode'],rec['round_no'],rec['table_no'],
           rec['status'], pid.get(rec.get('submitted_by')) if rec.get('submitted_by') else None,
           rec.get('created_at') or datetime.now().isoformat(), rec.get('reviewed_at'), rec.get('admin_note') or ''))
        nt = cursor.lastrowid
        tablemap[rec['id']] = nt
        for x in old_entries:
            dest.execute('''INSERT INTO game_table_entries(table_id,player_id,tribe_id,deck_id,result)
               VALUES(?,?,?,?,?)''',
               (nt,pid[x['player_id']],tid[x['tribe_id']],deckmap.get(x.get('deck_id')),x['result']))
        details['game_tables'] += 1

    for rec in _rows(source, 'matches'):
        s = sid[rec['season_id']]; p = pid[rec['player_id']]; t = tid[rec['tribe_id']]
        result = 'V' if rec['result'] == 'C' else rec['result']
        new_table_id = tablemap.get(rec.get('table_id'))
        new_deck_id = deckmap.get(rec.get('deck_id'))
        existing = dest.execute('''SELECT id,tribe_id,result,table_id,deck_id FROM matches
            WHERE season_id=? AND event_date=? AND episode=? AND round_no=? AND player_id=?''',
            (s,rec['event_date'],rec['episode'],rec['round_no'],p)).fetchone()
        if existing:
            # If existing result agrees, keep destination, including its deck link.
            if existing['tribe_id'] != t or existing['result'] != result:
                raise RecoveryError('Resultado em conflito: jogador {}, data {}, episódio {}, rodada {}. '
                                    'Dados antigos e atuais diferentes; importação cancelada sem alterar dados.'
                                    .format(rec['player_id'],rec['event_date'],rec['episode'],rec['round_no']))
            details['duplicates'] += 1
            continue
        dest.execute('''INSERT INTO matches(season_id,event_date,episode,round_no,player_id,tribe_id,
           result,points_override,table_id,deck_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
           (s,rec['event_date'],rec['episode'],rec['round_no'],p,t,result,None,
            new_table_id,new_deck_id,rec.get('created_at') or datetime.now().isoformat()))
        details['matches'] += 1
    return details


def migrate(source_file, dest_file=None, backups_dir=None):
    source_file = Path(source_file).expanduser().resolve()
    dest_file = Path(dest_file or server.DB_PATH).expanduser().resolve()
    backups_dir = Path(backups_dir or (dest_file.parent / 'backups')).resolve()
    if not source_file.is_file():
        raise RecoveryError(f'Arquivo de origem não encontrado: {source_file}')
    if source_file == dest_file:
        raise RecoveryError('O banco antigo e o atual são o mesmo arquivo. Selecione o banco da pasta ANTIGA.')
    if dest_file.exists() and source_file.samefile(dest_file):
        raise RecoveryError('O banco antigo e o atual apontam para o mesmo arquivo.')

    with closing(_open_readonly(source_file)) as source:
        if source.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise RecoveryError('O banco antigo falhou na verificação de integridade.')
        missing = [name for name in TABLES_REQUIRED if not _exists_table(source, name)]
        if missing:
            raise RecoveryError('O arquivo selecionado não parece ser um banco Bloodline válido. '
                                'Tabelas ausentes: ' + ', '.join(missing))
        source_stats = {name: _count(source, name) for name in TABLES_REQUIRED}
        for name in ('decks','game_tables'):
            source_stats[name] = _count(source,name) if _exists_table(source,name) else 0
        if not any(source_stats[x] for x in ('players','matches','decks','game_tables')):
            raise RecoveryError('O banco antigo está vazio (sem jogadores, partidas, decks ou mesas). '
                                'Nenhum dado foi importado. Procure outra cópia do bloodline.db.')

        # Snapshot validado da origem, inclusive páginas do WAL.
        backups_dir.mkdir(parents=True,exist_ok=True)
        stamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
        source_snapshot = backups_dir / f'banco_antigo_copia_{stamp}.db'
        _backup(source,source_snapshot)

    dest_file.parent.mkdir(parents=True, exist_ok=True)
    old_db_path = server.DB_PATH
    try:
        server.DB_PATH = dest_file
        if dest_file.exists():
            with closing(sqlite3.connect(dest_file,timeout=20)) as dest_conn:
                dest_backup = backups_dir / f'banco_atual_antes_importacao_{stamp}.db'
                _backup(dest_conn,dest_backup)
        else:
            dest_backup = None
        server.init_db()
        with closing(_open_readonly(source_snapshot)) as source, server.conn_db() as dest:
            details = import_into(source,dest)
        with server.conn_db() as dest:
            after = {table: _count(dest,table) for table in TABLES_REQUIRED}
            admins = _count(dest,'admins')
        return {'source_counts':source_stats,'inserted':details,'dest_counts':after,
                'admins_preserved':admins,'backup':dest_backup,'source_snapshot':source_snapshot}
    finally:
        server.DB_PATH = old_db_path


def main():
    parser = argparse.ArgumentParser(description='Recupera dados antigos sem apagar contas de administradores.')
    parser.add_argument('source', nargs='?', help='Caminho do banco antigo (bloodline.db)')
    args = parser.parse_args()
    try:
        # Porta usada no launcher. Se estiver ocupada, pedir encerramento do sistema.
        with socket.socket() as sock:
            sock.settimeout(0.3)
            if sock.connect_ex(('127.0.0.1', 8000)) == 0:
                raise RecoveryError('Há um serviço na porta 8000. Feche a janela do servidor '
                                    'Bloodline antes da recuperação e tente novamente.')
        chosen = Path(args.source.strip('"')) if args.source else _get_old_file()
        if not chosen:
            print('Operação cancelada. Nenhum arquivo foi alterado.')
            return 1
        result = migrate(chosen)
        print('\nRECUPERAÇÃO CONCLUÍDA!')
        print('Origem:', chosen)
        print('Registros encontrados no banco antigo:', result['source_counts'])
        print('Importados:', result['inserted'])
        print('Total no banco atual:', result['dest_counts'])
        print('Contas administrativas preservadas:', result['admins_preserved'])
        print('Cópia protegida do banco antigo:', result['source_snapshot'])
        if result['backup']:
            print('Backup do banco atual antes de importar:', result['backup'])
        if not result['admins_preserved']:
            print('\nIMPORTANTE: o banco atual não possui nenhuma conta. '\
                  'Ao executar run_windows.bat, crie o administrador principal.')
        print('\nAgora execute run_windows.bat e confira o ranking e a aba Acessos.')
        return 0
    except (RecoveryError, sqlite3.Error, KeyError, ValueError) as exc:
        print('\nRECUPERAÇÃO NÃO CONCLUÍDA:',exc)
        print('Confira se fechou os servidores e selecionou o banco da pasta antiga.')
        return 1


if __name__ == '__main__':
    sys.exit(main())
