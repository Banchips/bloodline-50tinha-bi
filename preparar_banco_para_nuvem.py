"""Cria um snapshot SQLite consistente para transferir ao Railway, sem tocar no original."""
from pathlib import Path
import sqlite3
import sys

def main():
    source = Path(sys.argv[1] if len(sys.argv) > 1 else 'bloodline.db').expanduser().resolve()
    if not source.is_file():
        print(f'Banco não encontrado: {source}')
        return 1
    target_dir = Path(__file__).resolve().parent / 'transferencia'
    target_dir.mkdir(parents=True,exist_ok=True)
    target = target_dir / 'bloodline_migracao.db'
    if source == target:
        print('O banco de origem e de destino não podem ser o mesmo arquivo.')
        return 1
    try:
        with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=30) as original:
            tables = {r[0] for r in original.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            expected = {'seasons','players','tribes','matches'}
            if not expected.issubset(tables):
                raise ValueError('Este arquivo não parece ser um banco Bloodline válido.')
            if original.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('O banco apresentou problemas de integridade.')
            with sqlite3.connect(target,timeout=30) as copy:
                original.backup(copy)
                players=copy.execute('SELECT COUNT(*) FROM players').fetchone()[0]
                matches=copy.execute('SELECT COUNT(*) FROM matches').fetchone()[0]
                admins=copy.execute('SELECT COUNT(*) FROM admins').fetchone()[0] if 'admins' in tables else 0
                if copy.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise ValueError('A cópia não passou no teste de integridade.')
    except (sqlite3.Error,ValueError) as exc:
        target.unlink(missing_ok=True)
        print(f'Não foi possível criar o backup: {exc}')
        return 1
    print(f'Snapshot pronto: {target}')
    print(f'Jogadores: {players}; resultados: {matches}; administradores no original: {admins}')
    print('ATENÇÃO: contém dados particulares, não envie para o GitHub; envie somente ao volume privado do Railway.')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
