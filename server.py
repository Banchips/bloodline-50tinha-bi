#!/usr/bin/env python3
"""Bloodline 50tinha BI — servidor sem dependencias externas (Python 3.10+)."""
import argparse
import csv
from contextlib import contextmanager, closing
import getpass
import hashlib
import hmac
import io
import json
import random
import os
import re
import secrets
import sys
import sqlite3
import tempfile
import threading
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv('BLOODLINE_DB', str(ROOT / 'bloodline.db'))).resolve()
LEGACY_BOOTSTRAP_PASSWORD = os.getenv('BLOODLINE_ADMIN_PASSWORD', '')
PASSWORD_ITERATIONS = 480_000
COOKIE_SECURE = os.getenv('BLOODLINE_COOKIE_SECURE', '0') == '1'
RULES = {'V': 3, 'E': 1, 'D': 0}
PUBLIC_ACTIONS = {}
PUBLIC_ACTIONS_LOCK = threading.Lock()
LOGIN_ATTEMPTS = {}
LOGIN_LOCK = threading.Lock()
DB_LOCK = threading.RLock()  # protect multi-step writes and sqlite locked issues

class UserInputError(Exception):
    pass


@contextmanager
def conn_db():
    db = sqlite3.connect(DB_PATH, timeout=20)
    try:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA busy_timeout=15000')
        with db:
            yield db
    finally:
        db.close()


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with conn_db() as db:
        db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS seasons (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS players (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS tribes (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS exclusions (
          season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
          tribe_id INTEGER NOT NULL REFERENCES tribes(id) ON DELETE CASCADE,
          PRIMARY KEY (season_id, tribe_id));
        CREATE TABLE IF NOT EXISTS matches (
          id INTEGER PRIMARY KEY,
          season_id INTEGER NOT NULL REFERENCES seasons(id),
          event_date TEXT NOT NULL,
          episode TEXT NOT NULL DEFAULT '',
          round_no INTEGER NOT NULL,
          player_id INTEGER NOT NULL REFERENCES players(id),
          tribe_id INTEGER NOT NULL REFERENCES tribes(id),
          result TEXT NOT NULL CHECK(result IN ('V','E','D','C')),
          points_override INTEGER CHECK(points_override IS NULL OR (points_override BETWEEN 0 AND 20)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS idx_matches_season ON matches(season_id);
        CREATE INDEX IF NOT EXISTS idx_matches_player ON matches(player_id);
        CREATE TABLE IF NOT EXISTS admins (
          id INTEGER PRIMARY KEY,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          password_iterations INTEGER NOT NULL,
          role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('owner','admin')),
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_login_at TEXT);
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS decks (
          id INTEGER PRIMARY KEY,
          player_id INTEGER NOT NULL REFERENCES players(id),
          tribe_id INTEGER NOT NULL REFERENCES tribes(id),
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          edit_token_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS idx_decks_player ON decks(player_id);
        CREATE TABLE IF NOT EXISTS game_tables (
          id INTEGER PRIMARY KEY,
          season_id INTEGER NOT NULL REFERENCES seasons(id),
          event_date TEXT NOT NULL,
          episode TEXT NOT NULL,
          round_no INTEGER NOT NULL,
          table_no INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
          submitted_by INTEGER REFERENCES players(id),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          reviewed_at TEXT,
          admin_note TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS idx_game_tables_season ON game_tables(season_id, status);
        CREATE TABLE IF NOT EXISTS game_table_entries (
          id INTEGER PRIMARY KEY,
          table_id INTEGER NOT NULL REFERENCES game_tables(id) ON DELETE CASCADE,
          player_id INTEGER NOT NULL REFERENCES players(id),
          tribe_id INTEGER NOT NULL REFERENCES tribes(id),
          deck_id INTEGER REFERENCES decks(id) ON DELETE SET NULL,
          result TEXT NOT NULL CHECK(result IN ('V','E','D')),
          UNIQUE(table_id,player_id));
        CREATE TABLE IF NOT EXISTS league_events (
          id INTEGER PRIMARY KEY,
          event_date TEXT NOT NULL,
          name TEXT NOT NULL,
          season_id INTEGER NOT NULL REFERENCES seasons(id),
          episode TEXT NOT NULL COLLATE NOCASE,
          registrations_open INTEGER NOT NULL DEFAULT 0 CHECK(registrations_open IN (0,1)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(season_id,episode));
        CREATE INDEX IF NOT EXISTS idx_league_events_date ON league_events(event_date DESC);
        CREATE TABLE IF NOT EXISTS event_registrations (
          id INTEGER PRIMARY KEY,
          event_id INTEGER NOT NULL REFERENCES league_events(id) ON DELETE CASCADE,
          player_id INTEGER NOT NULL REFERENCES players(id),
          tribe_id INTEGER NOT NULL REFERENCES tribes(id),
          deck_id INTEGER REFERENCES decks(id) ON DELETE SET NULL,
          checkin INTEGER NOT NULL DEFAULT 0 CHECK(checkin IN (0,1)),
          paid INTEGER NOT NULL DEFAULT 0 CHECK(paid IN (0,1)),
          decklist_ok INTEGER NOT NULL DEFAULT 0 CHECK(decklist_ok IN (0,1)),
          registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(event_id,player_id));
        CREATE INDEX IF NOT EXISTS idx_event_registrations_event ON event_registrations(event_id);
        CREATE TABLE IF NOT EXISTS event_rounds (
          id INTEGER PRIMARY KEY,
          event_id INTEGER NOT NULL REFERENCES league_events(id) ON DELETE RESTRICT,
          round_no INTEGER NOT NULL CHECK(round_no BETWEEN 1 AND 12),
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          published_at TEXT,
          UNIQUE(event_id,round_no));
        CREATE TABLE IF NOT EXISTS event_pairings (
          id INTEGER PRIMARY KEY,
          round_id INTEGER NOT NULL REFERENCES event_rounds(id) ON DELETE CASCADE,
          table_no INTEGER NOT NULL CHECK(table_no > 0),
          UNIQUE(round_id,table_no));
        CREATE TABLE IF NOT EXISTS event_pairing_players (
          id INTEGER PRIMARY KEY,
          round_id INTEGER NOT NULL REFERENCES event_rounds(id) ON DELETE CASCADE,
          pairing_id INTEGER NOT NULL REFERENCES event_pairings(id) ON DELETE CASCADE,
          player_id INTEGER NOT NULL REFERENCES players(id),
          tribe_id INTEGER NOT NULL REFERENCES tribes(id),
          deck_id INTEGER REFERENCES decks(id) ON DELETE SET NULL,
          UNIQUE(round_id,player_id), UNIQUE(pairing_id,player_id));
        CREATE INDEX IF NOT EXISTS idx_event_rounds_event ON event_rounds(event_id,status);
        CREATE TABLE IF NOT EXISTS player_accounts (
          player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
          password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
          password_iterations INTEGER NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS player_sessions (
          token_hash TEXT PRIMARY KEY,
          player_id INTEGER NOT NULL REFERENCES player_accounts(player_id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_player_sessions_player ON player_sessions(player_id);
        
        ''')
        # Auditoria de limpezas intencionais (não reconta partidas apagadas).
        db.execute("""CREATE TABLE IF NOT EXISTS result_purge_audit (
            id INTEGER PRIMARY KEY,
            season_id INTEGER NOT NULL,
            event_date TEXT NOT NULL,
            episode TEXT NOT NULL,
            event_name TEXT,
            removed_matches INTEGER NOT NULL,
            removed_tables INTEGER NOT NULL,
            admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        # Migração incremental: não recria nem substitui o banco em produção.
        event_cols = {r['name'] for r in db.execute('PRAGMA table_info(league_events)')}
        if 'registrations_open' not in event_cols:
            db.execute('ALTER TABLE league_events ADD COLUMN registrations_open INTEGER NOT NULL DEFAULT 0 CHECK(registrations_open IN (0,1))')
        if 'ended_at' not in event_cols:
            db.execute('ALTER TABLE league_events ADD COLUMN ended_at TEXT')
        reg_cols = {r['name'] for r in db.execute('PRAGMA table_info(event_registrations)')}
        if 'deck_id' not in reg_cols:
            db.execute('ALTER TABLE event_registrations ADD COLUMN deck_id INTEGER REFERENCES decks(id) ON DELETE SET NULL')
        event_columns={r['name'] for r in db.execute('PRAGMA table_info(league_events)')}
        if 'rounds_share_token' not in event_columns:
            db.execute('ALTER TABLE league_events ADD COLUMN rounds_share_token TEXT')
        for row in db.execute("SELECT id FROM league_events WHERE rounds_share_token IS NULL OR rounds_share_token='' ").fetchall():
            db.execute('UPDATE league_events SET rounds_share_token=? WHERE id=?',
                       (secrets.token_urlsafe(32),row['id']))
        table_columns={r['name'] for r in db.execute('PRAGMA table_info(game_tables)')}
        if 'pairing_id' not in table_columns:
            db.execute('ALTER TABLE game_tables ADD COLUMN pairing_id INTEGER REFERENCES event_pairings(id) ON DELETE RESTRICT')
        db.execute('CREATE INDEX IF NOT EXISTS idx_tables_pairing ON game_tables(pairing_id,status)')
        # v2.3.4: finalização como carimbo, sem reconstruir CHECK(status) de rodadas antigas.
        round_cols={r['name'] for r in db.execute('PRAGMA table_info(event_rounds)')}
        if 'finalized_at' not in round_cols:
            db.execute('ALTER TABLE event_rounds ADD COLUMN finalized_at TEXT')
        if 'pairing_mode' not in round_cols:
            db.execute("ALTER TABLE event_rounds ADD COLUMN pairing_mode TEXT NOT NULL DEFAULT 'swiss'")
        if 'pairing_note' not in round_cols:
            db.execute("ALTER TABLE event_rounds ADD COLUMN pairing_note TEXT NOT NULL DEFAULT ''")
        reg_cols={r['name'] for r in db.execute('PRAGMA table_info(event_registrations)')}
        if 'dropped_after_round' not in reg_cols:
            db.execute('ALTER TABLE event_registrations ADD COLUMN dropped_after_round INTEGER')
        db.execute('''CREATE TABLE IF NOT EXISTS event_player_warnings (
           id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES league_events(id) ON DELETE CASCADE,
           player_id INTEGER NOT NULL REFERENCES players(id), admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
           note TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
        db.execute('CREATE INDEX IF NOT EXISTS idx_event_warnings ON event_player_warnings(event_id,player_id)')
        # Contas dos participantes são permanentes, independentes de EPs.
        # As contas anteriores criadas manualmente continuam aprovadas.
        account_cols = {r['name'] for r in db.execute('PRAGMA table_info(player_accounts)')}
        if 'username' not in account_cols:
            db.execute('ALTER TABLE player_accounts ADD COLUMN username TEXT')
        if 'approval_status' not in account_cols:
            db.execute("ALTER TABLE player_accounts ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'")
        if 'created_via' not in account_cols:
            db.execute("ALTER TABLE player_accounts ADD COLUMN created_via TEXT NOT NULL DEFAULT 'admin'")
        for row in db.execute("SELECT player_id FROM player_accounts WHERE username IS NULL OR username=''").fetchall():
            db.execute('UPDATE player_accounts SET username=? WHERE player_id=?',
                       ('jogador' + str(row['player_id']), row['player_id']))
        db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_player_accounts_username ON player_accounts(username COLLATE NOCASE)')
        # As sessões antigas da v2.1 não estavam associadas a um usuário.
        # Invalidá-las ao migrar impede que cookies antigos deem acesso irrestrito.
        session_cols = {r['name'] for r in db.execute('PRAGMA table_info(sessions)')}
        if 'admin_id' not in session_cols:
            db.execute('ALTER TABLE sessions ADD COLUMN admin_id INTEGER REFERENCES admins(id) ON DELETE CASCADE')
            db.execute('DELETE FROM sessions WHERE admin_id IS NULL')
        # Atualização sem apagar a base anterior. Todas as vitórias por combo antigas
        # se tornam vitórias simples, e não existem mais pontos personalizados.
        cols = {r['name'] for r in db.execute('PRAGMA table_info(matches)')}
        if 'table_id' not in cols:
            db.execute('ALTER TABLE matches ADD COLUMN table_id INTEGER REFERENCES game_tables(id)')
        if 'deck_id' not in cols:
            db.execute('ALTER TABLE matches ADD COLUMN deck_id INTEGER REFERENCES decks(id) ON DELETE SET NULL')
        db.execute("UPDATE matches SET result='V' WHERE result='C'")
        db.execute('UPDATE matches SET points_override=NULL WHERE points_override IS NOT NULL')
        # Corrige resultados de mesas oficiais aprovadas que por erro antigo não
        # foram propagados integralmente ao histórico usado pelo ranking.
        repair_approved_event_results(db)


USERNAME_PATTERN = re.compile(r'[A-Za-z][A-Za-z0-9._-]{2,31}\Z')


def validate_username(value):
    if not isinstance(value, str) or not USERNAME_PATTERN.fullmatch(value.strip()):
        raise UserInputError('Usuário: 3 a 32 caracteres; comece com letra e use letras, números, ponto, hífen ou _.')
    return value.strip()


def validate_password(value):
    if not isinstance(value, str) or not 10 <= len(value) <= 256:
        raise UserInputError('A senha deve ter de 10 a 256 caracteres.')
    return value


def password_digest(password, salt=None, iterations=PASSWORD_ITERATIONS):
    validate_password(password)
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), iterations)
    return salt, digest.hex(), iterations


def password_matches(password, row):
    # Hash simulado impede resposta instantânea para usuários desconhecidos.
    if row is None:
        hashlib.pbkdf2_hmac('sha256', str(password).encode('utf-8'), b'\x00' * 16, PASSWORD_ITERATIONS)
        return False
    try:
        candidate = hashlib.pbkdf2_hmac('sha256', str(password).encode('utf-8'),
                                        bytes.fromhex(row['password_salt']), row['password_iterations'])
        return hmac.compare_digest(candidate, bytes.fromhex(row['password_hash']))
    except (ValueError, TypeError):
        return False


def register_player_account(db, username, password, player_id=None, player_name=None):
    username = validate_username(username)
    salt, digest, iters = password_digest(password)
    if db.execute('SELECT 1 FROM player_accounts WHERE username=? COLLATE NOCASE', (username,)).fetchone():
        raise UserInputError('Esse nome de usuário já está sendo utilizado.')
    if player_id not in (None, ''):
        pid = int_id(player_id, 'Jogador')
        if not exists(db, 'players', pid):
            raise UserInputError('Jogador não encontrado.')
    else:
        name = txt(player_name, 'Nome do jogador', 100)
        if db.execute('SELECT 1 FROM players WHERE name=? COLLATE NOCASE', (name,)).fetchone():
            raise UserInputError('Esse jogador já existe. Selecione seu nome na lista.')
        pid = create_or_get(db, 'players', name)
    if db.execute('SELECT 1 FROM player_accounts WHERE player_id=?', (pid,)).fetchone():
        raise UserInputError('Esse jogador já possui uma conta. Fale com a organização se perdeu seu acesso.')
    db.execute('''INSERT INTO player_accounts(player_id,username,password_salt,password_hash,
                  password_iterations,active,approval_status,created_via) VALUES(?,?,?,?,?,0,'pending','self')''',
               (pid,username,salt,digest,iters))
    return pid


def list_player_access_requests(db):
    return [dict(r) for r in db.execute('''SELECT pa.player_id,p.name AS player_name,
              pa.username,pa.approval_status,pa.created_at,pa.created_via,pa.active
              FROM player_accounts pa JOIN players p ON p.id=pa.player_id
              ORDER BY CASE WHEN pa.approval_status='pending' THEN 0 ELSE 1 END,
              pa.created_at DESC,pa.player_id DESC''')]


def create_admin(db, username, password, role='admin'):
    username = validate_username(username)
    salt, digest, iters = password_digest(password)
    if role not in ('owner', 'admin'):
        raise UserInputError('Perfil administrativo inválido.')
    cur = db.execute("INSERT INTO admins(username,password_salt,password_hash,password_iterations,role) VALUES(?,?,?,?,?)", (username, salt, digest, iters, role))
    return cur.lastrowid


def set_admin_password(db, admin_id, password):
    salt, digest, iters = password_digest(password)
    db.execute("UPDATE admins SET password_salt=?,password_hash=?,password_iterations=? WHERE id=?",
               (salt, digest, iters, admin_id))


def has_admins(db):
    return db.execute('SELECT 1 FROM admins LIMIT 1').fetchone() is not None


def setup_first_admin():
    with DB_LOCK, conn_db() as db:
        if has_admins(db):
            return True
        if LEGACY_BOOTSTRAP_PASSWORD:
            # Compatibilidade: senha antiga vira conta 'admin' UMA VEZ. Não é mais
            # necessária nem consultada depois que a conta está no SQLite.
            if len(LEGACY_BOOTSTRAP_PASSWORD) >= 10:
                create_admin(db, 'admin', LEGACY_BOOTSTRAP_PASSWORD, 'owner')
            else:
                # Versões antigas não exigiam tamanho mínimo. Preservamos o
                # acesso e recomendamos trocá-la imediatamente no painel.
                salt = secrets.token_hex(16)
                digest = hashlib.pbkdf2_hmac('sha256', LEGACY_BOOTSTRAP_PASSWORD.encode('utf-8'),
                                             bytes.fromhex(salt), PASSWORD_ITERATIONS).hex()
                db.execute('''INSERT INTO admins(username,password_salt,password_hash,password_iterations,role)
                              VALUES(?,?,?,?,?)''', ('admin',salt,digest,PASSWORD_ITERATIONS,'owner'))
                print('AVISO: senha antiga curta; altere-a em Administração > Acessos.')
            print("Conta principal 'admin' salva no banco a partir da senha antiga.")
            return True
    if not sys.stdin.isatty():
        print('Primeiro acesso: abra um terminal e execute: python server.py --create-admin')
        return False
    print('\nPrimeiro acesso: crie sua conta principal de administração.')
    username = input('Nome de usuário [admin]: ').strip() or 'admin'
    try:
        username = validate_username(username)
        first = getpass.getpass('Senha (mínimo 10 caracteres): ')
        again = getpass.getpass('Confirme a senha: ')
        if first != again:
            raise UserInputError('As senhas digitadas não coincidem.')
        validate_password(first)
        with DB_LOCK, conn_db() as db:
            if not has_admins(db):
                create_admin(db, username, first, 'owner')
        print('Conta principal criada e armazenada no banco com hash criptográfico.\n')
        return True
    except (UserInputError, EOFError) as e:
        print(f'Não foi possível criar a conta: {e}')
        return False


def reset_owner_password():
    if not sys.stdin.isatty():
        print('Use --reset-owner-password em um terminal interativo.')
        return False
    with DB_LOCK, conn_db() as db:
        owners = db.execute("SELECT id,username FROM admins WHERE role='owner' ORDER BY id").fetchall()
        if not owners:
            print('Nenhuma conta principal cadastrada.')
            return False
        print('Contas principais:', ', '.join(row['username'] for row in owners))
        username = input('Conta a recuperar: ').strip()
        found = next((row for row in owners if row['username'].lower() == username.lower()), None)
        if found is None:
            print('Conta não encontrada.')
            return False
        password = getpass.getpass('Nova senha (mínimo 10 caracteres): ')
        confirm = getpass.getpass('Confirme a nova senha: ')
        if password != confirm:
            print('As senhas não coincidem.')
            return False
        try:
            set_admin_password(db, found['id'], password)
        except UserInputError as ex:
            print(ex)
            return False
        db.execute('DELETE FROM sessions WHERE admin_id=?', (found['id'],))
        print('Senha atualizada. Sessões dessa conta foram encerradas.')
        return True


def normalize(value):
    return ''.join(c for c in unicodedata.normalize('NFD', str(value or '')) if unicodedata.category(c) != 'Mn').strip().lower().replace('_', ' ').replace('-', ' ')


def txt(value, field, maxlen=120, required=True):
    out = str(value or '').strip()
    if required and not out:
        raise UserInputError(f'{field} é obrigatório.')
    if len(out) > maxlen:
        raise UserInputError(f'{field} deve ter até {maxlen} caracteres.')
    return out


def int_id(value, field):
    try:
        n = int(value)
        if n <= 0:
            raise ValueError()
        return n
    except (TypeError, ValueError):
        raise UserInputError(f'{field} inválido.')


def round_value(value):
    try:
        n = int(value)
        if n < 1 or n > 99:
            raise ValueError()
        return n
    except (ValueError, TypeError):
        raise UserInputError('Rodada deve estar entre 1 e 99.')


def date_value(value):
    s = txt(value, 'Data', 24)
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%d/%m/%y', '%d-%m-%Y'):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    raise UserInputError('Data inválida. Use AAAA-MM-DD ou DD/MM/AAAA.')


def get_result(value):
    v = normalize(value).upper()
    aliases = {
      'V': 'V', 'VITORIA': 'V', 'WIN': 'V', 'W': 'V', '3': 'V',
      'E': 'E', 'EMPATE': 'E', 'DRAW': 'E', '1': 'E',
      'D': 'D', 'DERROTA': 'D', 'LOSS': 'D', 'L': 'D', '0': 'D',
    }
    if v not in aliases:
        raise UserInputError(f'Resultado desconhecido: {value}. Use V, E, D ou pontos 3/1/0.')
    return aliases[v]


def exists(db, table, ident):
    return bool(db.execute(f'SELECT 1 FROM {table} WHERE id=?', (ident,)).fetchone())


def create_or_get(db, table, name):
    if table not in ('seasons', 'players', 'tribes'):
        raise ValueError('invalid table')
    name = txt(name, 'Nome', 100)
    row = db.execute(f'SELECT id FROM {table} WHERE name=? COLLATE NOCASE', (name,)).fetchone()
    if row:
        return row['id']
    db.execute(f'INSERT INTO {table}(name) VALUES(?)', (name,))
    row = db.execute(f'SELECT id FROM {table} WHERE name=? COLLATE NOCASE', (name,)).fetchone()
    if not row:
        raise UserInputError(f'Nome duplicado: {name}.')
    return row['id']


def select_lists(db):
    seasons = [dict(r) for r in db.execute('SELECT * FROM seasons ORDER BY sort_order, id')]
    players = [dict(r) for r in db.execute('SELECT * FROM players ORDER BY name COLLATE NOCASE')]
    tribes = [dict(r) for r in db.execute('SELECT * FROM tribes ORDER BY name COLLATE NOCASE')]
    ex = [dict(r) for r in db.execute('SELECT season_id,tribe_id FROM exclusions')]
    return {'seasons': seasons, 'players': players, 'tribes': tribes, 'exclusions': ex}


def public_view(db, season_arg='all', admin=False):
    base = select_lists(db)
    season_id = None
    if season_arg not in ('', 'all', None):
        season_id = int_id(season_arg, 'Temporada')
        if not exists(db, 'seasons', season_id):
            raise UserInputError('Temporada não encontrada.')
    q = '''SELECT m.*, p.name AS player_name, t.name AS tribe_name, s.name AS season_name,
      d.name AS deck_name, d.url AS deck_url,
      (CASE WHEN e.tribe_id IS NULL THEN 0 ELSE 1 END) AS excluded
      FROM matches m
      JOIN players p ON p.id=m.player_id
      JOIN tribes t ON t.id=m.tribe_id
      JOIN seasons s ON s.id=m.season_id
      LEFT JOIN decks d ON d.id=m.deck_id
      LEFT JOIN exclusions e ON e.season_id=m.season_id AND e.tribe_id=m.tribe_id'''
    args = []
    if season_id is not None:
        q += ' WHERE m.season_id=?'
        args.append(season_id)
    q += ' ORDER BY m.event_date DESC, m.round_no DESC, m.id DESC'
    records = []
    leaderboard = {}
    tribe_table = {}
    unique_events = set()
    for r in db.execute(q, args):
        rec = dict(r)
        rec['raw_points'] = RULES[rec['result']]
        rec['points'] = 0 if rec['excluded'] else rec['raw_points']
        records.append(rec)
        unique_events.add((rec['season_id'], rec['event_date'], rec['episode']))
        pid = rec['player_id']
        if pid not in leaderboard:
            leaderboard[pid] = {'id': pid, 'name': rec['player_name'], 'points': 0, 'raw_points': 0,
                'matches': 0, 'wins': 0, 'draws': 0, 'losses': 0, 'excluded_matches': 0,
                'eligible_wins':0, 'eligible_matches':0,
                'tribes': {}, 'decks': {}, 'seasons': set()}
        user = leaderboard[pid]
        user['points'] += rec['points']
        user['raw_points'] += rec['raw_points']
        user['matches'] += 1
        user['wins'] += rec['result'] == 'V'
        user['draws'] += rec['result'] == 'E'
        user['losses'] += rec['result'] == 'D'
        user['excluded_matches'] += rec['excluded']
        if not rec['excluded']:
            user['eligible_matches'] += 1
            user['eligible_wins'] += rec['result'] == 'V'
        user['seasons'].add(rec['season_name'])
        if rec['tribe_id'] not in user['tribes']:
            user['tribes'][rec['tribe_id']] = {'id': rec['tribe_id'], 'name': rec['tribe_name'], 'matches': 0,
                'points': 0, 'raw_points': 0, 'wins': 0, 'draws': 0, 'losses': 0,
                'eligible_wins': 0, 'eligible_matches': 0, 'excluded_matches': 0}
        ut = user['tribes'][rec['tribe_id']]
        ut['matches'] += 1
        ut['points'] += rec['points']
        ut['raw_points'] += rec['raw_points']
        ut['wins'] += rec['result'] == 'V'
        ut['draws'] += rec['result'] == 'E'
        ut['losses'] += rec['result'] == 'D'
        ut['excluded_matches'] += rec['excluded']
        if not rec['excluded']:
            ut['eligible_matches'] += 1
            ut['eligible_wins'] += rec['result'] == 'V'
        tid = rec['tribe_id']
        if tid not in tribe_table:
            tribe_table[tid] = {'id': tid, 'name': rec['tribe_name'], 'matches': 0,
                'points': 0, 'excluded_matches': 0, 'players': set()}
        t = tribe_table[tid]
        t['matches'] += 1
        t['points'] += rec['points']
        t['excluded_matches'] += rec['excluded']
        t['players'].add(rec['player_name'])
    # OPW%: média da porcentagem de vitórias dos adversários efetivamente
    # encontrados nas mesas aprovadas. Um confronto multiplayer soma cada
    # adversário uma vez (2 em mesas de 3, 3 em mesas de 4). Estatísticas dos
    # adversários são calculadas por temporada; a tribo adversária não precisa
    # ser a mesma durante todo o campeonato. Aplicamos o piso de 33% usado no
    # desempate por adversários do Magic. Jogos de tribos bloqueadas não entram
    # no desempenho pontuante nem no OPW da própria entrada bloqueada.
    # Não é possível reconstruir adversários a partir de CSVs sem table_id.
    opponent_stats = {}
    seats_by_table = {}
    for rec in records:
        if not rec['excluded']:
            key = (rec['season_id'], rec['player_id'])
            stats = opponent_stats.setdefault(key, {'points': 0, 'matches': 0})
            stats['points'] += rec['points']
            stats['matches'] += 1
        if rec.get('table_id') is not None:
            seats_by_table.setdefault(rec['table_id'], []).append(rec)

    opw_values = {}
    opw_known_rounds = {}
    for rec in records:
        if rec['excluded'] or rec.get('table_id') is None:
            continue
        seats = seats_by_table.get(rec['table_id'], ())
        # Uma mesa deve conter somente 3 ou 4 participantes distintos, todos
        # do mesmo torneio/rodada. Dados inconsistentes não viram percentual.
        participant_ids = {entry['player_id'] for entry in seats}
        if len(seats) not in (3, 4) or len(participant_ids) != len(seats):
            continue
        if any((other['season_id'], other['event_date'], other['episode'], other['round_no']) !=
               (rec['season_id'], rec['event_date'], rec['episode'], rec['round_no']) for other in seats):
            continue
        key = (rec['player_id'], rec['tribe_id'])
        for other in seats:
            if other['player_id'] == rec['player_id']:
                continue
            stats = opponent_stats.get((rec['season_id'], other['player_id']))
            ratio = stats['points'] / (3 * stats['matches']) if stats and stats['matches'] else 0
            opw_values.setdefault(key, []).append(max(0.33, ratio))
        opw_known_rounds[key] = opw_known_rounds.get(key, 0) + 1

    # Decks sem partidas também aparecem no perfil. Resultados antigos/CSV sem
    # deck vinculado continuam contando para jogador/tribo, não para um deck específico.
    all_decks = [dict(d) for d in db.execute('''SELECT d.id,d.player_id,d.tribe_id,d.name,d.url,
        t.name AS tribe_name FROM decks d JOIN tribes t ON t.id=d.tribe_id ORDER BY d.name COLLATE NOCASE''')]
    for d in all_decks:
        pid = d['player_id']
        if pid not in leaderboard:
            pn = db.execute('SELECT name FROM players WHERE id=?',(pid,)).fetchone()['name']
            leaderboard[pid] = {'id':pid,'name':pn,'points':0,'raw_points':0,'matches':0,'wins':0,
                'draws':0,'losses':0,'excluded_matches':0,'eligible_wins':0,
                'eligible_matches':0,'tribes':{},'decks':{},'seasons':set()}
        leaderboard[pid]['decks'][d['id']] = {**d, 'matches':0,'wins':0,'draws':0,
            'losses':0,'points':0,'excluded_matches':0}
    for rec in records:
        did = rec.get('deck_id')
        if did and did in leaderboard[rec['player_id']]['decks']:
            ds = leaderboard[rec['player_id']]['decks'][did]
            ds['matches'] += 1
            ds['wins'] += rec['result'] == 'V'
            ds['draws'] += rec['result'] == 'E'
            ds['losses'] += rec['result'] == 'D'
            ds['points'] += rec['points']
            ds['excluded_matches'] += rec['excluded']
    # O ranking oficial é por par (jogador, tribo), não pela soma do jogador.
    # O perfil do jogador continua agregando suas várias tribos e decklists.
    player_profiles = list(leaderboard.values())
    ranking = []
    for profile in player_profiles:
        for tribo in profile['tribes'].values():
            entry_key = (profile['id'], tribo['id'])
            known = opw_known_rounds.get(entry_key, 0)
            opponents = opw_values.get(entry_key, ())
            # Somente se TODAS as partidas pontuantes tiverem adversários
            # identificados calculamos OPW; cobertura parcial ficaria enganosa.
            complete = (known > 0 and known == tribo['eligible_matches'] and bool(opponents))
            opw_value = sum(opponents) / len(opponents) if complete else None
            ranking.append({
                'id': profile['id'], 'player_id': profile['id'], 'tribe_id': tribo['id'],
                'rank_key': f"{profile['id']}:{tribo['id']}",
                'name': profile['name'], 'tribe_name': tribo['name'],
                'tribes': [tribo.copy()],
                'points': tribo['points'], 'raw_points': tribo['raw_points'],
                'matches': tribo['matches'], 'wins': tribo['wins'],
                'draws': tribo['draws'], 'losses': tribo['losses'],
                'excluded_matches': tribo['excluded_matches'],
                'eligible_wins': tribo['eligible_wins'],
                'eligible_matches': tribo['eligible_matches'],
                'win_rate': round(tribo['wins'] / tribo['matches'] * 100, 1) if tribo['matches'] else 0,
                'opw_pct': round(100 * opw_value, 2) if opw_value is not None else None,
                'opw_value': opw_value,
                'opw_rounds': known, 'opw_opponents': len(opponents),
                'opw_expected_rounds': tribo['eligible_matches'],
            })
        profile['tribes'] = sorted(profile['tribes'].values(), key=lambda t: (-t['matches'], t['name'].lower()))
        profile['seasons'] = sorted(profile['seasons'])
        profile['decks'] = sorted(profile['decks'].values(), key=lambda d:(-d['points'],d['name'].casefold()))
        profile['win_rate'] = round(profile['wins'] / profile['matches'] * 100, 1) if profile['matches'] else 0
    # Desempate principal: OPW%. Partidas antigas sem mesa identificada ficam
    # com OPW indisponível; em igualdade de pontos, vêm após OPW verificável.
    # Próximos critérios: vitórias, partidas válidas e ordem alfabética.
    ranking.sort(key=lambda r: (-r['points'], -(r['opw_value'] if r['opw_value'] is not None else -1),
                                -r['eligible_wins'], -r['eligible_matches'],
                                r['name'].casefold(), r['tribe_name'].casefold()))
    for index, r in enumerate(ranking, start=1):
        r['position'] = index
    # Posição melhor colocada do jogador; seu perfil mantém os totais gerais,
    # que não são usados para ordenar o ranking por tribo.
    best_pos = {}
    for r in ranking:
        best_pos.setdefault(r['player_id'], r['position'])
    for profile in player_profiles:
        profile['position'] = best_pos.get(profile['id'])
    player_profiles.sort(key=lambda p: p['name'].casefold())
    tribes_rank = list(tribe_table.values())
    for t in tribes_rank:
        t['players'] = len(t['players'])
    tribes_rank.sort(key=lambda r: (-r['points'], -r['matches'], r['name'].casefold()))
    selected_ex = [e for e in base['exclusions'] if season_id is None or e['season_id'] == season_id]
    excludes = sorted({t['name'] for t in base['tribes'] for e in selected_ex if e['tribe_id'] == t['id']})
    # Série histórica com TODOS os registros, sem o limite de 80 partidas da lista pública.
    events_sorted = sorted(unique_events, key=lambda e: (e[1], e[0], e[2]))
    by_event = {}
    top_players = ranking[:5]
    top_keys = {(p['player_id'], p['tribe_id']) for p in top_players}
    for rec in records:
        key = (rec['player_id'], rec['tribe_id'])
        if key in top_keys:
            event_key = (rec['season_id'], rec['event_date'], rec['episode'])
            progress_key = (event_key, *key)
            by_event[progress_key] = by_event.get(progress_key, 0) + rec['points']
    season_map = {s['id']: s['name'] for s in base['seasons']}
    progress = {p['rank_key']: 0 for p in top_players}
    trend = []
    for event_key in events_sorted:
        sid, dt, episode = event_key
        event = {'date': dt, 'episode': episode, 'season': season_map[sid], 'points': {}}
        for p in top_players:
            key = p['rank_key']
            progress[key] += by_event.get((event_key, p['player_id'], p['tribe_id']), 0)
            event['points'][key] = progress[key]
        trend.append(event)
    out = {
      'season_id': season_id, 'ranking': ranking, 'player_profiles': player_profiles,
      'top_tribes': tribes_rank, 'trend':trend,
      'recent_matches': records[:600 if admin else 80],
      'excluded_tribes': excludes,
      'summary': {'players': len(player_profiles), 'ranking_entries': len(ranking),
                  'matches': len(records), 'events': len(unique_events),
                  'tribes': len(tribe_table), 'points': sum(r['points'] for r in ranking),
                  'excluded_matches': sum(r['excluded'] for r in records)},
      'seasons': base['seasons'],
      'players': base['players'], 'tribes': base['tribes'],
      'scoring': RULES,
      'decks': all_decks,
    }
    if admin:
        out['master'] = base
        out['all_matches'] = records
        out['game_tables'] = list_game_tables(db, include_all=True)
    return out


def validate_match(db, obj):
    season_id = int_id(obj.get('season_id'), 'Temporada')
    player_id = int_id(obj.get('player_id'), 'Jogador')
    tribe_id = int_id(obj.get('tribe_id'), 'Tribo')
    for table, ident in [('seasons', season_id), ('players', player_id), ('tribes', tribe_id)]:
        if not exists(db, table, ident):
            raise UserInputError(f'{table}: registro não encontrado.')
    if obj.get('points_override') not in ('', None):
        raise UserInputError('Pontos manuais não existem: V=3, E=1, D=0.')
    deck_id = obj.get('deck_id') or None
    if deck_id is not None:
        deck_id = int_id(deck_id,'Deck')
        d = db.execute('SELECT player_id,tribe_id FROM decks WHERE id=?',(deck_id,)).fetchone()
        if not d or d['player_id'] != player_id or d['tribe_id'] != tribe_id:
            raise UserInputError('Deck incompatível com o jogador ou tribo.')
    return (season_id, date_value(obj.get('event_date')), txt(obj.get('episode'), 'Episódio', 70, False),
        round_value(obj.get('round_no')), player_id, tribe_id, get_result(obj.get('result')), None, deck_id)


def import_csv(db, raw, fallback_season):
    if len(raw) > 2_000_000:
        raise UserInputError('CSV excede 2 MB.')
    cleaned = raw.lstrip('\ufeff')
    sample = cleaned[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=';,\t')
        delim = dialect.delimiter
    except csv.Error:
        delim = ';' if sample.count(';') >= sample.count(',') else ','
    reader = csv.DictReader(io.StringIO(cleaned, newline=''), delimiter=delim)
    if not reader.fieldnames:
        raise UserInputError('CSV vazio ou sem cabeçalho.')
    aliases = {
        'jogador': 'player', 'nome': 'player', 'player': 'player', 'players': 'player',
        'tribo': 'tribe', 'tribos': 'tribe', 'tribe': 'tribe',
        'temporada': 'season', 'season': 'season',
        'data': 'date', 'date': 'date', 'event date': 'date',
        'episodio': 'episode', 'etapa': 'episode', 'episode': 'episode',
        'rodada': 'round', 'round': 'round',
        'resultado': 'result', 'result': 'result',
        'pontos': 'points', 'points': 'points',
        'r1': 'r1', 'r2': 'r2', 'r3': 'r3',
    }
    names = [aliases.get(normalize(c), normalize(c)) for c in reader.fieldnames]
    if 'player' not in names or 'tribe' not in names or 'date' not in names:
        raise UserInputError('Cabeçalhos mínimos: DATA, PLAYER/JOGADOR, TRIBO e R1/R2/R3 ou RESULTADO.')
    if 'result' not in names and not any(n in names for n in ('r1','r2','r3')):
        raise UserInputError('CSV precisa ter RESULTADO ou colunas R1, R2, R3.')
    if not fallback_season and 'season' not in names:
        raise UserInputError('Selecione uma temporada antes de importar ou informe a coluna TEMPORADA.')
    inserted, skipped, failed, failed_total = 0, 0, [], 0
    for lineno, row in enumerate(reader, start=2):
        try:
            data = {aliases.get(normalize(k), normalize(k)): (v or '').strip() for k, v in row.items() if k is not None}
            if not any(data.values()):
                continue
            player_name = txt(data.get('player'), 'Jogador', 100)
            tribe_name = txt(data.get('tribe'), 'Tribo', 100)
            dt = date_value(data.get('date'))
            name = data.get('season') or ''
            if name:
                season_id = create_or_get(db, 'seasons', name)
            elif fallback_season and exists(db, 'seasons', int(fallback_season)):
                season_id = int(fallback_season)
            else:
                raise UserInputError('Temporada inválida.')
            player_id = create_or_get(db, 'players', player_name)
            tribe_id = create_or_get(db, 'tribes', tribe_name)
            episode = txt(data.get('episode'), 'Episódio', 70, False)
            match_rows = []
            if 'result' in names:
                match_rows.append((round_value(data.get('round') or 1), get_result(data.get('result')),
                    data.get('points') if data.get('points') not in (None, '') else None))
            else:
                for rn in (1, 2, 3):
                    val = data.get(f'r{rn}', '')
                    if val != '':
                        match_rows.append((rn, get_result(val), None))
            if not match_rows:
                raise UserInputError('Linha sem resultados.')
            for rn, result, override in match_rows:
                if override is not None:
                    try:
                        manual_points=int(override)
                    except (ValueError,TypeError):
                        raise UserInputError('Coluna PONTOS inválida.')
                    if manual_points != RULES[result]:
                        raise UserInputError('Coluna PONTOS não corresponde ao resultado: V=3, E=1, D=0.')
                has = db.execute('''SELECT id FROM matches WHERE season_id=? AND event_date=? AND episode=?
                   AND round_no=? AND player_id=?''',
                   (season_id,dt,episode,rn,player_id)).fetchone()
                if has:
                    skipped += 1
                    continue
                db.execute('''INSERT INTO matches(season_id,event_date,episode,round_no,player_id,tribe_id,result,points_override)
                    VALUES(?,?,?,?,?,?,?,?)''', (season_id,dt,episode,rn,player_id,tribe_id,result,override))
                inserted += 1
        except (UserInputError, ValueError) as ex:
            failed_total += 1
            if len(failed) < 25:
                failed.append(f'Linha {lineno}: {ex}')
    return {'inserted': inserted, 'skipped': skipped, 'errors': failed,
            'message': f'{inserted} partidas importadas; {skipped} duplicadas ignoradas; {failed_total} linha(s) com erro (até 25 exibidas).'}


def export_csv(db, season_arg):
    view = public_view(db, season_arg, admin=True)
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=';')
    writer.writerow(['TEMPORADA','DATA','EPISODIO','RODADA','JOGADOR','TRIBO','RESULTADO','PONTOS','PONTOS_VALIDOS','TRIBO_NAO_PONTUA'])
    for m in reversed(view['all_matches']):
        brazilian_date = datetime.strptime(m['event_date'], '%Y-%m-%d').strftime('%d/%m/%Y')
        writer.writerow([m['season_name'], brazilian_date, m['episode'], m['round_no'],m['player_name'],
            m['tribe_name'], m['result'], m['raw_points'], m['points'], 'SIM' if m['excluded'] else 'NAO'])
    return '\ufeff' + buf.getvalue()


def generate_backup(db):
    base = select_lists(db)
    base['matches'] = [dict(r) for r in db.execute('SELECT * FROM matches ORDER BY id')]
    base['decks'] = [dict(r) for r in db.execute('SELECT * FROM decks ORDER BY id')]
    base['game_tables'] = [dict(r) for r in db.execute('SELECT * FROM game_tables ORDER BY id')]
    base['game_table_entries'] = [dict(r) for r in db.execute('SELECT * FROM game_table_entries ORDER BY id')]
    base['schema'] = 'bloodline-bi-v2'
    base['created_at'] = datetime.now(timezone.utc).isoformat()
    return base


def seed_demo(db):
    if db.execute('SELECT 1 FROM seasons LIMIT 1').fetchone():
        return False
    s1 = create_or_get(db, 'seasons', 'Temporada Demo 1')
    s2 = create_or_get(db, 'seasons', 'Temporada Demo 2')
    db.execute('UPDATE seasons SET sort_order=1 WHERE id=?', (s1,))
    db.execute('UPDATE seasons SET sort_order=2 WHERE id=?', (s2,))
    players = ['Jogador Alfa','Jogador Beta','Jogador Gama','Jogador Delta','Jogador Épsilon','Jogador Zeta']
    tribes = ['Robôs', 'Humanos', 'Dragões', 'Artífices', 'Clérigos', 'Insectos']
    ps = [create_or_get(db,'players',p) for p in players]
    ts = [create_or_get(db,'tribes',t) for t in tribes]
    db.execute('INSERT INTO exclusions(season_id,tribe_id) VALUES(?,?)', (s2,ts[3]))
    # Dataset ilustrativo, nunca resultados oficiais.
    for s, date, episode, offset in [(s1, '2026-03-12','E1',0), (s1,'2026-03-26','E2',1),
                                      (s2,'2026-09-10','E1',2), (s2,'2026-09-24','E2',3)]:
        for rn in (1,2,3):
            for idx, p in enumerate(ps):
                result = ['V','E','D','V','D','E'][(idx+rn+offset)%6]
                tribe = ts[(idx+(1 if s == s2 and idx in (2,3) else 0)) % len(ts)]
                db.execute('''INSERT INTO matches (season_id,event_date,episode,round_no,player_id,tribe_id,result)
                    VALUES(?,?,?,?,?,?,?)''', (s,date,episode,rn,p,tribe,result))
    return True



def validated_deck(db, obj):
    pid = int_id(obj.get('player_id'), 'Jogador')
    tid = int_id(obj.get('tribe_id'), 'Tribo')
    if not exists(db,'players',pid) or not exists(db,'tribes',tid):
        raise UserInputError('Jogador ou tribo não cadastrados.')
    name = txt(obj.get('name'), 'Nome do deck', 100)
    url = txt(obj.get('url'), 'Link da decklist', 700)
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or re.search(r'\s', url):
        raise UserInputError('Informe uma URL HTTPS válida para a decklist.')
    return pid,tid,name,url


def validate_table(db, obj):
    sid=int_id(obj.get('season_id'),'Temporada')
    if not exists(db,'seasons',sid):
        raise UserInputError('Temporada inexistente.')
    date=date_value(obj.get('event_date'))
    episode=txt(obj.get('episode'),'Episódio do torneio',70)
    rn=round_value(obj.get('round_no'))
    tn=round_value(obj.get('table_no'))
    entries=obj.get('entries')
    if not isinstance(entries,list) or len(entries) not in (3,4):
        raise UserInputError('A mesa deve ter 3 ou 4 jogadores.')
    unique_players=set()
    vals=[]
    for i, row in enumerate(entries,start=1):
        if not isinstance(row,dict):
            raise UserInputError(f'Participante {i} inválido.')
        pid=int_id(row.get('player_id'),f'Jogador {i}')
        if pid in unique_players:
            raise UserInputError('Um jogador não pode ocupar duas posições na mesma mesa.')
        unique_players.add(pid)
        tid=int_id(row.get('tribe_id'),f'Tribo {i}')
        if not exists(db,'players',pid) or not exists(db,'tribes',tid):
            raise UserInputError(f'Jogador ou tribo da posição {i} não encontrados.')
        result=get_result(row.get('result'))
        deck_id=row.get('deck_id') or None
        if deck_id:
            deck_id=int_id(deck_id,'Deck')
            deck=db.execute('SELECT player_id,tribe_id FROM decks WHERE id=?',(deck_id,)).fetchone()
            if not deck or deck['player_id']!=pid or deck['tribe_id']!=tid:
                raise UserInputError(f'Deck da posição {i} não corresponde ao jogador e tribo.')
        vals.append((pid,tid,deck_id,result))
    wins=sum(r[3]=='V' for r in vals)
    draws=sum(r[3]=='E' for r in vals)
    if not ((wins==1 and draws==0) or (wins==0 and draws>=2)):
        raise UserInputError('Informe exatamente 1 vencedor e os demais derrotados, OU empate entre 2, 3 ou 4 jogadores com os restantes derrotados.')
    submitter=obj.get('submitted_by') or None
    if submitter is not None:
        submitter=int_id(submitter,'Enviado por')
        if submitter not in unique_players:
            raise UserInputError('Quem envia o resultado deve participar da mesa.')
    conflict=db.execute('''SELECT id FROM game_tables WHERE season_id=? AND event_date=? AND episode=?
      AND round_no=? AND table_no=? AND status IN ('pending','approved')''',(sid,date,episode,rn,tn)).fetchone()
    if conflict:
        raise UserInputError(f'Já existe uma mesa pendente ou aprovada para esta etapa, rodada e número (#{conflict["id"]}).')
    # Não deixe o mesmo jogador se inscrever em duas mesas da mesma rodada.
    existing=db.execute('''SELECT player_id FROM matches WHERE season_id=? AND event_date=?
        AND episode=? AND round_no=?''',(sid,date,episode,rn)).fetchall()
    if unique_players.intersection({r['player_id'] for r in existing}):
        raise UserInputError('Há jogadores com resultado já lançado nesta etapa/rodada.')
    conflicts=db.execute('''SELECT e.player_id FROM game_table_entries e JOIN game_tables g ON g.id=e.table_id
      WHERE g.season_id=? AND g.event_date=? AND g.episode=? AND g.round_no=?
        AND g.status IN ('pending','approved')''',(sid,date,episode,rn)).fetchall()
    if unique_players.intersection({r['player_id'] for r in conflicts}):
        raise UserInputError('Há jogadores já registrados em outra mesa desta etapa/rodada.')
    return (sid,date,episode,rn,tn,submitter),vals


def list_game_tables(db, include_all=False, season='all'):
    params=[]
    query='''SELECT g.*,s.name AS season_name,p.name AS submitter_name
       FROM game_tables g JOIN seasons s ON s.id=g.season_id
       LEFT JOIN players p ON p.id=g.submitted_by'''
    where=[]
    if not include_all:
        where.append("g.status='approved'")
    if season not in ('','all',None):
        sid=int_id(season,'Temporada')
        where.append('g.season_id=?')
        params.append(sid)
    if where:query+=' WHERE '+' AND '.join(where)
    query+=(' ORDER BY CASE WHEN g.status=\'pending\' THEN 0 ELSE 1 END,' if include_all else ' ORDER BY ' ) + 'g.event_date DESC,g.episode DESC,g.round_no DESC,g.table_no DESC,g.id DESC LIMIT '+('600' if include_all else '250')
    result=[]
    for row in db.execute(query,params):
        g=dict(row)
        g['entries']=[dict(e) for e in db.execute('''SELECT e.player_id,e.tribe_id,e.deck_id,e.result,
            p.name AS player_name,t.name AS tribe_name,d.name AS deck_name
            FROM game_table_entries e JOIN players p ON p.id=e.player_id
            JOIN tribes t ON t.id=e.tribe_id LEFT JOIN decks d ON d.id=e.deck_id
            WHERE e.table_id=? ORDER BY e.id''',(g['id'],))]
        result.append(g)
    return result


def create_table(db,header,entries,approved=False):
    status='approved' if approved else 'pending'
    cur=db.execute('''INSERT INTO game_tables(season_id,event_date,episode,round_no,table_no,submitted_by,status,
        reviewed_at) VALUES(?,?,?,?,?,?,?,CASE WHEN ?='approved' THEN CURRENT_TIMESTAMP ELSE NULL END)''',
        (*header,status,status))
    table_id=cur.lastrowid
    for pid,tid,deck,result in entries:
        db.execute('''INSERT INTO game_table_entries(table_id,player_id,tribe_id,deck_id,result)
          VALUES(?,?,?,?,?)''',(table_id,pid,tid,deck,result))
        if approved:
            db.execute('''INSERT INTO matches(season_id,event_date,episode,round_no,player_id,tribe_id,result,table_id,deck_id)
               VALUES(?,?,?,?,?,?,?,?,?)''',(*header[:4],pid,tid,result,table_id,deck))
    return table_id


def ensure_approved_table_results(db, table_id):
    """Garantia idempotente: uma entrada oficial aprovada = uma partida pontuante.

    Nunca reproduz pontos de uma mesa pendente/rejeitada e nunca duplica
    um registro que já possui o vínculo table_id. Restringe a recuperação
    automática às mesas oficiais ligadas a um pareamento.
    """
    table = db.execute('SELECT * FROM game_tables WHERE id=?', (table_id,)).fetchone()
    if not table or table['status'] != 'approved':
        raise UserInputError('Somente mesas aprovadas podem entrar no ranking.')
    entries = db.execute('SELECT * FROM game_table_entries WHERE table_id=?', (table_id,)).fetchall()
    if len(entries) not in (3, 4) or len({r['player_id'] for r in entries}) != len(entries):
        raise UserInputError('Mesa aprovada inválida: participantes não conferem.')
    if table['pairing_id'] is not None:
        official = db.execute("""SELECT pp.player_id,pp.tribe_id FROM event_pairing_players pp
            JOIN event_pairings ep ON ep.id=pp.pairing_id
            JOIN event_rounds er ON er.id=ep.round_id
            JOIN league_events ev ON ev.id=er.event_id
            WHERE ep.id=? AND ev.season_id=? AND ev.event_date=? AND ev.episode=?
              AND er.round_no=? AND ep.table_no=?""",
            (table['pairing_id'],table['season_id'],table['event_date'],
             table['episode'],table['round_no'],table['table_no'])).fetchall()
        if {(r['player_id'],r['tribe_id']) for r in entries} != {(r['player_id'],r['tribe_id']) for r in official}:
            raise UserInputError('Mesa aprovada divergente do pareamento oficial.')
    current = db.execute('SELECT player_id,tribe_id,result,deck_id FROM matches WHERE table_id=?',
                         (table_id,)).fetchall()
    by_player = {r['player_id']: r for r in current}
    if len(by_player) != len(current):
        raise UserInputError('Há partidas duplicadas nesta mesa. Corrija antes de continuar.')
    inserted = 0
    for entry in entries:
        r = by_player.get(entry['player_id'])
        if r:
            if (r['tribe_id'], r['result']) != (entry['tribe_id'], entry['result']):
                raise UserInputError('Resultado do ranking diverge da mesa aprovada; revisão manual necessária.')
            continue
        # Evitar duplicar partidas antigas importadas sem vínculo table_id.
        unlinked=db.execute("""SELECT id FROM matches WHERE table_id IS NULL
            AND season_id=? AND event_date=? AND episode=? AND round_no=? AND player_id=?
            LIMIT 1""", (table['season_id'],table['event_date'],table['episode'],
                         table['round_no'],entry['player_id'])).fetchone()
        if unlinked:
            raise UserInputError('Já existe resultado individual nesta rodada. Revise o vínculo da mesa sem duplicar a pontuação.')
        db.execute("""INSERT INTO matches
            (season_id,event_date,episode,round_no,player_id,tribe_id,result,table_id,deck_id)
            VALUES (?,?,?,?,?,?,?,?,?)""",
            (table['season_id'],table['event_date'],table['episode'],table['round_no'],
             entry['player_id'],entry['tribe_id'],entry['result'],table_id,entry['deck_id']))
        inserted += 1
    return inserted


def repair_approved_event_results(db):
    """Migração conservadora: restaura somente registros faltantes de mesas pareadas."""
    repaired = 0
    for row in db.execute("SELECT id FROM game_tables WHERE status='approved' AND pairing_id IS NOT NULL"):
        try:
            # SAVEPOINT: conflito em um registro não deixa importação parcial.
            db.execute('SAVEPOINT repair_table')
            repaired += ensure_approved_table_results(db, row['id'])
            db.execute('RELEASE SAVEPOINT repair_table')
        except (UserInputError, sqlite3.IntegrityError) as err:
            db.execute('ROLLBACK TO SAVEPOINT repair_table')
            db.execute('RELEASE SAVEPOINT repair_table')
            print(f'ATENÇÃO: Mesa aprovada #{row["id"]} requer revisão: {err}', file=sys.stderr)
    if repaired:
        print(f'MIGRAÇÃO DE RESULTADOS: {repaired} registros oficiais recuperados.', file=sys.stderr)
    return repaired


def review_table(db, table_id, approved, note=''):
    row=db.execute('SELECT * FROM game_tables WHERE id=?',(table_id,)).fetchone()
    if not row:raise UserInputError('Mesa não encontrada.')
    if row['status']!='pending':
        raise UserInputError('A mesa já foi revisada. Exclua-a se precisar relançar.')
    db.execute('''UPDATE game_tables SET status=?,reviewed_at=CURRENT_TIMESTAMP,admin_note=? WHERE id=?''',
        ('approved' if approved else 'rejected',note,table_id))
    if approved:
        ensure_approved_table_results(db, table_id)



def throttle_public(ip, kind, limit):
    now=time.time()
    key=(ip,kind)
    with PUBLIC_ACTIONS_LOCK:
        times=[t for t in PUBLIC_ACTIONS.get(key,[]) if now-t<3600]
        if len(times)>=limit:
            raise UserInputError('Limite de envios por hora atingido. Tente mais tarde.')
        times.append(now)
        PUBLIC_ACTIONS[key]=times

def validate_league_event(db, obj):
    season_id = int_id(obj.get('season_id'), 'Temporada')
    if not exists(db, 'seasons', season_id):
        raise UserInputError('Temporada inexistente.')
    return (date_value(obj.get('event_date')),
            txt(obj.get('name'), 'Nome do evento', 120),
            season_id, txt(obj.get('episode'), 'EP do evento', 40))


def validate_event_registration(db, obj):
    player_id = int_id(obj.get('player_id'), 'Jogador')
    tribe_id = int_id(obj.get('tribe_id'), 'Tribo')
    if not exists(db, 'players', player_id) or not exists(db, 'tribes', tribe_id):
        raise UserInputError('Jogador ou tribo inexistente.')
    deck_id = obj.get('deck_id')
    if deck_id in (None, ''):
        deck_id = None
    else:
        deck_id = int_id(deck_id, 'Decklist')
        found = db.execute('SELECT player_id,tribe_id FROM decks WHERE id=?', (deck_id,)).fetchone()
        if not found or found['player_id'] != player_id or found['tribe_id'] != tribe_id:
            raise UserInputError('A decklist não pertence ao jogador e à tribo selecionados.')
    return player_id, tribe_id, deck_id


def public_open_events(db):
    # Somente dados de divulgação, sem divulgar lista de inscritos ou situação de pagamento.
    return [dict(r) for r in db.execute('''
        SELECT e.id,e.name,e.event_date,e.episode,s.name AS season_name,
               (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id=e.id) AS total_registered
        FROM league_events e JOIN seasons s ON s.id=e.season_id
        WHERE e.registrations_open=1 AND e.ended_at IS NULL
        ORDER BY e.event_date,e.id''')]


def event_status_field(value, field):
    if type(value) is not bool:
        raise UserInputError(f'{field} precisa ser verdadeiro ou falso.')
    return int(value)


def list_league_events(db):
    events = [dict(row) for row in db.execute('''
        SELECT e.id,e.name,e.event_date,e.season_id,e.episode,e.registrations_open,e.ended_at,e.rounds_share_token,e.created_at,e.updated_at,
               s.name AS season_name
        FROM league_events e JOIN seasons s ON s.id=e.season_id
        ORDER BY e.event_date DESC,e.id DESC''')]
    registers = [dict(row) for row in db.execute('''
        SELECT er.id,er.event_id,er.player_id,er.tribe_id,er.deck_id,er.checkin,er.paid,er.decklist_ok,er.dropped_after_round,
               er.registered_at,EXISTS(SELECT 1 FROM player_accounts pa WHERE pa.player_id=er.player_id AND pa.active=1) AS has_player_access,p.name AS player_name,t.name AS tribe_name,
               d.name AS deck_name,d.url AS deck_url
        FROM event_registrations er
        JOIN players p ON p.id=er.player_id
        JOIN tribes t ON t.id=er.tribe_id
        LEFT JOIN decks d ON d.id=er.deck_id
        ORDER BY p.name COLLATE NOCASE''')]
    grouped = {ev['id']: [] for ev in events}
    for row in registers:
        if row['event_id'] in grouped:
            grouped[row['event_id']].append(row)
    for ev in events:
        ev['warnings']=[dict(w) for w in db.execute('''SELECT w.id,w.player_id,p.name AS player_name,w.note,w.created_at, a.username AS admin_name
                   FROM event_player_warnings w JOIN players p ON p.id=w.player_id
                   LEFT JOIN admins a ON a.id=w.admin_id WHERE w.event_id=? ORDER BY w.id DESC''',(ev['id'],))]
        ev['rounds'] = event_round_list(db, ev['id'], include_admin_results=True)
        ev['registrations'] = grouped[ev['id']]
        ev['total_registered'] = len(ev['registrations'])
        ev['total_checkin'] = sum(row['checkin'] for row in ev['registrations'])
        ev['total_paid'] = sum(row['paid'] for row in ev['registrations'])
        ev['total_decklists_ok'] = sum(row['decklist_ok'] for row in ev['registrations'])
        ev['active_round'] = any(r['status']=='published' for r in ev['rounds'])
        ev['status'] = ('closed' if ev['ended_at'] else 'active' if ev['active_round'] else 'scheduled')
    return events



def event_round_list(db, event_id, published_only=False, include_admin_results=False):
    # Stable snapshots; public output excludes payment/check-in.
    where = ' AND r.status=\'published\'' if published_only else ''
    rows = [dict(row) for row in db.execute('''SELECT r.id,r.event_id,r.round_no,CASE WHEN r.finalized_at IS NOT NULL THEN 'finished' ELSE r.status END AS status,
                      r.created_at,r.published_at,r.finalized_at,r.pairing_mode,r.pairing_note FROM event_rounds r
                      WHERE r.event_id=?'''+where+' ORDER BY r.round_no', (event_id,))]
    for rnd in rows:
        tables = [dict(t) for t in db.execute('''SELECT id,table_no FROM event_pairings
                         WHERE round_id=? ORDER BY table_no''',(rnd['id'],))]
        for table in tables:
            table['players'] = [dict(r) for r in db.execute('''
                    SELECT pp.player_id,p.name AS player_name,pp.tribe_id,t.name AS tribe_name,
                           pp.deck_id,d.name AS deck_name
                    FROM event_pairing_players pp
                    JOIN players p ON p.id=pp.player_id
                    JOIN tribes t ON t.id=pp.tribe_id
                    LEFT JOIN decks d ON d.id=pp.deck_id
                    WHERE pp.pairing_id=? ORDER BY pp.id''',(table['id'],))]
        for table in tables:
            submissions=db.execute('''SELECT g.id,g.status FROM game_tables g WHERE g.pairing_id=? ORDER BY g.id DESC''',(table['id'],)).fetchall()
            table['result_status']=(next((r['status'] for r in submissions if r['status']=='approved'), None) or next((r['status'] for r in submissions if r['status']=='pending'), None) or (submissions[0]['status'] if submissions else 'not_sent'))
            table['result_count']=len(submissions)
            table['approved_count']=sum(r['status']=='approved' and db.execute('SELECT COUNT(*) AS n FROM matches WHERE table_id=?',(r['id'],)).fetchone()['n']==len(table['players']) for r in submissions)
            table['pending_count']=sum(r['status']=='pending' for r in submissions)
            if include_admin_results:
                # Resultado administrativo do envio oficial, nunca divulgado pelo link publico.
                active = next((r for r in submissions if r['status']=='approved'), None)
                if active is None:
                    active = next((r for r in submissions if r['status']=='pending'), None)
                table['admin_results'] = ({str(row['player_id']): row['result']
                    for row in db.execute('SELECT player_id,result FROM game_table_entries WHERE table_id=?',
                                          (active['id'],))} if active else {})
        rnd['all_approved']=bool(tables) and all(t['approved_count']==1 and t['pending_count']==0 for t in tables)
        rnd['tables'] = tables
    return rows


def published_event_rounds(db, token):
    data=[]
    for event in db.execute('''SELECT DISTINCT e.id,e.name,e.event_date,e.episode,s.name season_name
          FROM league_events e JOIN seasons s ON s.id=e.season_id
          JOIN event_rounds r ON r.event_id=e.id AND r.status='published'
          WHERE e.rounds_share_token=?
          ORDER BY e.event_date DESC,e.id DESC LIMIT 80''',(token,)):
        ev=dict(event)
        ev['rounds']=event_round_list(db,ev['id'],True)
        data.append(ev)
    return data


def event_eligible(db, event_id, round_no=1):
    return [dict(row) for row in db.execute('''SELECT er.player_id,er.tribe_id,er.deck_id,p.name AS player_name
        FROM event_registrations er JOIN players p ON p.id=er.player_id
        WHERE er.event_id=? AND er.checkin=1 AND er.paid=1 AND (er.dropped_after_round IS NULL OR er.dropped_after_round>=?)
        ORDER BY p.name COLLATE NOCASE''',(event_id,round_no))]


def player_personal_results(db, player_id, season_arg='all'):
    # Estatísticas privadas; somente matches aprovadas pontuam.
    seasons = [dict(r) for r in db.execute('''SELECT s.id, s.name FROM seasons s
        WHERE EXISTS (SELECT 1 FROM matches m WHERE m.season_id=s.id AND m.player_id=?)
           OR EXISTS (SELECT 1 FROM event_registrations er
                      JOIN league_events e ON e.id=er.event_id
                      WHERE er.player_id=? AND e.season_id=s.id)
        ORDER BY s.sort_order, s.id''', (player_id, player_id))]
    if str(season_arg) not in ('', 'all') and not any(str(i['id']) == str(season_arg) for i in seasons):
        raise UserInputError('Temporada indisponível para este jogador.')
    selected = str(season_arg or 'all')
    view = public_view(db, selected)
    profile = next((p for p in view['player_profiles'] if p['id'] == player_id), None)
    if profile is None:
        row = db.execute('SELECT name FROM players WHERE id=?', (player_id,)).fetchone()
        if not row:raise UserInputError('Jogador não encontrado.')
        profile = {'id': player_id, 'name': row['name'], 'points': 0,
                   'matches': 0, 'wins': 0, 'draws': 0, 'losses': 0,
                   'win_rate': 0, 'tribes': [], 'decks': [], 'excluded_matches': 0}
    ranks = [r for r in view['ranking'] if r['player_id'] == player_id]
    args = [player_id]
    clause = ''
    if selected != 'all':
        clause = ' AND m.season_id=?'
        args.append(int(selected))
    matches = [dict(r) for r in db.execute('''SELECT m.event_date,m.episode,m.round_no,
          m.result, s.name AS season_name, t.name AS tribe_name,
          COALESCE(d.name,'') AS deck_name,
          CASE WHEN x.tribe_id IS NOT NULL THEN 1 ELSE 0 END AS excluded
        FROM matches m
        JOIN seasons s ON s.id=m.season_id
        JOIN tribes t ON t.id=m.tribe_id
        LEFT JOIN decks d ON d.id=m.deck_id
        LEFT JOIN exclusions x ON x.season_id=m.season_id AND x.tribe_id=m.tribe_id
        WHERE m.player_id=?''' + clause + '''
        ORDER BY m.event_date DESC,m.round_no DESC,m.id DESC LIMIT 60''', args)]
    for match in matches:
        match['points'] = 0 if match['excluded'] else RULES.get(match['result'], 0)
    return {'player_id': player_id, 'season_id': selected, 'seasons': seasons,
            'profile': profile, 'ranking_entries': ranks, 'recent_matches': matches}


def player_assigned_rounds(db, player_id):
    rounds=[]
    assignments=db.execute('''SELECT pair.id AS pairing_id,pair.table_no,rd.round_no,
       e.name AS event_name,e.event_date,e.episode,s.name AS season_name
       FROM event_pairing_players mine JOIN event_pairings pair ON pair.id=mine.pairing_id
       JOIN event_rounds rd ON rd.id=pair.round_id AND rd.status='published'
       JOIN league_events e ON e.id=rd.event_id
       JOIN seasons s ON s.id=e.season_id
       JOIN event_registrations reg ON reg.event_id=e.id AND reg.player_id=mine.player_id
       WHERE mine.player_id=? AND NOT EXISTS (SELECT 1 FROM game_tables done
         WHERE done.pairing_id=pair.id AND done.status='approved')
       ORDER BY e.event_date DESC,rd.round_no DESC''',(player_id,)).fetchall()
    for a in assignments:
        item=dict(a)
        item['players']=[dict(p) for p in db.execute('''SELECT pp.player_id,p.name AS player_name,t.name AS tribe_name
           FROM event_pairing_players pp JOIN players p ON p.id=pp.player_id
           JOIN tribes t ON t.id=pp.tribe_id
           WHERE pp.pairing_id=? ORDER BY pp.id''',(a['pairing_id'],))]
        prev=db.execute('''SELECT status,id FROM game_tables WHERE pairing_id=?
             ORDER BY id DESC LIMIT 1''',(a['pairing_id'],)).fetchone()
        item['status']=prev['status'] if prev else 'not_sent'
        item['submission_id']=prev['id'] if prev else None
        item['submitted_results'] = ({str(r['player_id']): r['result'] for r in db.execute(
            'SELECT player_id,result FROM game_table_entries WHERE table_id=?', (prev['id'],))}
            if prev and prev['status'] in ('pending', 'approved') else {})
        rounds.append(item)
    return rounds


def event_player_points(db, ev, before_round):
    points={}
    # Only approved results from this particular date/season/episode count.
    for row in db.execute('''SELECT m.player_id,m.result,m.tribe_id,
          EXISTS(SELECT 1 FROM exclusions x WHERE x.season_id=m.season_id AND x.tribe_id=m.tribe_id) excluded
          FROM matches m WHERE m.season_id=? AND m.event_date=? AND m.episode=?
          AND m.round_no<?''', (ev['season_id'],ev['event_date'],ev['episode'],before_round)):
        points[row['player_id']]=points.get(row['player_id'],0)+(0 if row['excluded'] else RULES.get(row['result'],0))
    return points


def pairing_sizes(n):
    if n<3:
        raise UserInputError('São necessários pelo menos 3 jogadores com check-in e pagamento para gerar uma rodada.')
    # Any n>=6 and n in (3,4) can be partitioned into 3/4 player tables,
    # except n=5. Minimize the number of 3-player tables.
    for threes in range(n//3+1):
        if (n-3*threes)>=0 and (n-3*threes)%4==0:
            return [4]*((n-3*threes)//4)+[3]*threes
    raise UserInputError('Não é possível distribuir esse total em mesas de 3 ou 4, sem bye. São necessários 3, 4 ou pelo menos 6 jogadores aptos (5 não é possível).')


def choose_event_pairings(db, event, round_no, eligible, mode='auto'):
    '''Multiplayer Swiss: strict homogeneous points/no rematch if feasible; otherwise best-effort pods.

    'True Swiss' is a *Bloodline adaptation* for pods, not a certified FIDE/1v1 pairing.
    Only approved results count; dropped users are filtered before calling this.
    '''
    if mode not in ('auto','true_swiss','swiss'):
        raise UserInputError('Método de pareamento inválido.')
    sizes=pairing_sizes(len(eligible))
    pts=event_player_points(db,event,round_no)
    history=set()
    for row in db.execute('''SELECT a.player_id AS a,b.player_id AS b
        FROM event_rounds r JOIN event_pairings t ON t.round_id=r.id
        JOIN event_pairing_players a ON a.pairing_id=t.id
        JOIN event_pairing_players b ON b.pairing_id=t.id AND a.player_id<b.player_id
        WHERE r.event_id=? AND (r.status='published' OR r.finalized_at IS NOT NULL) AND r.round_no<?''',
        (event['id'],round_no)):
        history.add((row['a'],row['b']))
    def collided(a,b):
        return tuple(sorted((a['player_id'],b['player_id']))) in history
    rng=random.Random(f"Bloodline:{event['id']}:{round_no}:{len(eligible)}")
    groups_by_points={}
    for p in eligible:
        groups_by_points.setdefault(pts.get(p['player_id'],0),[]).append(p)
    # Strict matching requires same approved-point group AND no prior shared pod.
    # Exhaustive bounded backtracking for each score group (fast paths for round 1).
    def strict_group(group):
        if len(group)<3 or len(group)==5:return None
        choices=pairing_sizes(len(group))
        group=sorted(group,key=lambda x:x['player_id'])
        rng.shuffle(group)
        if not any(collided(a,b) for i,a in enumerate(group) for b in group[i+1:]):
            result=[];idx=0
            for size in choices:result.append(group[idx:idx+size]);idx+=size
            return result
        from itertools import combinations
        # Search with iteration cap; if it fails the fallback can still find good pods.
        budget=[20000]
        def visit(remaining, sizes_left):
            budget[0]-=1
            if budget[0]<0:return None
            if not sizes_left:return [] if not remaining else None
            pivot=remaining[0]
            for size in sorted(set(sizes_left),reverse=True):
                if size>len(remaining):continue
                for combo in combinations(remaining[1:],size-1):
                    pod=(pivot,)+combo
                    if any(collided(a,b) for i,a in enumerate(pod) for b in pod[i+1:]):continue
                    ids={p['player_id'] for p in pod}
                    rest=[x for x in remaining if x['player_id'] not in ids]
                    next_sizes=list(sizes_left);next_sizes.remove(size)
                    found=visit(rest,next_sizes)
                    if found is not None:return [list(pod)]+found
                    if budget[0]<0:return None
            return None
        return visit(group,choices)
    if mode!='swiss':
        strict=[]
        for value in sorted(groups_by_points,reverse=True):
            group=strict_group(groups_by_points[value])
            if group is None:break
            strict.extend(group)
        else:
            return strict,'true_swiss','Mesas com pontuação idêntica e sem adversários repetidos.'
        if mode=='true_swiss':
            raise UserInputError('True Swiss estrito não é possível com estes grupos de pontuação e histórico. Selecione Automático ou Swiss.')
    # Fallback: Swiss pods, balance score delta and penalize repeat encounters.
    players=list(eligible)
    rng.shuffle(players)
    players.sort(key=lambda p:-pts.get(p['player_id'],0))
    def groups_from(order):
        groups=[];offset=0
        for size in sizes:
            groups.append(order[offset:offset+size]);offset+=size
        return groups
    def score(groups):
        cost=0
        for group in groups:
            for i,a in enumerate(group):
                for b in group[i+1:]:
                    cost+=1000 if collided(a,b) else 0
                    cost+=abs(pts.get(a['player_id'],0)-pts.get(b['player_id'],0))*12
        return cost
    best=None;best_score=float('inf')
    for attempt in range(12 if len(players)<=40 else 3):
        if attempt:
            rng.shuffle(players)
            players.sort(key=lambda p:(-pts.get(p['player_id'],0),rng.random()))
        candidate=groups_from(players)
        best_cost=score(candidate)
        for _ in range(3):
            changed=False
            for a in range(len(candidate)):
                for b in range(a+1,len(candidate)):
                    for i in range(len(candidate[a])):
                        for j in range(len(candidate[b])):
                            candidate[a][i],candidate[b][j]=candidate[b][j],candidate[a][i]
                            value=score(candidate)
                            if value<best_cost:
                                best_cost=value;changed=True
                            else:
                                candidate[a][i],candidate[b][j]=candidate[b][j],candidate[a][i]
            if not changed:break
        if best_cost<best_score:
            best_score=best_cost;best=[g[:] for g in candidate]
    repeated=sum(collided(a,b) for group in best for i,a in enumerate(group) for b in group[i+1:])
    note='Swiss por proximidade de pontos; ' + ('sem reencontros.' if repeated==0 else f'{repeated} par(es) de adversários repetidos, inevitáveis na otimização encontrada.')
    if mode=='auto':note='True Swiss estrito inviável; '+note
    return best,'swiss',note


def event_result_groups(db):
    """Agrupa resultados pelo identificador legado (temporada, data, EP).

    Inclui eventos excluídos antes desta versão. Resultados importados sem
    vínculo de mesa são identificados pelo mesmo trio, sem adivinhar identidades.
    """
    rows = db.execute("""SELECT season_id,event_date,episode FROM matches
        UNION SELECT season_id,event_date,episode FROM game_tables""").fetchall()
    groups = []
    for row in rows:
        sid, dt, ep = row['season_id'], row['event_date'], row['episode']
        ev = db.execute("""SELECT id,name,ended_at FROM league_events
            WHERE season_id=? AND event_date=? AND episode=?""", (sid,dt,ep)).fetchone()
        matches = db.execute("""SELECT COUNT(*) AS n FROM matches
            WHERE season_id=? AND event_date=? AND episode=?""", (sid,dt,ep)).fetchone()['n']
        tables = db.execute("""SELECT COUNT(*) AS n FROM game_tables
            WHERE season_id=? AND event_date=? AND episode=?""", (sid,dt,ep)).fetchone()['n']
        season = db.execute('SELECT name FROM seasons WHERE id=?',(sid,)).fetchone()
        finished = bool(ev and ev['ended_at'])
        groups.append({'season_id':sid,'season_name':season['name'] if season else '—',
            'event_date':dt,'episode':ep,'event_id':ev['id'] if ev else None,
            'event_name':ev['name'] if ev else 'Evento não encontrado na agenda',
            'ended':finished, 'can_purge':not ev or finished,
            'matches':matches,'tables':tables})
    return sorted(groups,key=lambda g:(g['event_date'],g['season_id'],g['episode']),reverse=True)


def backup_before_purge():
    """Cópia transacional no volume, criada antes de qualquer DELETE.

    Usuário também pode baixar o banco completo fora do servidor.
    """
    path = DB_PATH.parent / 'backups'
    path.mkdir(parents=True,exist_ok=True)
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    dest=path / f'antes_limpeza_{stamp}_{secrets.token_hex(3)}.db'
    try:
        with closing(sqlite3.connect(DB_PATH)) as original, closing(sqlite3.connect(dest)) as copy:
            original.backup(copy)
    except Exception:
        dest.unlink(missing_ok=True)
        raise UserInputError('Não foi possível criar o backup. Operação cancelada.')
    return dest.name


def purge_event_results(db, season_id, event_date, episode, admin_id, event_name=None):
    """Exclusão integral, em uma transação: não deixa mesa para repontuar depois.

    O trio temporada/data/EP identifica o lote legado. Cabe ao administrador
    conferir a prévia, pois também inclui registros antigos sem table_id.
    """
    evs=db.execute("""SELECT id,name,ended_at FROM league_events
        WHERE season_id=? AND event_date=? AND episode=?""",(season_id,event_date,episode)).fetchall()
    if any(e['ended_at'] is None for e in evs):
        raise UserInputError('Encerre o evento antes de apagar definitivamente seus resultados.')
    for event in evs:
        rounds=db.execute('SELECT finalized_at FROM event_rounds WHERE event_id=?',(event['id'],)).fetchall()
        if any(r['finalized_at'] is None for r in rounds):
            raise UserInputError('Há rodadas não finalizadas. Finalize antes da limpeza.')
    m=db.execute("""SELECT COUNT(*) AS n FROM matches WHERE season_id=? AND event_date=? AND episode=?""",
                 (season_id,event_date,episode)).fetchone()['n']
    g=db.execute("""SELECT COUNT(*) AS n FROM game_tables WHERE season_id=? AND event_date=? AND episode=?""",
                 (season_id,event_date,episode)).fetchone()['n']
    if not m and not g:
        raise UserInputError('Nenhuma partida ou mesa encontrada para esse EP.')
    # Nunca modificar o banco se o backup consistente falhar.
    backup_name=backup_before_purge()
    db.execute("""DELETE FROM matches WHERE season_id=? AND event_date=? AND episode=?""",
               (season_id,event_date,episode))
    # Elimina também pendentes/rejeitadas, evitando vínculos mortos e recontagem.
    db.execute("""DELETE FROM game_tables WHERE season_id=? AND event_date=? AND episode=?""",
               (season_id,event_date,episode))
    for event in evs:
        db.execute('DELETE FROM event_rounds WHERE event_id=?',(event['id'],))
        db.execute('DELETE FROM league_events WHERE id=?',(event['id'],))
    db.execute("""INSERT INTO result_purge_audit
          (season_id,event_date,episode,event_name,removed_matches,removed_tables,admin_id)
          VALUES (?,?,?,?,?,?,?)""",
          (season_id,event_date,episode,event_name or (evs[0]['name'] if evs else None),m,g,admin_id))
    return {'matches_removed':m,'tables_removed':g,'backup_created':backup_name}


def close_league_event(db, event_id):
    ev = db.execute('SELECT * FROM league_events WHERE id=?',(event_id,)).fetchone()
    if not ev:raise UserInputError('Evento não encontrado.')
    if ev['ended_at']:raise UserInputError('Este evento já está encerrado.')
    rounds=db.execute('SELECT * FROM event_rounds WHERE event_id=? ORDER BY round_no',(event_id,)).fetchall()
    if not rounds:
        raise UserInputError('Para encerrar o evento, finalize pelo menos uma rodada. Eventos sem rodadas podem ser excluídos.')
    if any(r['finalized_at'] is None for r in rounds):
        raise UserInputError('Finalize todas as rodadas e aprove suas mesas antes de encerrar o evento.')
    # A finalização de cada rodada já verificou que a mesa tem exatamente um
    # resultado aprovado e o número correto de partidas oficiais.
    db.execute('UPDATE league_events SET ended_at=CURRENT_TIMESTAMP,registrations_open=0,updated_at=CURRENT_TIMESTAMP WHERE id=?',(event_id,))


def next_event_round_no(db,event_id):
    rows=db.execute('SELECT round_no,finalized_at FROM event_rounds WHERE event_id=? ORDER BY round_no',(event_id,)).fetchall()
    if not rows:return 1
    unfinished=[r for r in rows if r['finalized_at'] is None]
    if unfinished:return unfinished[0]['round_no']
    return rows[-1]['round_no']+1


def generate_event_round(db, event_id, round_no, regenerate=False, mode='auto'):
    ev=db.execute('SELECT * FROM league_events WHERE id=?',(event_id,)).fetchone()
    if not ev:raise UserInputError('Evento não encontrado.')
    if ev['ended_at']:raise UserInputError('Este evento já foi encerrado.')
    if not (1<=round_no<=12):raise UserInputError('Número da rodada deve estar entre 1 e 12.')
    expected=next_event_round_no(db,event_id)
    if round_no!=expected:raise UserInputError(f'A próxima rodada permitida é a {expected}. Finalize a anterior antes de avançar.')
    existing=db.execute('SELECT * FROM event_rounds WHERE event_id=? AND round_no=?',(event_id,round_no)).fetchone()
    if existing and (existing['status']=='published' or existing['finalized_at']):
        raise UserInputError('Rodada publicada ou finalizada não pode ser regenerada.')
    if existing and not regenerate:
        raise UserInputError('Rodada já gerada. Use Regenerar para substituir o rascunho.')
    eligible=event_eligible(db,event_id,round_no)
    groups,actual_mode,note=choose_event_pairings(db,ev,round_no,eligible,mode)
    if existing:
        if db.execute('''SELECT 1 FROM game_tables g JOIN event_pairings p ON p.id=g.pairing_id
                     WHERE p.round_id=? LIMIT 1''',(existing['id'],)).fetchone():
            raise UserInputError('Este rascunho possui resultados vinculados. Preserve o histórico.')
        db.execute('DELETE FROM event_rounds WHERE id=?',(existing['id'],))
    rnd_id=db.execute('''INSERT INTO event_rounds(event_id,round_no,pairing_mode,pairing_note)
      VALUES (?,?,?,?)''',(event_id,round_no,actual_mode,note)).lastrowid
    for index,group in enumerate(groups,1):
        pairing_id=db.execute('INSERT INTO event_pairings(round_id,table_no) VALUES (?,?)',(rnd_id,index)).lastrowid
        for player in group:
            db.execute('''INSERT INTO event_pairing_players(round_id,pairing_id,player_id,tribe_id,deck_id)
                VALUES(?,?,?,?,?)''',(rnd_id,pairing_id,player['player_id'],player['tribe_id'],player['deck_id']))
    # A partir da elaboração do pareamento, a lista de inscritos é congelada.
    db.execute('UPDATE league_events SET registrations_open=0,updated_at=CURRENT_TIMESTAMP WHERE id=?',
               (event_id,))
    return rnd_id


def submit_admin_pairing_result(db, event_id, round_no, pairing_id, raw_entries):
    """Lançamento oficial de uma mesa pareada. O resultado é aprovado na mesma transação.

    Não aceita alteração de mesas aprovadas ou com envios pendentes: nesses casos,
    deve-se usar a revisão administrativa existente, para não duplicar pontuação.
    """
    pairing = db.execute("""SELECT ep.id,ep.table_no,r.id AS round_id,r.status,r.finalized_at,
                      ev.season_id,ev.event_date,ev.episode,ev.ended_at
        FROM event_pairings ep JOIN event_rounds r ON r.id=ep.round_id
        JOIN league_events ev ON ev.id=r.event_id
        WHERE ep.id=? AND r.event_id=? AND r.round_no=?""",
        (pairing_id,event_id,round_no)).fetchone()
    if not pairing:
        raise UserInputError('Mesa não encontrada neste evento e rodada.')
    if pairing['ended_at'] or pairing['finalized_at'] is not None or pairing['status']!='published':
        raise UserInputError('O administrador só pode lançar resultados em rodadas publicadas e não finalizadas.')
    if db.execute("""SELECT id FROM game_tables WHERE pairing_id=? AND status='approved'
                LIMIT 1""", (pairing_id,)).fetchone():
        raise UserInputError('Esta mesa já foi aprovada e pontuada. Não é possível lançar novamente.')
    if db.execute("""SELECT id FROM game_tables WHERE pairing_id=? AND status='pending'
                LIMIT 1""", (pairing_id,)).fetchone():
        raise UserInputError('Há um resultado pendente nesta mesa. Revise-o em Mesas para aprovar antes de lançar outro.')
    members=db.execute("""SELECT player_id,tribe_id,deck_id FROM event_pairing_players
        WHERE pairing_id=? ORDER BY id""", (pairing_id,)).fetchall()
    if not isinstance(raw_entries,list) or len(raw_entries)!=len(members):
        raise UserInputError('Selecione o resultado de cada jogador da mesa.')
    choices={}
    for entry in raw_entries:
        if not isinstance(entry,dict):
            raise UserInputError('Resultado de jogador inválido.')
        pid=int_id(entry.get('player_id'),'Jogador')
        if pid in choices:
            raise UserInputError('Jogador repetido na mesa.')
        choices[pid]=get_result(entry.get('result'))
    if set(choices)!={m['player_id'] for m in members}:
        raise UserInputError('Os participantes devem corresponder ao pareamento oficial.')
    header,entries=validate_table(db,{
        'season_id':pairing['season_id'],'event_date':pairing['event_date'],
        'episode':pairing['episode'],'round_no':round_no,
        'table_no':pairing['table_no'],
        'entries':[{'player_id':m['player_id'],'tribe_id':m['tribe_id'],
                    'deck_id':m['deck_id'],'result':choices[m['player_id']]}
                   for m in members]})
    # Não passar approved=True aqui: o vínculo oficial deve ser gravado ANTES
    # da revisão e da inclusão das partidas no ranking.
    table_id=create_table(db,header,entries,False)
    db.execute('UPDATE game_tables SET pairing_id=? WHERE id=?',(pairing_id,table_id))
    review_table(db,table_id,True,'Lançado e aprovado pela administração do evento.')
    return table_id


def finalize_event_round(db,event_id,round_no):
    rnd=db.execute('SELECT * FROM event_rounds WHERE event_id=? AND round_no=?',(event_id,round_no)).fetchone()
    if not rnd:raise UserInputError('Rodada não encontrada.')
    if rnd['finalized_at']:raise UserInputError('Rodada já finalizada.')
    if rnd['status']!='published':raise UserInputError('Publique a rodada antes de finalizá-la.')
    tables=db.execute('SELECT id FROM event_pairings WHERE round_id=?',(rnd['id'],)).fetchall()
    if not tables:raise UserInputError('Rodada sem mesas.')
    for t in tables:
        submitted=db.execute('SELECT id,status FROM game_tables WHERE pairing_id=?',(t['id'],)).fetchall()
        approved=[x for x in submitted if x['status']=='approved']
        if len(approved)!=1 or any(x['status']=='pending' for x in submitted):
            raise UserInputError('Todas as mesas precisam ter exatamente um resultado aprovado para finalizar a rodada.')
        players=db.execute('SELECT player_id FROM event_pairing_players WHERE pairing_id=?',(t['id'],)).fetchall()
        entries=db.execute('SELECT player_id FROM game_table_entries WHERE table_id=?',(approved[0]['id'],)).fetchall()
        if sorted(r['player_id'] for r in players)!=sorted(r['player_id'] for r in entries):
            raise UserInputError('Uma mesa aprovada não corresponde ao pareamento. Confira a moderação.')
        match_count=db.execute('SELECT COUNT(*) AS n FROM matches WHERE table_id=?',(approved[0]['id'],)).fetchone()['n']
        if match_count!=len(players):
            raise UserInputError('A mesa foi aprovada, mas seus resultados oficiais estão incompletos. Revise antes de finalizar.')
    db.execute("UPDATE event_rounds SET finalized_at=CURRENT_TIMESTAMP,status='draft' WHERE id=?",(rnd['id'],))


def update_event_round_status(db,event_id,round_no,publish):
    event=db.execute('SELECT ended_at FROM league_events WHERE id=?',(event_id,)).fetchone()
    if not event:raise UserInputError('Evento não encontrado.')
    if event['ended_at']:raise UserInputError('Evento encerrado não pode ter rodadas publicadas.')
    rnd=db.execute('SELECT * FROM event_rounds WHERE event_id=? AND round_no=?',(event_id,round_no)).fetchone()
    if not rnd:raise UserInputError('Rodada não encontrada.')
    if rnd['finalized_at']:raise UserInputError('Rodada finalizada é somente leitura.')
    new='published' if publish else 'draft'
    if not publish and db.execute('''SELECT 1 FROM game_tables g JOIN event_pairings p ON g.pairing_id=p.id
                             WHERE p.round_id=? AND g.status IN ('pending','approved')''',(rnd['id'],)).fetchone():
        raise UserInputError('Rodada com resultado enviado ou aprovado não pode ser despublicada.')
    if rnd['status']==new:raise UserInputError('Rodada já está com esse status.')
    if not publish and db.execute("SELECT 1 FROM event_rounds WHERE event_id=? AND round_no>? AND status='published'",(event_id,round_no)).fetchone():
        raise UserInputError('Despublique primeiro as rodadas posteriores.')
    if publish:
        sizes=[r['cnt'] for r in db.execute('''SELECT COUNT(*) cnt FROM event_pairing_players pp
          JOIN event_pairings p ON pp.pairing_id=p.id WHERE p.round_id=? GROUP BY p.id''',(rnd['id'],))]
        if not sizes or any(n not in (3,4) for n in sizes):raise UserInputError('Pareamento incompleto. Mesas precisam ter 3 ou 4 jogadores.')
    db.execute('UPDATE event_rounds SET status=?, published_at=CASE WHEN ?=\'published\' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?',(new,new,rnd['id']))
    if publish:
        db.execute('UPDATE league_events SET registrations_open=0,updated_at=CURRENT_TIMESTAMP WHERE id=?',(event_id,))


def swap_event_round_players(db,event_id,round_no,first,second):
    rnd=db.execute('SELECT * FROM event_rounds WHERE event_id=? AND round_no=?',(event_id,round_no)).fetchone()
    if not rnd or rnd['status']!='draft' or rnd['finalized_at']:raise UserInputError('Somente rascunhos podem ser ajustados.')
    if first==second:raise UserInputError('Selecione dois jogadores diferentes.')
    rows=db.execute('''SELECT id,pairing_id,player_id FROM event_pairing_players
             WHERE round_id=? AND player_id IN (?,?)''',(rnd['id'],first,second)).fetchall()
    if len(rows)!=2:raise UserInputError('Os dois jogadores devem estar nesta rodada.')
    a,b=rows
    if a['pairing_id']==b['pairing_id']:raise UserInputError('Os jogadores já estão na mesma mesa.')
    db.execute('UPDATE event_pairing_players SET pairing_id=? WHERE id=?',(b['pairing_id'],a['id']))
    db.execute('UPDATE event_pairing_players SET pairing_id=? WHERE id=?',(a['pairing_id'],b['id']))
    db.execute("UPDATE event_rounds SET pairing_note=pairing_note || ' Ajuste manual de mesas.' WHERE id=?",(rnd['id'],))



class Handler(BaseHTTPRequestHandler):
    server_version = 'BloodlineBI/2.3.4'

    def log_message(self, fmt, *args):
        print('%s - %s' % (self.address_string(), fmt % args))

    def _common_headers(self):
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

    def respond(self, code, content, content_type='application/json; charset=utf-8', extra=None):
        if isinstance(content, (dict,list)):
            content = json.dumps(content, ensure_ascii=False).encode('utf-8')
        elif isinstance(content,str):
            content = content.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(content)))
        self._common_headers()
        if extra:
            for k,v in extra.items():
                self.send_header(k,v)
        self.end_headers()
        self.wfile.write(content)

    def _cookie(self, cookie_name='bl_session'):
        c = SimpleCookie()
        try:
            c.load(self.headers.get('Cookie',''))
        except Exception:
            return ''
        m = c.get(cookie_name)
        return m.value if m else ''

    def current_admin(self):
        token = self._cookie()
        if not re.fullmatch('[a-f0-9]{64}', token):
            return None
        hashed = hashlib.sha256(token.encode('ascii')).hexdigest()
        with conn_db() as db:
            return db.execute("SELECT a.id,a.username,a.role,a.active FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at>? AND a.active=1",
                (hashed, int(time.time()))).fetchone()

    def current_player(self):
        token=self._cookie('bl_player')
        if not re.fullmatch('[a-f0-9]{64}',token):return None
        hashed=hashlib.sha256(token.encode('ascii')).hexdigest()
        with conn_db() as db:
            return db.execute('''SELECT p.id,p.name FROM player_sessions ps
                  JOIN player_accounts pa ON pa.player_id=ps.player_id
                  JOIN players p ON p.id=pa.player_id
                  WHERE ps.token_hash=? AND ps.expires_at>? AND pa.active=1 AND pa.approval_status='approved' ''',
                  (hashed,int(time.time()))).fetchone()

    def authed(self):
        return self.current_admin() is not None

    def require_admin(self):
        if not self.authed():
            self.respond(401, {'error':'Acesso administrativo necessário.'})
            return False
        return True

    def require_owner(self):
        admin = self.current_admin()
        if admin is None:
            self.respond(401, {'error':'Acesso administrativo necessário.'})
            return False
        if admin['role'] != 'owner':
            self.respond(403, {'error':'Apenas a conta principal pode gerenciar administradores.'})
            return False
        return True

    def read_json(self):
        if self.headers.get('Content-Type','').split(';')[0].strip() != 'application/json':
            raise UserInputError('Envie JSON (Content-Type: application/json).')
        if self.headers.get('X-Bloodline-Request') != '1':
            raise UserInputError('Cabeçalho de proteção ausente.')
        origin = self.headers.get('Origin','')
        if origin:
            host = self.headers.get('Host','')
            if origin not in ('http://' + host, 'https://' + host):
                raise UserInputError('Origem não autorizada.')
        n = int(self.headers.get('Content-Length','0'))
        if n < 0 or n > 3_000_000:
            raise UserInputError('Requisição grande demais (limite de 3 MB).')
        try:
            obj = json.loads(self.rfile.read(n))
            if not isinstance(obj,dict):
                raise ValueError()
            return obj
        except (json.JSONDecodeError,ValueError):
            raise UserInputError('JSON inválido.')

    def import_uploaded_database(self):
        """Importa um snapshot SQLite pelo navegador, sem substituir o banco nem admins.

        O arquivo chega como octet-stream; nada é enviado ao GitHub ou servido
        pela aplicação. Recuperação e backups usam o mesmo importador já testado.
        """
        if not self.require_owner():
            return
        if self.headers.get('X-Bloodline-Request') != '1':
            raise UserInputError('Cabeçalho de proteção ausente.')
        origin = self.headers.get('Origin', '')
        host = self.headers.get('Host', '')
        if origin and origin not in ('http://' + host, 'https://' + host):
            raise UserInputError('Origem não autorizada.')
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/octet-stream':
            raise UserInputError('Formato de envio inválido. Selecione um arquivo .db.')
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise UserInputError('Tamanho do arquivo inválido.')
        max_size = 64 * 1024 * 1024
        if size < 100 or size > max_size:
            raise UserInputError('O banco deve ter entre 100 bytes e 64 MB.')

        # Criar temporário fora do diretório público e nunca escrever sobre
        # bloodline.db. O tamanho é limitado antes da leitura.
        with tempfile.TemporaryDirectory(prefix='bloodline_upload_') as work:
            source_file = Path(work) / 'importado.db'
            with source_file.open('wb') as output:
                remaining = size
                while remaining:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        raise UserInputError('Upload interrompido. Tente novamente.')
                    output.write(chunk)
                    remaining -= len(chunk)
            with source_file.open('rb') as check:
                if check.read(16) != b'SQLite format 3\x00':
                    raise UserInputError('O arquivo selecionado não é um banco SQLite válido.')
            from recuperar_banco import migrate, RecoveryError
            # Bloqueia gravações concorrentes durante a importação e criação
            # de backups; resultados já importados não serão duplicados.
            with DB_LOCK:
                # A conta pode ter sido desativada enquanto recebíamos o upload.
                admin = self.current_admin()
                if admin is None or admin['role'] != 'owner':
                    return self.respond(403, {'error': 'Apenas a conta principal pode importar bancos.'})
                try:
                    result = migrate(source_file, DB_PATH, DB_PATH.parent / 'backups')
                except RecoveryError as error:
                    return self.respond(409, {'error': str(error)})
            summary = {
                'ok': True,
                'found': result['source_counts'],
                'inserted': result['inserted'],
                'totals': result['dest_counts'],
                'admins_preserved': result['admins_preserved'],
                'backup_created': bool(result['backup']),
            }
            return self.respond(200, summary)

    def do_GET(self):
        try:
            target = urlparse(self.path)
            path = target.path
            query = parse_qs(target.query)
            season = query.get('season',['all'])[0]
            if path in ('/','/index.html','/static/style.css','/static/app.js'):
                file_map = {'/': 'index.html','/index.html':'index.html','/static/style.css':'style.css','/static/app.js':'app.js'}
                f = ROOT / 'static' / file_map[path]
                typ = 'text/html; charset=utf-8' if f.suffix=='.html' else ('text/css; charset=utf-8' if f.suffix=='.css' else 'application/javascript; charset=utf-8')
                return self.respond(200,f.read_bytes(),typ)
            if path == '/api/events/rounds':
                token=query.get('token',[''])[0]
                if not re.fullmatch(r'[A-Za-z0-9_-]{35,120}',token):
                    return self.respond(403,{'error':'Link privado de rodadas obrigatório.'})
                with conn_db() as db:
                    return self.respond(200,{'events':published_event_rounds(db,token)})
            if path == '/api/admin/player-accounts':
                if not self.require_admin():return
                with conn_db() as db:
                    return self.respond(200,{'accounts':list_player_access_requests(db)})
            if path == '/api/player/session':
                player=self.current_player()
                return self.respond(200, {'player':bool(player), 'id':player['id'] if player else None,
                                          'name':player['name'] if player else None})
            if path == '/api/player/my-rounds':
                player=self.current_player()
                if player is None:return self.respond(401,{'error':'Entre na área do jogador.'})
                with conn_db() as db:
                    return self.respond(200,{'rounds':player_assigned_rounds(db,player['id'])})
            if path == '/api/player/my-results':
                player=self.current_player()
                if player is None:return self.respond(401,{'error':'Entre na área do jogador.'})
                with conn_db() as db:
                    return self.respond(200,player_personal_results(db,player['id'],season))
            if path == '/api/events/open':
                with conn_db() as db:
                    return self.respond(200, {'events':public_open_events(db)})
            qr_match = re.fullmatch(r'/api/admin/events/(\d+)/qrcode.svg', path)
            if qr_match:
                if not self.require_admin():return
                event_id = int(qr_match.group(1))
                with conn_db() as db:
                    if not exists(db, 'league_events', event_id):
                        return self.respond(404, {'error':'Evento não encontrado.'})
                host = self.headers.get('Host','')
                if not re.fullmatch(r'[A-Za-z0-9.\-]+(?::[0-9]{1,5})?', host):
                    raise UserInputError('Domínio inválido para gerar QR Code.')
                link = ('https' if COOKIE_SECURE else 'http') + '://' + host + '/?inscricao=' + str(event_id)
                import qrcode
                qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=4)
                qr.add_data(link)
                qr.make(fit=True)
                matrix = qr.get_matrix()
                n = len(matrix)
                # Desenha o código como SVG vetorial. Sem serviços de terceiros.
                pieces = []
                for y, line in enumerate(matrix):
                    x=0
                    while x < n:
                        if not line[x]:
                            x+=1;continue
                        start=x
                        while x < n and line[x]: x+=1
                        pieces.append(f'M{start} {y}h{x-start}v1H{start}z')
                svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" shape-rendering="crispEdges"><rect width="{n}" height="{n}" fill="white"/><path d="{" ".join(pieces)}" fill="black"/></svg>'
                return self.respond(200,svg,'image/svg+xml; charset=utf-8')
            if path == '/api/health':
                return self.respond(200,{'ok':True,'admin_configured':True})
            if path == '/api/session':
                admin = self.current_admin()
                return self.respond(200,{'admin':bool(admin),'admin_configured':True,
                    'username':admin['username'] if admin else None,
                    'role':admin['role'] if admin else None,
                    'can_manage_admins':bool(admin and admin['role']=='owner')})
            if path == '/api/admin/result-groups':
                if not self.require_owner():return
                with conn_db() as db:
                    return self.respond(200,{'groups':event_result_groups(db)})
            if path == '/api/admin/download-database':
                if not self.require_owner():return
                # SQLite Backup API inclui transações WAL já confirmadas.
                with DB_LOCK:
                    with tempfile.TemporaryDirectory() as d:
                        snapshot=Path(d)/'bloodline_backup.db'
                        with closing(sqlite3.connect(DB_PATH)) as original,closing(sqlite3.connect(snapshot)) as copy:
                            original.backup(copy)
                        content=snapshot.read_bytes()
                return self.respond(200,content,'application/octet-stream',
                    {'Content-Disposition':'attachment; filename="bloodline_backup.db"',
                     'Cache-Control':'no-store'})
            if path == '/api/admin/events':
                if not self.require_admin():return
                with conn_db() as db:
                    return self.respond(200, {'events':list_league_events(db)})
            if path == '/api/admin/users':
                if not self.require_owner():return
                with conn_db() as db:
                    users = [dict(r) for r in db.execute('''SELECT id,username,role,active,created_at,last_login_at
                        FROM admins ORDER BY role DESC,username COLLATE NOCASE''')]
                return self.respond(200,{'users':users})
            if path == '/api/tables':
                with conn_db() as db:
                    return self.respond(200,{'tables':list_game_tables(db,season=season)})
            if path == '/api/public':
                with conn_db() as db:
                    return self.respond(200,public_view(db,season))
            if path == '/api/admin':
                if not self.require_admin():return
                with conn_db() as db:
                    return self.respond(200,public_view(db,season,admin=True))
            if path == '/api/export.csv':
                if not self.require_admin():return
                with conn_db() as db:
                    content = export_csv(db,season)
                return self.respond(200,content,'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="bloodline_resultados.csv"'})
            if path == '/api/backup.json':
                if not self.require_admin():return
                with conn_db() as db:
                    content = generate_backup(db)
                return self.respond(200,content,extra={'Content-Disposition':'attachment; filename="bloodline_backup.json"'})
            return self.respond(404,{'error':'Página não encontrada.'})
        except (UserInputError, ValueError) as ex:
            return self.respond(400,{'error':str(ex)})
        except Exception:
            self.log_error('Erro interno no GET %s', self.path)
            return self.respond(500,{'error':'Erro interno do servidor.'})

    def do_POST(self):
        self.write('POST')

    def do_PUT(self):
        self.write('PUT')

    def do_DELETE(self):
        self.write('DELETE')

    def write(self, method):
        try:
            path = urlparse(self.path).path
            if path == '/api/player/register' and method == 'POST':
                obj=self.read_json()
                throttle_public(self.client_address[0], 'player_registration', 8)
                with DB_LOCK,conn_db() as db:
                    pid=register_player_account(db,obj.get('username'),obj.get('password'),
                             obj.get('player_id'),obj.get('player_name'))
                    db.commit()
                return self.respond(201,{'ok':True,'player_id':pid,'status':'pending',
                         'message':'Conta solicitada. Aguarde a confirmação da organização (somente uma vez).'} )
            access_action=re.fullmatch(r'/api/admin/player-accounts/(\d+)/(approve|reject)',path)
            if access_action and method=='POST':
                if not self.require_admin():return
                self.read_json()
                pid=int(access_action.group(1)); action=access_action.group(2)
                with DB_LOCK,conn_db() as db:
                    account=db.execute('SELECT * FROM player_accounts WHERE player_id=?',(pid,)).fetchone()
                    if not account or account['approval_status']!='pending':
                        return self.respond(409,{'error':'Solicitação pendente não encontrada.'})
                    if action=='approve':
                        db.execute("UPDATE player_accounts SET active=1,approval_status='approved' WHERE player_id=?",(pid,))
                    else:
                        db.execute('DELETE FROM player_accounts WHERE player_id=?',(pid,))
                    db.commit()
                return self.respond(200,{'ok':True,'action':action})
            if path == '/api/player/login' and method == 'POST':
                obj=self.read_json()
                # Por usuário E IP: dezenas de participantes podem usar o mesmo Wi-Fi.
                ip='player:'+self.client_address[0]+':'+str(obj.get('username') or obj.get('player_id') or '').casefold()
                now=time.time()
                with LOGIN_LOCK:
                    attempts=[t for t in LOGIN_ATTEMPTS.get(ip,[]) if now-t<900]
                    LOGIN_ATTEMPTS[ip]=attempts
                    if len(attempts)>=8:return self.respond(429,{'error':'Muitas tentativas. Tente novamente em 15 minutos.'})
                    attempts.append(now)
                with DB_LOCK,conn_db() as db:
                    if obj.get('username') not in (None,''):
                        username=txt(obj.get('username'), 'Usuário', 100)
                        # Compatibilidade: o nome do jogador também serve para contas antigas.
                        account=db.execute('''SELECT pa.* FROM player_accounts pa
                           JOIN players p ON p.id=pa.player_id
                           WHERE pa.username=? COLLATE NOCASE OR p.name=? COLLATE NOCASE
                           ORDER BY CASE WHEN pa.username=? COLLATE NOCASE THEN 0 ELSE 1 END LIMIT 1''',
                           (username,username,username)).fetchone()
                    elif obj.get('player_id') not in (None,''):
                        # Compatibilidade da API da v2.3.0, não usada na nova interface.
                        pid=int_id(obj.get('player_id'),'Jogador')
                        account=db.execute('SELECT * FROM player_accounts WHERE player_id=?',(pid,)).fetchone()
                    else:
                        raise UserInputError('Informe seu nome de usuário.')
                    if not password_matches(obj.get('password',''),account):
                        return self.respond(401,{'error':'Usuário ou senha incorretos.'})
                    if account['approval_status']=='pending':
                        return self.respond(403,{'error':'Seu cadastro aguarda confirmação da organização.'})
                    if not account['active'] or account['approval_status']!='approved':
                        return self.respond(403,{'error':'Sua conta não está ativa. Procure a organização.'})
                    pid=account['player_id']
                    db.execute('DELETE FROM player_sessions WHERE expires_at<?',(int(time.time()),))
                    token=secrets.token_hex(32)
                    db.execute('INSERT INTO player_sessions(token_hash,player_id,expires_at) VALUES(?,?,?)',
                               (hashlib.sha256(token.encode('ascii')).hexdigest(),pid,int(time.time())+43200))
                cookie=f'bl_player={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'
                if COOKIE_SECURE:cookie+='; Secure'
                return self.respond(200,{'ok':True},extra={'Set-Cookie':cookie})
            if path == '/api/player/logout' and method == 'POST':
                obj=self.read_json()
                token=self._cookie('bl_player')
                if re.fullmatch('[a-f0-9]{64}',token):
                    with DB_LOCK,conn_db() as db:
                        db.execute('DELETE FROM player_sessions WHERE token_hash=?',
                                   (hashlib.sha256(token.encode('ascii')).hexdigest(),))
                cookie='bl_player=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
                if COOKIE_SECURE:cookie+='; Secure'
                return self.respond(200,{'ok':True},extra={'Set-Cookie':cookie})
            if path == '/api/player/password' and method == 'POST':
                obj=self.read_json()
                player=self.current_player()
                if player is None:return self.respond(401,{'error':'Entre na área do jogador.'})
                new=validate_password(obj.get('new_password'))
                with DB_LOCK,conn_db() as db:
                    account=db.execute('SELECT * FROM player_accounts WHERE player_id=?',(player['id'],)).fetchone()
                    if not password_matches(obj.get('current_password',''),account):
                        return self.respond(403,{'error':'Senha atual incorreta.'})
                    if obj.get('current_password')==new:raise UserInputError('Escolha uma senha diferente.')
                    salt,digest,iters=password_digest(new)
                    db.execute('UPDATE player_accounts SET password_salt=?,password_hash=?,password_iterations=? WHERE player_id=?',
                               (salt,digest,iters,player['id']))
                    own=hashlib.sha256(self._cookie('bl_player').encode('ascii')).hexdigest()
                    db.execute('DELETE FROM player_sessions WHERE player_id=? AND token_hash<>?',(player['id'],own))
                return self.respond(200,{'ok':True})
            pairing_submit=re.fullmatch(r'/api/player/pairings/(\d+)/result',path)
            if pairing_submit and method=='POST':
                obj=self.read_json()
                player=self.current_player()
                if player is None:return self.respond(401,{'error':'Entre na área do jogador.'})
                pairing_id=int(pairing_submit.group(1))
                with DB_LOCK,conn_db() as db:
                    pairing=db.execute('''SELECT pair.id,pair.table_no,rd.round_no,e.id AS event_id,
                            e.season_id,e.event_date,e.episode
                        FROM event_pairings pair JOIN event_rounds rd ON rd.id=pair.round_id
                        JOIN league_events e ON e.id=rd.event_id
                        JOIN event_pairing_players pp ON pp.pairing_id=pair.id
                        JOIN event_registrations er ON er.event_id=e.id AND er.player_id=pp.player_id
                        WHERE pair.id=? AND rd.status='published' AND pp.player_id=?''',
                        (pairing_id,player['id'])).fetchone()
                    if not pairing:return self.respond(403,{'error':'Você não está inscrito nesta mesa publicada.'})
                    members=db.execute('''SELECT player_id,tribe_id,deck_id FROM event_pairing_players
                        WHERE pairing_id=? ORDER BY id''',(pairing_id,)).fetchall()
                    raw=obj.get('entries')
                    if not isinstance(raw,list) or len(raw)!=len(members) or any(not isinstance(x,dict) for x in raw):
                        raise UserInputError('Informe o resultado de cada jogador da sua mesa.')
                    choices={}
                    for r in raw:
                        pid=int_id(r.get('player_id'),'Jogador')
                        if pid in choices:raise UserInputError('Jogador repetido na mesa.')
                        choices[pid]=get_result(r.get('result'))
                    if set(choices)!={m['player_id'] for m in members}:
                        raise UserInputError('Os resultados devem corresponder à sua mesa publicada.')
                    header,entries=validate_table(db,{
                        'season_id':pairing['season_id'],'event_date':pairing['event_date'],
                        'episode':pairing['episode'],'round_no':pairing['round_no'],
                        'table_no':pairing['table_no'],'submitted_by':player['id'],
                        'entries':[{'player_id':m['player_id'],'tribe_id':m['tribe_id'],
                                    'deck_id':m['deck_id'],'result':choices[m['player_id']]} for m in members]})
                    tid=create_table(db,header,entries,False)
                    db.execute('UPDATE game_tables SET pairing_id=? WHERE id=?',(pairing_id,tid))
                    db.commit()
                return self.respond(201,{'ok':True,'status':'pending','id':tid})
            if path == '/api/events/register' and method == 'POST':
                obj = self.read_json()
                player=self.current_player()
                if player is None:return self.respond(401,{'error':'Entre com sua conta de jogador aprovada para se inscrever.'})
                # Nunca aceitar a identidade informada pelo navegador.
                obj['player_id']=player['id']
                event_id = int_id(obj.get('event_id'), 'Evento')
                with DB_LOCK, conn_db() as db:
                    event = db.execute('SELECT id,registrations_open FROM league_events WHERE id=?',(event_id,)).fetchone()
                    if not event or not event['registrations_open']:
                        return self.respond(409, {'error':'As inscrições desse evento estão fechadas.'})
                    player_id,tribe_id,deck_id=validate_event_registration(db,obj)
                    if db.execute('SELECT 1 FROM event_registrations WHERE event_id=? AND player_id=?',
                                  (event_id,player_id)).fetchone():
                        return self.respond(409,{'error':'Esse jogador já está inscrito. Procure a organização para alterar a inscrição.'})
                    # O Wi-Fi do torneio pode compartilhar um IP entre dezenas de jogadores.
                    throttle_public(self.client_address[0],'event_signup',120)
                    db.execute('''INSERT INTO event_registrations(event_id,player_id,tribe_id,deck_id)
                                  VALUES(?,?,?,?)''',(event_id,player_id,tribe_id,deck_id))
                    db.commit()
                return self.respond(201,{'ok':True,'message':'Inscrição recebida! Aguarde a confirmação da organização.'})
            if path == '/api/admin/import-db' and method == 'POST':
                return self.import_uploaded_database()
            obj = self.read_json()
            if path == '/api/login' and method == 'POST':
                ip = self.client_address[0]
                now = time.time()
                with LOGIN_LOCK:
                    attempts = [t for t in LOGIN_ATTEMPTS.get(ip,[]) if now-t < 900]
                    LOGIN_ATTEMPTS[ip] = attempts
                    if len(attempts) >= 8:
                        return self.respond(429,{'error':'Muitas tentativas. Tente novamente em 15 minutos.'})
                    attempts.append(now)
                username = str(obj.get('username', '')).strip()
                supplied = str(obj.get('password', ''))
                with conn_db() as db:
                    found = db.execute('SELECT * FROM admins WHERE username=? COLLATE NOCASE', (username,)).fetchone()
                if not password_matches(supplied, found) or not found or not found['active']:
                    return self.respond(401,{'error':'Usuário ou senha incorretos, ou conta desativada.'})
                with LOGIN_LOCK:
                    LOGIN_ATTEMPTS.pop(ip,None)
                token = secrets.token_hex(32)
                token_hash = hashlib.sha256(token.encode('ascii')).hexdigest()
                with DB_LOCK, conn_db() as db:
                    db.execute('DELETE FROM sessions WHERE expires_at<?',(int(time.time()),))
                    db.execute('INSERT INTO sessions(token_hash,expires_at,admin_id) VALUES(?,?,?)',
                        (token_hash,int(time.time()+43200),found['id']))
                    db.execute('UPDATE admins SET last_login_at=CURRENT_TIMESTAMP WHERE id=?',(found['id'],))
                cookie = f'bl_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'
                if COOKIE_SECURE:cookie+='; Secure'
                return self.respond(200,{'ok':True,'username':found['username'],'role':found['role']},extra={'Set-Cookie':cookie})
            if path == '/api/logout' and method == 'POST':
                token = self._cookie()
                if token:
                    with DB_LOCK, conn_db() as db:
                        db.execute('DELETE FROM sessions WHERE token_hash=?',(hashlib.sha256(token.encode('utf-8')).hexdigest(),))
                cookie = 'bl_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
                if COOKIE_SECURE:cookie+='; Secure'
                return self.respond(200,{'ok':True},extra={'Set-Cookie':cookie})
            if path == '/api/admin/change-password' and method == 'POST':
                admin = self.current_admin()
                if admin is None:
                    return self.respond(401, {'error':'Acesso administrativo necessário.'})
                old_password = obj.get('current_password', '')
                new_password = validate_password(obj.get('new_password'))
                with DB_LOCK, conn_db() as db:
                    found = db.execute('SELECT * FROM admins WHERE id=?',(admin['id'],)).fetchone()
                    if not password_matches(old_password, found):
                        return self.respond(403,{'error':'Senha atual incorreta.'})
                    if hmac.compare_digest(str(old_password), new_password):
                        raise UserInputError('A nova senha deve ser diferente da atual.')
                    set_admin_password(db,admin['id'],new_password)
                    token = self._cookie()
                    hashed = hashlib.sha256(token.encode('ascii')).hexdigest()
                    db.execute('DELETE FROM sessions WHERE admin_id=? AND token_hash<>?', (admin['id'],hashed))
                return self.respond(200,{'ok':True})
            if path == '/api/admin/users' and method == 'POST':
                if not self.require_owner():return
                username = validate_username(obj.get('username'))
                password = validate_password(obj.get('password'))
                with DB_LOCK, conn_db() as db:
                    new_id = create_admin(db,username,password,'admin')
                return self.respond(201,{'ok':True,'id':new_id})
            user_route = re.fullmatch(r'/api/admin/users/(\d+)',path)
            if user_route and method == 'PUT':
                if not self.require_owner():return
                target_id = int(user_route.group(1))
                allowed = {'username','password','active'}
                if not obj or set(obj) - allowed:
                    raise UserInputError('Informe usuário, senha ou situação válida.')
                with DB_LOCK, conn_db() as db:
                    target = db.execute('SELECT * FROM admins WHERE id=?',(target_id,)).fetchone()
                    if not target:raise UserInputError('Administrador não encontrado.')
                    if target['role']=='owner':
                        raise UserInputError('A conta principal deve ser alterada na seção Minha senha.')
                    if 'username' in obj:
                        db.execute('UPDATE admins SET username=? WHERE id=?',
                            (validate_username(obj['username']),target_id))
                    if 'password' in obj:
                        set_admin_password(db,target_id,obj['password'])
                    if 'active' in obj:
                        if type(obj['active']) is not bool:
                            raise UserInputError('A situação deve ser verdadeira ou falsa.')
                        db.execute('UPDATE admins SET active=? WHERE id=?',
                            (int(obj['active']),target_id))
                    if 'password' in obj or ('active' in obj and not obj['active']):
                        db.execute('DELETE FROM sessions WHERE admin_id=?',(target_id,))
                return self.respond(200,{'ok':True})
            if user_route and method == 'DELETE':
                # A exclusão definitiva de acessos é exclusiva da conta principal.
                if not self.require_owner():return
                target_id = int(user_route.group(1))
                with DB_LOCK, conn_db() as db:
                    target = db.execute('SELECT id,role FROM admins WHERE id=?',(target_id,)).fetchone()
                    if not target:raise UserInputError('Administrador não encontrado.')
                    if target['role'] == 'owner':
                        raise UserInputError('A conta principal não pode ser excluída.')
                    # Com chaves estrangeiras, as sessões deste administrador
                    # também são apagadas; nenhuma conta principal é afetada.
                    db.execute('DELETE FROM sessions WHERE admin_id=?',(target_id,))
                    db.execute('DELETE FROM admins WHERE id=?',(target_id,))
                return self.respond(200,{'ok':True})
            if path == '/api/tables' and method == 'POST':
                if not self.require_admin():return
                with DB_LOCK,conn_db() as db:
                    header,entries=validate_table(db,obj)
                    table_id=create_table(db,header,entries,True)
                return self.respond(201,{'ok':True,'id':table_id,'status':'approved'})
            if path == '/api/decks' and method == 'POST':
                # A identidade vem da sessão, não do player_id fornecido pelo cliente.
                owner=self.current_player()
                admin=self.current_admin()
                if not owner and not admin:
                    return self.respond(401,{'error':'Entre na Área do Jogador para cadastrar uma decklist.'})
                with DB_LOCK, conn_db() as db:
                    values=dict(obj)
                    if owner:
                        values['player_id']=owner['id']
                    vals=validated_deck(db,values)
                    # Coluna legada mantida para compatibilidade: as chaves antigas
                    # não são mais aceitas como forma de autenticação.
                    inert_hash=hashlib.sha256(secrets.token_bytes(32)).hexdigest()
                    cur=db.execute('INSERT INTO decks(player_id,tribe_id,name,url,edit_token_hash) VALUES(?,?,?,?,?)',(*vals,inert_hash))
                    db.commit()
                return self.respond(201,{'ok':True,'id':cur.lastrowid})
            deck_match=re.fullmatch(r'/api/decks/(\d+)',path)
            if deck_match and method in ('PUT','DELETE'):
                did=int(deck_match.group(1))
                owner=self.current_player()
                admin=self.current_admin()
                if not owner and not admin:
                    return self.respond(401,{'error':'Faça login para administrar a decklist.'})
                with DB_LOCK, conn_db() as db:
                    deck=db.execute('SELECT * FROM decks WHERE id=?',(did,)).fetchone()
                    if not deck:raise UserInputError('Deck não encontrado.')
                    if not admin and owner['id']!=deck['player_id']:
                        return self.respond(403,{'error':'Somente o dono do deck ou um administrador pode alterá-lo.'})
                    if method=='PUT':
                        values=dict(obj)
                        # Até um administrador mantém o dono original ao editar.
                        values['player_id']=deck['player_id']
                        vals=validated_deck(db,values)
                        db.execute('UPDATE decks SET player_id=?,tribe_id=?,name=?,url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',(*vals,did))
                    else:
                        # FKs ON DELETE SET NULL preservam partidas e histórico.
                        db.execute('DELETE FROM decks WHERE id=?',(did,))
                    db.commit()
                return self.respond(200,{'ok':True})
            if not self.require_admin():return
            admin=self.current_admin()
            with DB_LOCK, conn_db() as db:
                if path == '/api/admin/events' and method == 'POST':
                    values = validate_league_event(db,obj)
                    if db.execute('SELECT 1 FROM league_events WHERE season_id=? AND episode=? COLLATE NOCASE',
                                  (values[2],values[3])).fetchone():
                        raise UserInputError('Já existe um evento com esse EP nesta temporada.')
                    cur = db.execute('INSERT INTO league_events(event_date,name,season_id,episode,rounds_share_token) VALUES(?,?,?,?,?)', (*values,secrets.token_urlsafe(32)))
                    db.commit()
                    return self.respond(201, {'ok':True,'id':cur.lastrowid})
                access_route=re.fullmatch(r'/api/admin/events/(\d+)/registrations/(\d+)/access',path)
                if access_route and method=='POST':
                    event_id,reg_id=map(int,access_route.groups())
                    registration=db.execute('''SELECT er.player_id,p.name FROM event_registrations er
                              JOIN players p ON p.id=er.player_id WHERE er.event_id=? AND er.id=?''',
                              (event_id,reg_id)).fetchone()
                    if not registration:raise UserInputError('Inscrição não encontrada.')
                    new_password=secrets.token_urlsafe(16)
                    salt,digest,iters=password_digest(new_password)
                    previous=db.execute('SELECT created_via FROM player_accounts WHERE player_id=?',
                                        (registration['player_id'],)).fetchone()
                    if previous and previous['created_via']=='self':
                        return self.respond(409,{'error':'Este jogador gerencia a própria conta. Não gere uma nova senha.'})
                    db.execute('''INSERT INTO player_accounts(player_id,username,password_salt,password_hash,
                      password_iterations,active,approval_status,created_via)
                      VALUES(?,?,?,?,?,1,'approved','admin') ON CONFLICT(player_id) DO UPDATE SET
                      password_salt=excluded.password_salt,password_hash=excluded.password_hash,
                      password_iterations=excluded.password_iterations,active=1,approval_status='approved' ''',
                      (registration['player_id'],'jogador'+str(registration['player_id']),salt,digest,iters))
                    db.execute('DELETE FROM player_sessions WHERE player_id=?',(registration['player_id'],))
                    db.commit()
                    return self.respond(200,{'ok':True,'name':registration['name'],
                                            'player_id':registration['player_id'],
                                            'initial_password':new_password})
                close_route=re.fullmatch(r'/api/admin/events/(\d+)/close',path)
                if close_route and method=='POST':
                    event_id=int(close_route.group(1))
                    close_league_event(db,event_id)
                    db.commit()
                    return self.respond(200,{'ok':True,'closed':True})
                finish_route=re.fullmatch(r'/api/admin/events/(\d+)/rounds/(\d+)/finish',path)
                if finish_route and method=='POST':
                    event_id,round_no=map(int,finish_route.groups())
                    finalize_event_round(db,event_id,round_no)
                    db.commit()
                    return self.respond(200,{'ok':True,'finished':True,'next_round':round_no+1})
                drop_route=re.fullmatch(r'/api/admin/events/(\d+)/registrations/(\d+)/drop',path)
                if drop_route and method=='POST':
                    event_id,reg_id=map(int,drop_route.groups())
                    reg=db.execute('SELECT id FROM event_registrations WHERE id=? AND event_id=?',(reg_id,event_id)).fetchone()
                    if not reg:raise UserInputError('Inscrição não encontrada.')
                    drop=obj.get('drop')
                    if type(drop) is not bool:raise UserInputError('Informe drop como verdadeiro ou falso.')
                    latest=db.execute('SELECT COALESCE(MAX(round_no),0) AS n FROM event_rounds WHERE event_id=?',(event_id,)).fetchone()['n']
                    db.execute('UPDATE event_registrations SET dropped_after_round=? WHERE id=?',(latest if drop else None,reg_id))
                    db.commit()
                    return self.respond(200,{'ok':True,'dropped_after_round':latest if drop else None})
                warn_route=re.fullmatch(r'/api/admin/events/(\d+)/registrations/(\d+)/warnings',path)
                if warn_route and method=='POST':
                    event_id,reg_id=map(int,warn_route.groups())
                    reg=db.execute('SELECT player_id FROM event_registrations WHERE id=? AND event_id=?',(reg_id,event_id)).fetchone()
                    if not reg:raise UserInputError('Inscrição não encontrada.')
                    note=txt(obj.get('note'),'Motivo do warning',350)
                    admin=self.current_admin()
                    db.execute('INSERT INTO event_player_warnings(event_id,player_id,admin_id,note) VALUES (?,?,?,?)',
                               (event_id,reg['player_id'],admin['id'],note))
                    db.commit()
                    return self.respond(201,{'ok':True})
                round_route=re.fullmatch(r'/api/admin/events/(\d+)/rounds/(\d+)',path)
                if round_route and method in ('POST','PUT','DELETE'):
                    event_id=int(round_route.group(1));round_no=int(round_route.group(2))
                    if method=='POST':
                        rnd_id=generate_event_round(db,event_id,round_no,obj.get('regenerate') is True,obj.get('mode','auto'))
                        db.commit()
                        return self.respond(201,{'ok':True,'id':rnd_id})
                    if method=='PUT':
                        if set(obj)!={'published'} or type(obj.get('published')) is not bool:
                            raise UserInputError('Informe published como verdadeiro ou falso.')
                        update_event_round_status(db,event_id,round_no,obj['published'])
                        db.commit()
                        return self.respond(200,{'ok':True})
                    rnd=db.execute('SELECT * FROM event_rounds WHERE event_id=? AND round_no=?',(event_id,round_no)).fetchone()
                    if not rnd:raise UserInputError('Rodada não encontrada.')
                    if rnd['finalized_at']:raise UserInputError('Rodada finalizada não pode ser excluída.')
                    if rnd['status']=='published':raise UserInputError('Despublique antes de excluir a rodada.')
                    if db.execute('''SELECT 1 FROM game_tables g JOIN event_pairings p ON g.pairing_id=p.id
                                  WHERE p.round_id=? LIMIT 1''',(rnd['id'],)).fetchone():
                        raise UserInputError('Esta rodada tem envios de resultados vinculados. Preserve o histórico.')
                    db.execute('DELETE FROM event_rounds WHERE id=?',(rnd['id'],))
                    db.commit()
                    return self.respond(200,{'ok':True})
                admin_result_route=re.fullmatch(r'/api/admin/events/(\d+)/rounds/(\d+)/pairings/(\d+)/result',path)
                if admin_result_route and method=='POST':
                    event_id,round_no,pairing_id=map(int,admin_result_route.groups())
                    table_id=submit_admin_pairing_result(db,event_id,round_no,pairing_id,obj.get('entries'))
                    db.commit()
                    return self.respond(201,{'ok':True,'id':table_id,'status':'approved'})
                swap_route=re.fullmatch(r'/api/admin/events/(\d+)/rounds/(\d+)/swap',path)
                if swap_route and method=='POST':
                    event_id,round_no=map(int,swap_route.groups())
                    swap_event_round_players(db,event_id,round_no,
                       int_id(obj.get('player_a'),'Primeiro jogador'),int_id(obj.get('player_b'),'Segundo jogador'))
                    db.commit()
                    return self.respond(200,{'ok':True})
                if path == '/api/admin/result-groups' and method == 'DELETE':
                    if admin['role']!='owner':
                        return self.respond(403,{'error':'Somente a conta principal pode apagar resultados.'})
                    sid=int_id(obj.get('season_id'),'Temporada')
                    dt=date_value(obj.get('event_date'))
                    episode=txt(obj.get('episode'),'EP',70,False)
                    if obj.get('confirmation') != 'APAGAR RESULTADOS':
                        raise UserInputError('Digite APAGAR RESULTADOS para confirmar.')
                    expected=f'{sid}|{dt}|{episode}'
                    if obj.get('confirm_group') != expected:
                        raise UserInputError('Identificação do lote divergente. Nenhum dado foi apagado.')
                    result=purge_event_results(db,sid,dt,episode,admin['id'])
                    db.commit()
                    return self.respond(200,{'ok':True,**result})
                event_match = re.fullmatch(r'/api/admin/events/(\d+)',path)
                if event_match and method == 'PUT':
                    event_id = int(event_match.group(1))
                    if set(obj)=={'registrations_open'}:
                        if not exists(db,'league_events',event_id):
                            raise UserInputError('Evento não encontrado.')
                        open_value=event_status_field(obj['registrations_open'],'Inscrições abertas')
                        ev=db.execute('SELECT ended_at FROM league_events WHERE id=?',(event_id,)).fetchone()
                        if open_value and ev['ended_at']:
                            raise UserInputError('Evento encerrado não pode reabrir inscrições.')
                        if open_value and db.execute('SELECT 1 FROM event_rounds WHERE event_id=? LIMIT 1',(event_id,)).fetchone():
                            raise UserInputError('Exclua os rascunhos antes de reabrir inscrições. Rodadas publicadas ou finalizadas bloqueiam inscrições.')
                        db.execute('UPDATE league_events SET registrations_open=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',
                                   (open_value,event_id))
                        db.commit()
                        return self.respond(200,{'ok':True,'registrations_open':bool(open_value)})
                    ev=db.execute('SELECT ended_at FROM league_events WHERE id=?',(event_id,)).fetchone()
                    if not ev:raise UserInputError('Evento não encontrado.')
                    if ev['ended_at']:raise UserInputError('Evento encerrado: cadastros não podem ser editados.')
                    values = validate_league_event(db,obj)
                    if db.execute('SELECT 1 FROM event_rounds WHERE event_id=? LIMIT 1',(event_id,)).fetchone():
                        old=db.execute('SELECT event_date,season_id,episode FROM league_events WHERE id=?',(event_id,)).fetchone()
                        if (values[0],values[2],values[3]) != (old['event_date'],old['season_id'],old['episode']):
                            raise UserInputError('Data, temporada e EP não podem mudar depois que uma rodada foi gerada.')
                    if db.execute('''SELECT 1 FROM league_events WHERE season_id=? AND episode=? COLLATE NOCASE
                                     AND id<>?''',(values[2],values[3],event_id)).fetchone():
                        raise UserInputError('Já existe um evento com esse EP nesta temporada.')
                    db.execute('UPDATE league_events SET event_date=?,name=?,season_id=?,episode=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',(*values,event_id))
                    db.commit()
                    return self.respond(200, {'ok':True})
                if event_match and method == 'DELETE':
                    event_id = int(event_match.group(1))
                    ev = db.execute('SELECT * FROM league_events WHERE id=?',(event_id,)).fetchone()
                    if not ev:raise UserInputError('Evento não encontrado.')
                    if obj.get('delete_results') is True:
                        if admin['role'] != 'owner':
                            return self.respond(403,{'error':'Apenas a conta principal pode excluir pontuação.'})
                        if not ev['ended_at']:
                            raise UserInputError('Encerre o evento antes de excluir também os resultados.')
                        if obj.get('confirm_name') != ev['name'] or obj.get('confirmation') != 'APAGAR RESULTADOS':
                            raise UserInputError('Confirme o nome exato e digite APAGAR RESULTADOS.')
                        result=purge_event_results(db,ev['season_id'],ev['event_date'],ev['episode'],admin['id'],ev['name'])
                        db.commit()
                        return self.respond(200,{'ok':True,'results_preserved':False,**result})
                    # O evento encerrado pode sair da agenda, mas resultados
                    # OFICIAIS e seus adversários precisam continuar disponíveis
                    # ao ranking e ao OPW%. Nunca apagar matches/game_tables.
                    rounds = db.execute('SELECT id,finalized_at FROM event_rounds WHERE event_id=?',(event_id,)).fetchall()
                    if ev['ended_at']:
                        # Confirmação adicional validada no servidor: a UI não
                        # é a única barreira contra exclusões acidentais.
                        if obj.get('confirm_name') != ev['name']:
                            raise UserInputError('Para excluir o evento encerrado, confirme digitando seu nome exatamente.')
                        if any(r['finalized_at'] is None for r in rounds):
                            raise UserInputError('Existem rodadas não finalizadas; regularize-as antes de excluir o evento.')
                        # As mesas guardam o resultado, os participantes e os
                        # vínculos das partidas. Somente o vínculo de pareamento
                        # é liberado para remoção do cronograma (FK RESTRICT).
                        linked=db.execute('''SELECT COUNT(*) AS n FROM game_tables g
                            JOIN event_pairings ep ON ep.id=g.pairing_id
                            JOIN event_rounds er ON er.id=ep.round_id
                            WHERE er.event_id=?''',(event_id,)).fetchone()['n']
                        db.execute('''UPDATE game_tables SET pairing_id=NULL
                            WHERE pairing_id IN (
                                SELECT ep.id FROM event_pairings ep
                                JOIN event_rounds er ON er.id=ep.round_id
                                WHERE er.event_id=?)''',(event_id,))
                        # Cascata remove mesas de pareamento, participantes e
                        # inscrições do evento, sem tocar nos perfis dos players.
                        db.execute('DELETE FROM event_rounds WHERE event_id=?',(event_id,))
                        db.execute('DELETE FROM league_events WHERE id=?',(event_id,))
                        db.commit()
                        return self.respond(200,{'ok':True,'results_preserved':True,'tables_preserved':linked})
                    # Para eventos ainda abertos, manter a proteção anterior:
                    # exclua somente cadastros sem partidas nem rodadas geradas.
                    if db.execute("SELECT 1 FROM matches WHERE season_id=? AND event_date=? AND episode=? LIMIT 1",
                                  (ev['season_id'],ev['event_date'],ev['episode'])).fetchone() or \
                       db.execute("SELECT 1 FROM game_tables WHERE season_id=? AND event_date=? AND episode=? LIMIT 1",
                                  (ev['season_id'],ev['event_date'],ev['episode'])).fetchone():
                        raise UserInputError('Este evento possui resultados ou mesas vinculadas. Finalize e encerre o evento antes de remover seu cadastro, preservando o ranking.')
                    if rounds:
                        raise UserInputError('Este evento possui rodadas geradas. Exclua os rascunhos antes de remover o evento.')
                    db.execute('DELETE FROM league_events WHERE id=?',(event_id,))
                    db.commit()
                    return self.respond(200,{'ok':True,'results_preserved':True})
                register_route = re.fullmatch(r'/api/admin/events/(\d+)/registrations',path)
                if register_route and method == 'POST':
                    event_id = int(register_route.group(1))
                    event=db.execute('SELECT ended_at FROM league_events WHERE id=?',(event_id,)).fetchone()
                    if not event:raise UserInputError('Evento não encontrado.')
                    if event['ended_at']:raise UserInputError('Evento encerrado: não é possível adicionar inscrições.')
                    player_id, tribe_id, deck_id = validate_event_registration(db,obj)
                    if db.execute('SELECT 1 FROM event_registrations WHERE event_id=? AND player_id=?',
                                  (event_id,player_id)).fetchone():
                        raise UserInputError('Esse jogador já está inscrito no evento. Edite a tribo na lista.')
                    cur = db.execute('INSERT INTO event_registrations(event_id,player_id,tribe_id,deck_id) VALUES(?,?,?,?)',
                                     (event_id,player_id,tribe_id,deck_id))
                    db.commit()
                    return self.respond(201,{'ok':True,'id':cur.lastrowid})
                reg_match = re.fullmatch(r'/api/admin/events/(\d+)/registrations/(\d+)',path)
                if reg_match and method in ('PUT','DELETE'):
                    event_id = int(reg_match.group(1))
                    registration_id = int(reg_match.group(2))
                    found = db.execute('SELECT * FROM event_registrations WHERE id=? AND event_id=?',
                                       (registration_id,event_id)).fetchone()
                    if not found:
                        raise UserInputError('Inscrição não encontrada neste evento.')
                    if db.execute('SELECT ended_at FROM league_events WHERE id=?',(event_id,)).fetchone()['ended_at']:
                        raise UserInputError('Evento encerrado: histórico de inscrições é somente leitura.')
                    if method == 'DELETE':
                        if db.execute('''SELECT 1 FROM event_pairing_players pp JOIN event_rounds rnd ON rnd.id=pp.round_id
                            WHERE rnd.event_id=? AND pp.player_id=? LIMIT 1''',(event_id,found['player_id'])).fetchone():
                            raise UserInputError('Jogador já foi pareado. Use Dropar para preservá-lo no histórico.')
                        db.execute('DELETE FROM event_registrations WHERE id=?',(registration_id,))
                        db.commit()
                        return self.respond(200, {'ok':True})
                    if 'tribe_id' in obj and db.execute('''SELECT 1 FROM event_pairing_players pp
                      JOIN event_rounds rnd ON rnd.id=pp.round_id
                      WHERE rnd.event_id=? AND pp.player_id=? LIMIT 1''',(event_id,found['player_id'])).fetchone():
                        raise UserInputError('Tribo do jogador já pareado não pode ser alterada retroativamente.')
                    if 'tribe_id' in obj:
                        tribe_id = int_id(obj['tribe_id'],'Tribo')
                        if not exists(db,'tribes',tribe_id):
                            raise UserInputError('Tribo inexistente.')
                        db.execute('''UPDATE event_registrations
                                      SET tribe_id=?,deck_id=CASE WHEN EXISTS (
                                        SELECT 1 FROM decks WHERE id=event_registrations.deck_id
                                           AND tribe_id=?) THEN deck_id ELSE NULL END,
                                        decklist_ok=CASE WHEN deck_id IS NOT NULL AND NOT EXISTS (
                                          SELECT 1 FROM decks WHERE id=event_registrations.deck_id AND tribe_id=?
                                        ) THEN 0 ELSE decklist_ok END
                                      WHERE id=?''', (tribe_id,tribe_id,tribe_id,registration_id))
                    changes = {}
                    for field in ('checkin','paid','decklist_ok'):
                        if field in obj:
                            changes[field] = event_status_field(obj[field],field)
                    if not changes and 'tribe_id' not in obj:
                        raise UserInputError('Nenhuma alteração informada.')
                    for field,value in changes.items():
                        db.execute(f'UPDATE event_registrations SET {field}=? WHERE id=?',(value,registration_id))
                    db.commit()
                    return self.respond(200, {'ok':True})
                table_match=re.fullmatch(r'/api/tables/(\d+)',path)
                if table_match and method=='PUT':
                    table_id=int(table_match.group(1))
                    approved=obj.get('status')=='approved'
                    if obj.get('status') not in ('approved','rejected'):
                        raise UserInputError('Status deve ser approved ou rejected.')
                    review_table(db,table_id,approved,txt(obj.get('note'),'Observação',350,False))
                    db.commit()
                    return self.respond(200,{'ok':True})
                if table_match and method=='DELETE':
                    table_id=int(table_match.group(1))
                    if not exists(db,'game_tables',table_id):raise UserInputError('Mesa inexistente.')
                    if db.execute('''SELECT 1 FROM game_tables g JOIN event_pairings pair ON pair.id=g.pairing_id
                         JOIN event_rounds rnd ON rnd.id=pair.round_id
                         WHERE g.id=? AND rnd.finalized_at IS NOT NULL''',(table_id,)).fetchone():
                        raise UserInputError('Mesa de rodada finalizada não pode ser removida. Preserve o histórico oficial.')
                    db.execute('DELETE FROM matches WHERE table_id=?',(table_id,))
                    db.execute('DELETE FROM game_tables WHERE id=?',(table_id,))
                    db.commit()
                    return self.respond(200,{'ok':True})
                if path == '/api/seasons' and method == 'POST':
                    name = txt(obj.get('name'),'Temporada',100)
                    order = obj.get('sort_order')
                    if order in ('',None):
                        order = (db.execute('SELECT COALESCE(MAX(sort_order),0)+1 AS val FROM seasons').fetchone()['val'])
                    else:
                        order = int(order)
                    if db.execute('SELECT 1 FROM seasons WHERE name=? COLLATE NOCASE',(name,)).fetchone():
                        raise UserInputError('Temporada já cadastrada.')
                    db.execute('INSERT INTO seasons(name,sort_order) VALUES (?,?)',(name,order))
                    return self.respond(201,{'ok':True})
                if path == '/api/players' and method == 'POST':
                    name = txt(obj.get('name'),'Jogador',100)
                    if db.execute('SELECT 1 FROM players WHERE name=? COLLATE NOCASE',(name,)).fetchone():
                        raise UserInputError('Jogador já cadastrado.')
                    db.execute('INSERT INTO players(name) VALUES(?)',(name,))
                    return self.respond(201,{'ok':True})
                if path == '/api/tribes' and method == 'POST':
                    name = txt(obj.get('name'),'Tribo',100)
                    if db.execute('SELECT 1 FROM tribes WHERE name=? COLLATE NOCASE',(name,)).fetchone():
                        raise UserInputError('Tribo já cadastrada.')
                    db.execute('INSERT INTO tribes(name) VALUES(?)',(name,))
                    return self.respond(201,{'ok':True})
                m = re.fullmatch(r'/api/(seasons|players|tribes)/(\d+)',path)
                if m and method=='PUT':
                    table, ident = m.group(1), int(m.group(2))
                    if not exists(db,table,ident):
                        raise UserInputError('Registro não encontrado.')
                    name = txt(obj.get('name'),'Nome',100)
                    if db.execute(f'SELECT 1 FROM {table} WHERE name=? COLLATE NOCASE AND id<>?',(name,ident)).fetchone():
                        raise UserInputError('Já existe um registro com esse nome.')
                    if table=='seasons':
                        order = obj.get('sort_order')
                        if order in ('',None):
                            db.execute('UPDATE seasons SET name=? WHERE id=?',(name,ident))
                        else:
                            db.execute('UPDATE seasons SET name=?,sort_order=? WHERE id=?',(name,int(order),ident))
                    else:
                        db.execute(f'UPDATE {table} SET name=? WHERE id=?',(name,ident))
                    return self.respond(200,{'ok':True})
                if m and method == 'DELETE':
                    table, ident = m.group(1), int(m.group(2))
                    if not exists(db,table,ident):
                        raise UserInputError('Registro não encontrado.')
                    # NUNCA remover dados de classificação, partidas, decks,
                    # mesas ou inscrições por cascata. Exclusions são apenas
                    # regras de temporada e podem ser descartadas junto da
                    # temporada/tribo quando não há dados de competição.
                    dependencies = {
                        'seasons': [('matches','season_id'),('game_tables','season_id'),('league_events','season_id')],
                        'players': [('matches','player_id'),('game_table_entries','player_id'),
                                    ('game_tables','submitted_by'),('decks','player_id'),('event_registrations','player_id')],
                        'tribes': [('matches','tribe_id'),('game_table_entries','tribe_id'),
                                   ('decks','tribe_id'),('event_registrations','tribe_id')],
                    }
                    for ref_table, field in dependencies[table]:
                        if db.execute(f'SELECT 1 FROM {ref_table} WHERE {field}=? LIMIT 1',(ident,)).fetchone():
                            labels={'seasons':'temporada','players':'jogador','tribes':'tribo'}
                            raise UserInputError(f'Não é possível excluir {labels[table]}: existem partidas, decks, inscrições ou eventos vinculados. Remova apenas cadastros sem histórico.')
                    db.execute(f'DELETE FROM {table} WHERE id=?',(ident,))
                    return self.respond(200,{'ok':True})
                if path == '/api/exclusions' and method=='POST':
                    season_id = int_id(obj.get('season_id'),'Temporada')
                    tribe_id = int_id(obj.get('tribe_id'),'Tribo')
                    if not (exists(db,'seasons',season_id) and exists(db,'tribes',tribe_id)):
                        raise UserInputError('Temporada ou tribo não encontrada.')
                    enabled = obj.get('excluded')
                    if type(enabled) is not bool:
                        raise UserInputError('Campo excluded deve ser verdadeiro ou falso.')
                    if enabled:
                        db.execute('INSERT OR IGNORE INTO exclusions(season_id,tribe_id) VALUES (?,?)',(season_id,tribe_id))
                    else:
                        db.execute('DELETE FROM exclusions WHERE season_id=? AND tribe_id=?',(season_id,tribe_id))
                    return self.respond(200,{'ok':True})
                if path == '/api/matches' and method=='POST':
                    vals = validate_match(db,obj)
                    if db.execute('''SELECT 1 FROM matches WHERE season_id=? AND event_date=?
                        AND episode=? AND round_no=? AND player_id=?''',(vals[0],vals[1],vals[2],vals[3],vals[4])).fetchone():
                        raise UserInputError('Já há um resultado deste jogador na mesma rodada.')
                    cur = db.execute('''INSERT INTO matches(season_id,event_date,episode,round_no,player_id,tribe_id,result,points_override,deck_id)
                        VALUES(?,?,?,?,?,?,?,?,?)''', vals)
                    return self.respond(201,{'ok':True,'id':cur.lastrowid})
                m = re.fullmatch(r'/api/matches/(\d+)',path)
                if m and method in ('PUT','DELETE'):
                    ident = int(m.group(1))
                    if not exists(db,'matches',ident):
                        raise UserInputError('Partida não encontrada.')
                    if db.execute('SELECT table_id FROM matches WHERE id=?',(ident,)).fetchone()['table_id'] is not None:
                        raise UserInputError('Resultado de mesa: exclua a mesa inteira e registre novamente.')
                    if method=='DELETE':
                        db.execute('DELETE FROM matches WHERE id=?',(ident,))
                    else:
                        vals=validate_match(db,obj)
                        if db.execute('''SELECT 1 FROM matches WHERE season_id=? AND event_date=?
                            AND episode=? AND round_no=? AND player_id=? AND id<>?''',
                            (vals[0],vals[1],vals[2],vals[3],vals[4],ident)).fetchone():
                            raise UserInputError('Já há um resultado deste jogador na mesma rodada.')
                        db.execute('''UPDATE matches SET season_id=?,event_date=?,episode=?,round_no=?,
                            player_id=?,tribe_id=?,result=?,points_override=?,deck_id=? WHERE id=?''', (*vals,ident))
                    return self.respond(200,{'ok':True})
                if path == '/api/import' and method=='POST':
                    data = obj.get('csv','')
                    if not isinstance(data,str):
                        raise UserInputError('CSV inválido.')
                    return self.respond(200,import_csv(db,data,obj.get('season_id')))
            return self.respond(404,{'error':'Rota não encontrada.'})
        except (UserInputError,ValueError) as ex:
            return self.respond(400,{'error':str(ex)})
        except sqlite3.IntegrityError as ex:
            return self.respond(409,{'error':'Conflito de cadastro. Verifique nomes e referências.'})
        except Exception as ex:
            self.log_error('Erro interno no %s %s: %s',method,self.path,ex)
            return self.respond(500,{'error':'Erro interno do servidor.'})


def main():
    ap=argparse.ArgumentParser(description='Bloodline 50tinha BI')
    ap.add_argument('--host',default=os.getenv('BLOODLINE_HOST','127.0.0.1'))
    ap.add_argument('--port',type=int,default=int(os.getenv('BLOODLINE_PORT','8000')))
    ap.add_argument('--demo',action='store_true',help='Popular dados demonstrativos somente se banco estiver vazio')
    ap.add_argument('--create-admin',action='store_true',help='Criar a primeira conta de administração no terminal')
    ap.add_argument('--reset-owner-password',action='store_true',help='Redefinir senha principal via terminal local')
    args=ap.parse_args()
    init_db()
    if args.reset_owner_password:
        return 0 if reset_owner_password() else 1
    if not setup_first_admin():
        return 1
    if args.create_admin:
        print('Conta principal já está configurada. Crie outros usuários em Administração > Acessos.')
        return 0
    if args.demo:
        with DB_LOCK, conn_db() as db:
            print('Dados demonstrativos:', 'criados' if seed_demo(db) else 'banco já preenchido, nada alterado')
    with conn_db() as db:
        players_count = db.execute('SELECT COUNT(*) FROM players').fetchone()[0]
        matches_count = db.execute('SELECT COUNT(*) FROM matches').fetchone()[0]
        admins_count = db.execute('SELECT COUNT(*) FROM admins').fetchone()[0]
    print('Banco de dados:', DB_PATH)
    print(f'Dados carregados: {players_count} jogadores, {matches_count} resultados, {admins_count} administradores.')
    if matches_count == 0:
        print('AVISO: Este banco nao possui partidas. Para recuperar dados antigos sem sobrescrever as contas,')
        print('       feche o servidor e execute importar_banco_antigo.bat.')
    print(f'Bloodline BI no endereço http://{args.host}:{args.port}')
    print('Administração: usuários e senhas salvos no banco SQLite.')
    if args.host not in ('127.0.0.1','localhost','::1'):
        print('AVISO: não exponha via HTTP na internet. Use proxy com HTTPS, autenticação e backups.')
    try:
        ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()
    except KeyboardInterrupt:
        print('\nServidor encerrado.')


if __name__=='__main__':sys.exit(main())
