"""Own-PC update -> health -> verified backup -> scan; no secrets in argv.

Run daily under the same user who imported the shop. SSH targets require a
Unix-like remote with sha256sum, mkdir, ls, tail and xargs. Local paths work
on Windows and macOS. A hash/TOC check is not a restore drill.
"""
import argparse
import datetime as dt
import hashlib
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
from urllib.parse import urlsplit, unquote, parse_qs

ROOT = Path(__file__).resolve().parent.parent


def run(args, **kwargs):
    # Do not echo argv: some importer failures can involve private endpoints.
    result = subprocess.run(args, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{Path(str(args[0])).name} exited {result.returncode}")
    return result


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def backup(target, work, pg_bin, keep, ssh_config=None):
    if keep < 1:
        raise ValueError('keep must be positive')
    parsed = urlsplit(os.environ['TM_DB_URL'])
    if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname or not parsed.path.strip('/'):
        raise ValueError('TM_DB_URL must name a PostgreSQL database')
    env = dict(os.environ, PGHOST=parsed.hostname, PGPORT=str(parsed.port or 5432),
               PGUSER=unquote(parsed.username or ''), PGDATABASE=unquote(parsed.path[1:]),
               PGPASSWORD=unquote(parsed.password or ''))
    supported = {'sslmode': 'PGSSLMODE', 'sslrootcert': 'PGSSLROOTCERT', 'sslcert': 'PGSSLCERT', 'sslkey': 'PGSSLKEY', 'connect_timeout': 'PGCONNECT_TIMEOUT'}
    for key, values in parse_qs(parsed.query).items():
        if key not in supported or len(values) != 1:
            raise ValueError('unsupported PostgreSQL connection option')
        env[supported[key]] = values[0]
    suffix = '.exe' if os.name == 'nt' else ''
    tool = lambda name: str(Path(pg_bin) / (name + suffix)) if pg_bin else name + suffix
    name = 'trademarks-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S-%f') + '.dump'
    dump = work / name
    run([tool('pg_dump'), '-Fc', '-Z', '6', '-f', str(dump)], env=env)
    toc = run([tool('pg_restore'), '--list', str(dump)], env=env, capture_output=True, text=True).stdout
    if not re.search(r'TABLE DATA public trademarks(?:\s|$)', toc) or dump.stat().st_size == 0:
        raise RuntimeError('dump missing trademarks data; nothing pruned')
    expected = digest(dump)
    # A drive letter is a local Windows path, not an SSH host.
    remote = re.match(r'^([^:/\\]+):(.+)$', target) if not re.match(r'^[A-Za-z]:[\\/]', target) else None
    if remote:
        host, directory = remote.groups()
        if host.startswith('-') or '\n' in directory:
            raise ValueError('invalid SSH target')
        opts = ['-F', ssh_config] if ssh_config else []
        remote_path = directory.rstrip('/') + '/' + name
        run(['ssh', *opts, host, 'mkdir -p -- ' + shlex.quote(directory)])
        run(['scp', *opts, str(dump), host + ':' + shlex.quote(remote_path)])
        actual = run(['ssh', *opts, host, 'sha256sum -- ' + shlex.quote(remote_path)], capture_output=True, text=True).stdout.split()[0]
        if actual.lower() != expected:
            raise RuntimeError('remote hash mismatch; nothing pruned')
        run(['ssh', *opts, host, 'cd ' + shlex.quote(directory) + f' && ls -1t trademarks-*.dump | tail -n +{keep + 1} | xargs -r rm -f --'])
    else:
        if not Path(target).expanduser().is_absolute():
            raise ValueError('local backup target must be absolute')
        destination = Path(target).expanduser().resolve()
        if destination == work.resolve() or ROOT == destination or ROOT in destination.parents:
            raise ValueError('backup target must be outside repo and work directory')
        destination.mkdir(parents=True, exist_ok=True)
        copied = destination / name
        shutil.copy2(dump, copied)
        if digest(copied) != expected:
            raise RuntimeError('local copy hash mismatch; nothing pruned')
        for old in sorted(destination.glob('trademarks-*.dump'), key=lambda p: p.name, reverse=True)[keep:]:
            old.unlink()
    # Prune work dumps only after target verification/retention succeeded.
    for old in work.glob('trademarks-*.dump'):
        if old != dump:
            old.unlink()
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--backup-only', action='store_true', help='validated backup only, for the Windows update wrapper')
    parser.add_argument('--work-dir', default=str(Path.home() / '.iscale-listings' / 'maintenance'))
    parser.add_argument('--backup-target', required=True, help='local absolute directory or SSH host:/directory')
    parser.add_argument('--pg-bin', default='')
    parser.add_argument('--node', default='node')
    parser.add_argument('--keep', type=int, default=7)
    parser.add_argument('--ssh-config')
    args = parser.parse_args()
    work = Path(args.work_dir).expanduser().resolve()
    if work == ROOT or ROOT in work.parents:
        parser.error('work directory must be outside repo')
    if args.keep < 1:
        parser.error('keep must be positive')
    work.mkdir(parents=True, exist_ok=True)
    for line in Path(args.env_file).read_text(encoding='utf-8-sig').splitlines():
        match = re.match(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$', line)
        if match:
            os.environ[match[1]] = match[2].strip('"').strip("'")
    if args.backup_only:
        backup(args.backup_target, work, args.pg_bin, args.keep, args.ssh_config)
        return 0
    os.chdir(ROOT)
    today = dt.datetime.now(dt.timezone.utc).date()
    run([sys.executable, 'scripts/backfill_direct.py', str(today - dt.timedelta(days=7)), str(today), '--record-sync-metadata', '--skip-imported'])
    stamp = work / 'last-euipo.txt'
    last = dt.date.fromisoformat(stamp.read_text().strip()) if stamp.exists() else dt.date.min
    if last > today:
        raise RuntimeError('EU stamp in future')
    if (today - last).days >= 7:
        # Cover downtime beyond the usual eight-day overlapping weekly window.
        since = min(today - dt.timedelta(days=8), last - dt.timedelta(days=1)) if last != dt.date.min else today - dt.timedelta(days=8)
        run([sys.executable, 'scripts/import_euipo.py', '--since', str(since), '--classes', '9,16,18,20,21,24,25', '--partition-statuses', '--batch-size', '500', '--source-updated-at', str(today)])
        stamp.write_text(str(today))
    run([args.node, 'cli/iscale.mjs', 'setup', 'health', '--json'])
    sha = backup(args.backup_target, work, args.pg_bin, args.keep, args.ssh_config)
    scan = subprocess.run([args.node, 'cli/iscale.mjs', 'listings', 'scan', '--include-description'])
    if scan.returncode not in (0, 2):
        raise RuntimeError(f'shop scan failed ({scan.returncode}); verified backup retained')
    (work / 'last-success.json').write_text(__import__('json').dumps({'completedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'scanExit': scan.returncode, 'backupSha256': sha, 'trigger': 'not verified'}))
    return scan.returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Local lifecycle failed; inspect private stage logs. Prior target backups retained unless a new verified copy passed retention.', file=sys.stderr)
        sys.exit(1)
