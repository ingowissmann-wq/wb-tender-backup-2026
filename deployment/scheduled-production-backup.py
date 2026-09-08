"""Versioned, capacity-guarded WB-Tender backup job. Never deletes backups."""
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

ROOT = Path('/srv/wb-tender-production')
STATE = Path('/var/lib/wb-tender-production-backup')
GIB = 1024 ** 3

def required_capacity(database_bytes):
    if not isinstance(database_bytes, int) or database_bytes <= 0:
        raise ValueError('database_size_invalid')
    # Allow an uncompressible new archive and a full isolated restore alongside
    # the retained backup, with a 20 GiB operating floor. No retention deletion.
    return math.ceil(database_bytes * 2.6) + 20 * GIB

def protected_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('protected_file_permissions_invalid')
        return os.read(fd, 65536)
    finally:
        os.close(fd)

def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('backup_preflight_command_failed')
    return result.stdout.strip()

def preflight(config):
    client = config['databaseClient']
    if not re.fullmatch(r'wb-tender-production-release-db-client-[a-f0-9]{7,40}', client):
        raise ValueError('database_client_binding_invalid')
    for name in ('backupKeyFile', 'pgpassFile'):
        path = Path(config[name])
        if not path.is_relative_to(ROOT) or '..' in path.parts:
            raise ValueError('secret_path_outside_project')
        protected_file(path)  # Values are never exposed or passed in an environment.
    record = json.loads(command(['docker', 'inspect', 'wb-tender-production-api']))[0]
    if record['Config']['Labels'].get('com.docker.compose.project') != 'wb-tender-production':
        raise ValueError('production_project_mismatch')
    if record['Image'] != config['releaseImage']:
        raise ValueError('backup_release_image_mismatch')
    image = json.loads(command(['docker', 'image', 'inspect', config['releaseImage']]))[0]
    labels = image['Config'].get('Labels') or {}
    if labels.get('org.opencontainers.image.revision') != config['commit'] or labels.get('org.opencontainers.image.source-tree') != config['tree']:
        raise ValueError('backup_release_labels_mismatch')
    db_client = json.loads(command(['docker', 'inspect', client]))[0]
    if not db_client['State']['Running'] or db_client['Image'] != config['postgresImage']:
        raise ValueError('database_client_not_running_or_image_mismatch')
    if db_client['Config']['Labels'].get('com.docker.compose.project') != 'wb-tender-production':
        raise ValueError('database_client_project_mismatch')
    if command(['docker', 'exec', client, 'psql', '-Atv', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']) != '1':
        raise ValueError('database_login_failed')
    size = int(command(['docker', 'exec', client, 'psql', '-Atv', 'ON_ERROR_STOP=1', '-c', 'SELECT pg_database_size(current_database())']))
    disk = os.statvfs(ROOT)
    available = disk.f_bavail * disk.f_frsize
    return {'databaseBytes': size, 'availableBytes': available, 'requiredBytes': required_capacity(size),
            'capacityReady': available >= required_capacity(size)}

def write_state(report):
    temporary = STATE / ('result-' + str(os.getpid()) + '.json')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    temporary.replace(STATE / 'current.json')

def main():
    os.umask(0o077)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (STATE / 'job.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({'status': 'ALREADY_RUNNING'}))
        return 0
    report = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status': 'PREFLIGHT', 'backupCreated': False}
    try:
        config = json.loads(protected_file(ROOT / 'backup-current' / 'config.json'))
        report.update(preflight(config))
        if not report['capacityReady']:
            report['status'] = 'BLOCKED_CAPACITY'
            write_state(report)
            print(json.dumps({'status': report['status'], 'report': str(STATE / 'current.json')}))
            return 1
        if sys.argv[1:] == ['--preflight']:
            report['status'] = 'PREFLIGHT_PASS'
            write_state(report)
            print(json.dumps({'status': report['status']}))
            return 0
        if sys.argv[1:]:
            raise ValueError('backup_argument_invalid')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = ROOT / 'backups' / ('scheduled-' + stamp + '-' + str(os.getpid()))
        target.mkdir(mode=0o700)
        report.update({'status': 'RUNNING', 'directory': str(target)})
        write_state(report)
        with (target / 'operation.log').open('wb') as log:
            process = subprocess.Popen(['/bin/bash', str(Path(__file__).with_name('backup-client-archive.sh')),
                                        config['databaseClient'], config['backupKeyFile'], str(target)],
                                       stdout=log, stderr=log, start_new_session=True,
                                       env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
            deadline = time.monotonic() + 4 * 3600
            while process.poll() is None:
                disk = os.statvfs(ROOT)
                if disk.f_bavail * disk.f_frsize < 20 * GIB or time.monotonic() >= deadline:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    raise RuntimeError('backup_stopped_to_protect_capacity_or_deadline')
                time.sleep(2)
            if process.returncode:
                raise RuntimeError('backup_archive_verification_failed')
        report.update({'status': 'BACKUP_PASS', 'backupCreated': True, 'restoreTestRepeated': False})
    except Exception as error:
        # Only locally defined codes; never include command output or configs.
        code = str(error)
        report.update({'status': 'FAILED', 'error': code if re.fullmatch('[a-z_]{4,100}', code) else 'backup_operation_failed'})
    write_state(report)
    print(json.dumps({'status': report['status'], 'report': str(STATE / 'current.json')}))
    return 0 if report['status'] == 'BACKUP_PASS' else 1

if __name__ == '__main__':
    sys.exit(main())
