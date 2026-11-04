"""Inicialização do BI no servidor com volume persistente (Railway)."""
import os
from pathlib import Path

def main():
    database = Path(os.environ.get('BLOODLINE_DB','/data/bloodline.db')).resolve()
    database.parent.mkdir(parents=True, exist_ok=True)
    imported = os.environ.get('BLOODLINE_IMPORT_DB','').strip()
    if imported:
        from recuperar_banco import migrate
        source = Path(imported).expanduser().resolve()
        if not source.is_file():
            raise SystemExit(f'ERRO: banco de migração não encontrado: {source}. Acesse o volume e envie o arquivo antes de iniciar a importação.')
        if source == database:
            raise SystemExit('ERRO: o banco de migração não pode ser o banco principal.')
        result = migrate(source, database, database.parent / 'backups')
        print(f'MIGRACAO: {result["inserted"]}. Contas administrativas preservadas: {result["admins_preserved"]}', flush=True)
        print('MIGRACAO: após conferir o ranking, remova BLOODLINE_IMPORT_DB das variáveis do Railway para não repetir a importação.', flush=True)
    from server import main as server_main
    # Inicia exatamente a aplicação existente, na porta oferecida pela hospedagem.
    import sys
    sys.argv = ['server.py','--host','0.0.0.0','--port',os.environ.get('PORT','8000')]
    return server_main()

if __name__ == '__main__':
    raise SystemExit(main())
