"""Restore a verified WB-Tender backup into a disposable, isolated PostgreSQL only."""
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time

ROOT = Path('/srv/wb-tender-production')
STATE = Path('/var/lib/wb-tender-production-restore')
GIB = 1024 ** 3
PURPOSE = 'wb-tender-scheduled-restore'


def protected_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('protected_file_permissions_invalid')
        return os.read(fd, 65536)
    finally:
        os.close(fd)


def required_capacity(database_bytes):
    if not isinstance(database_bytes, int) or database_bytes <= 0:
        raise ValueError('database_size_invalid')
    return math.ceil(database_bytes * 1.4) + 20 * GIB


def verified_manifest(path, now=None):
    """Check metadata and its recorded checksum, without executing checksum paths."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if path.is_symlink() or not path.is_file():
        raise ValueError('manifest_invalid')
    raw = path.read_bytes()
    fields = dict(line.split('=', 1) for line in raw.decode().splitlines() if '=' in line)
    if fields.get('archive') != 'database.dump.gpg' or fields.get('pg_restore_list_verified') != 'true':
        raise ValueError('manifest_catalog_invalid')
    if not re.fullmatch('[a-f0-9]{64}', fields.get('archive_sha256', '')):
        raise ValueError('manifest_archive_hash_invalid')
    checksum = path.with_name(path.name + '.sha256')
    if checksum.is_symlink():
        raise ValueError('manifest_checksum_invalid')
    expected = hashlib.sha256(raw).hexdigest()
    records = [line.split(maxsplit=1) for line in checksum.read_text().splitlines()]
    if not any(len(row) == 2 and row[0] == expected and row[1].lstrip('*') in (str(path), path.name) for row in records):
        raise ValueError('manifest_checksum_invalid')
    archive = path.parent / fields['archive']
    if archive.is_symlink() or not archive.is_file() or not archive.stat().st_size:
        raise ValueError('archive_invalid')
    created = datetime.datetime.strptime(fields['created_utc'], '%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc)
    age = (now - created).total_seconds()
    if age < 0 or age > 36 * 3600:
        raise ValueError('backup_stale')
    return {'archive': str(archive), 'manifest': str(path), 'archiveSha256': fields['archive_sha256'], 'manifestSha256': expected, 'createdAt': created.isoformat()}


def choose_backup(directory, now=None):
    candidates = []
    for path in directory.glob('**/database.dump.gpg.manifest'):
        if path.resolve().is_relative_to(directory.resolve()):
            try:
                candidates.append(verified_manifest(path, now))
            except (OSError, ValueError, KeyError, UnicodeError):
                pass
    if not candidates:
        raise ValueError('fresh_verified_backup_missing')
    return max(candidates, key=lambda item: item['createdAt'])


def capture(args, timeout=30):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('restore_command_failed')
    return result.stdout.strip()


def owned(record, name):
    return record.get('Name', '').lstrip('/') == name and (record.get('Labels') or record.get('Config', {}).get('Labels') or {}).get('wb-tender.purpose') == PURPOSE


def main():
    os.umask(0o077)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Do not compete with the scheduled archive job for disk space or I/O.
    lock_path = Path('/var/lib/wb-tender-production-backup/job.lock')
    lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = lock_path.open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('{"status":"BACKUP_OR_RESTORE_ALREADY_RUNNING"}')
        return 0
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    name = 'wb-tender-restore-' + stamp.lower() + '-' + str(os.getpid())
    report = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status': 'PREFLIGHT', 'productionModified': False}
    work = STATE / name
    work.mkdir(mode=0o700)
    created = []
    processes = []
    def save():
        (work / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        temporary = STATE / (name + '.json')
        temporary.write_text(json.dumps(report, indent=2) + '\n')
        temporary.replace(STATE / 'current.json')
    try:
        config = json.loads(protected_file(ROOT / 'restore-current' / 'config.json'))
        client = config['databaseClient']
        if not re.fullmatch(r'wb-tender-production-release-db-client-[a-f0-9]{7,40}', client):
            raise ValueError('database_client_binding_invalid')
        for key in ('postgresImage', 'toolImage'):
            if not re.fullmatch(r'(?:wb-tender-release@)?sha256:[a-f0-9]{64}', config[key]):
                raise ValueError('restore_image_not_pinned')
            capture(['docker', 'image', 'inspect', config[key]])
        key_file = Path(config['backupKeyFile'])
        if not key_file.resolve().is_relative_to(ROOT / 'secrets'):
            raise ValueError('backup_key_outside_project')
        protected_file(key_file)
        client_record = json.loads(capture(['docker', 'inspect', client]))[0]
        if not client_record['State']['Running'] or client_record['Image'] != config['postgresImage'] or client_record['Config']['Labels'].get('com.docker.compose.project') != 'wb-tender-production':
            raise ValueError('database_client_binding_invalid')
        if capture(['docker', 'exec', client, 'psql', '-XAtv', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']) != '1':
            raise ValueError('database_login_failed')
        size = int(capture(['docker', 'exec', client, 'psql', '-XAtv', 'ON_ERROR_STOP=1', '-c', 'SELECT pg_database_size(current_database())']))
        report.update(choose_backup(ROOT / 'backups'))
        report.update({'databaseBytes': size, 'requiredBytes': required_capacity(size), 'availableBytes': shutil.disk_usage(ROOT).free, 'toolImage': config['toolImage'], 'postgresImage': config['postgresImage']})
        if report['availableBytes'] < report['requiredBytes']:
            report['status'] = 'BLOCKED_CAPACITY'
            save()
            print(json.dumps({'status': report['status']}))
            return 1
        if sys.argv[1:] == ['--preflight']:
            report['status'] = 'PREFLIGHT_PASS'
            save()
            print(json.dumps({'status': report['status']}))
            return 0
        if sys.argv[1:]:
            raise ValueError('restore_argument_invalid')
        archive = Path(report['archive'])
        with archive.open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != report['archiveSha256']:
                raise ValueError('archive_checksum_mismatch')
        report['status'] = 'RESTORING'
        save()
        capture(['docker', 'network', 'create', '--internal', '--label', 'wb-tender.purpose=' + PURPOSE, name])
        created.append(('network', name))
        capture(['docker', 'volume', 'create', '--label', 'wb-tender.purpose=' + PURPOSE, name])
        created.append(('volume', name))
        capture(['docker', 'run', '-d', '--name', name, '--network', name, '--network-alias', 'db', '--memory', '3g', '--cpus', '2', '--label', 'wb-tender.purpose=' + PURPOSE, '--mount', 'type=volume,src=' + name + ',dst=/var/lib/postgresql/data', '-e', 'POSTGRES_DB=wb_scheduled_restore', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', config['postgresImage']])
        created.append(('container', name))
        for attempt in range(90):
            try:
                if capture(['docker', 'exec', name, 'psql', '-U', 'postgres', '-d', 'wb_scheduled_restore', '-Atc', 'SELECT 1']) == '1':
                    break
            except RuntimeError:
                pass
            time.sleep(1)
        else:
            raise RuntimeError('isolated_postgres_not_ready')
        roles = capture(['docker', 'exec', client, 'psql', '-XAtv', 'ON_ERROR_STOP=1', '-c', "SELECT format('CREATE ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOLOGIN;',rolname) FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'postgres'"])
        with (work / 'operation.log').open('wb') as log:
            result = subprocess.run(['docker', 'exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'wb_scheduled_restore', '-v', 'ON_ERROR_STOP=1'], input=roles.encode(), stdout=log, stderr=log)
            if result.returncode:
                raise RuntimeError('isolated_roles_failed')
            decrypt = subprocess.Popen(['gpg', '--no-options', '--batch', '--quiet', '--no-symkey-cache', '--pinentry-mode', 'loopback', '--passphrase-file', str(key_file), '--decrypt', str(archive)], stdout=subprocess.PIPE, stderr=log, start_new_session=True)
            processes.append(decrypt)
            tool_name = name + '-client'
            restore = subprocess.Popen(['docker', 'run', '--rm', '-i', '--name', tool_name, '--label', 'wb-tender.purpose=' + PURPOSE, '--network', name, '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=256m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', config['toolImage'], 'pg_restore', '-h', 'db', '-U', 'postgres', '--exit-on-error', '--no-owner', '--no-acl', '-d', 'wb_scheduled_restore'], stdin=decrypt.stdout, stdout=log, stderr=log, start_new_session=True)
            created.append(('container', tool_name))
            processes.append(restore)
            decrypt.stdout.close()
            deadline = time.monotonic() + 3 * 3600
            while restore.poll() is None:
                if shutil.disk_usage(ROOT).free < 20 * GIB or time.monotonic() >= deadline:
                    raise RuntimeError('restore_capacity_or_deadline_limit')
                time.sleep(5)
            if restore.returncode or decrypt.wait(timeout=60):
                raise RuntimeError('archive_restore_failed')
        summary = json.loads(capture(['docker', 'exec', name, 'psql', '-U', 'postgres', '-d', 'wb_scheduled_restore', '-XAtv', 'ON_ERROR_STOP=1', '-c', "SELECT json_build_object('database',current_database(),'tables',(SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')),'databaseBytes',pg_database_size(current_database()),'tendersPresent',to_regclass('tender.tenders') IS NOT NULL,'iamPresent',to_regnamespace('iam') IS NOT NULL,'saasPresent',to_regnamespace('saas') IS NOT NULL)"]))
        if summary['database'] != 'wb_scheduled_restore' or summary['tables'] < 1 or not all(summary[key] for key in ('tendersPresent', 'iamPresent', 'saasPresent')):
            raise RuntimeError('restored_database_incomplete')
        report.update({'status': 'RESTORE_PASS', 'restore': summary, 'completedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
    except Exception as error:
        code = str(error)
        report.update({'status': 'FAILED', 'error': code if re.fullmatch('[a-z_]{4,100}', code) else 'restore_operation_failed'})
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
        errors = []
        for kind, item in reversed(created):
            try:
                probe = subprocess.run(['docker', kind, 'inspect', item], capture_output=True, text=True, timeout=30)
                if probe.returncode:
                    # Auto-removed client containers are expected to be absent.
                    if kind == 'container' and item.endswith('-client'):
                        continue
                    raise RuntimeError('restore_cleanup_resource_missing')
                if not owned(json.loads(probe.stdout)[0], item):
                    raise RuntimeError('restore_cleanup_ownership_mismatch')
                capture(['docker', kind, 'rm', *(['--force'] if kind == 'container' else []), item])
            except Exception:
                errors.append(kind + ':' + item)
        report['temporaryResourcesRemoved'] = not errors
        if errors:
            report.update({'status': 'FAILED', 'error': 'restore_cleanup_failed', 'retainedResources': errors})
        save()
    print(json.dumps({'status': report['status'], 'report': str(work / 'result.json')}))
    return 0 if report['status'] == 'RESTORE_PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
