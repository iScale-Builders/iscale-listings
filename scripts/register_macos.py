"""Generate and optionally install current-user LaunchAgents; no passwords in plists."""
import argparse
from pathlib import Path
import plistlib
import subprocess
import os

ROOT = Path(__file__).resolve().parent.parent


def agents(python, node, env_file, backup_target, pg_bin, work):
    common = {'WorkingDirectory': str(ROOT), 'ProcessType': 'Background',
              'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'}}
    return {
        'com.iscale-listings.api': dict(common, Label='com.iscale-listings.api',
            ProgramArguments=[node, str(ROOT / 'node_modules/next/dist/bin/next'), 'start', '-p', '3000', '-H', '127.0.0.1'],
            RunAtLoad=True, KeepAlive=True, ThrottleInterval=30,
            StandardOutPath=str(work / 'api.out.log'), StandardErrorPath=str(work / 'api.err.log')),
        'com.iscale-listings.update': dict(common, Label='com.iscale-listings.update',
            ProgramArguments=[python, str(ROOT / 'scripts/local_lifecycle.py'), '--node', node, '--env-file', env_file,
                '--backup-target', backup_target, '--pg-bin', pg_bin, '--work-dir', str(work)],
            StartCalendarInterval={'Hour': 8, 'Minute': 30},
            StandardOutPath=str(work / 'update.out.log'), StandardErrorPath=str(work / 'update.err.log')),
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for arg in ('python', 'node', 'env-file', 'backup-target', 'pg-bin'):
        p.add_argument('--' + arg, required=True)
    p.add_argument('--work-dir', default=str(Path.home() / '.iscale-listings/maintenance'))
    p.add_argument('--output-dir', default=str(Path.home() / 'Library/LaunchAgents'))
    p.add_argument('--install', action='store_true')
    args = p.parse_args()
    work = Path(args.work_dir).expanduser().resolve()
    if work == ROOT or ROOT in work.parents:
        p.error('work directory must be outside repository')
    work.mkdir(parents=True, exist_ok=True)
    output = Path(args.output_dir).expanduser()
    output.mkdir(parents=True, exist_ok=True)
    for label, value in agents(args.python, args.node, args.env_file, args.backup_target, args.pg_bin, work).items():
        target = output / (label + '.plist')
        target.write_bytes(plistlib.dumps(value))
        if args.install:
            subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(target)], check=True)
        print(label + ': generated' + (' and loaded' if args.install else ' (not loaded)'))


if __name__ == '__main__':
    main()
