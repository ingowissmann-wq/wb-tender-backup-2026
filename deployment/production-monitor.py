"""Read-only WB-Tender production monitor. Never performs a database restore."""
import datetime
import importlib.util
import json
import hashlib
import os
import socket
from pathlib import Path
import subprocess
import sys
import urllib.request

PROJECT = 'wb-tender-production'
SERVICES = ('api', 'worker', 'scheduler', 'db')
HOSTS = {'wb-tender.com', 'www.wb-tender.com', 'www.enwi.online'}


def container_failures(records):
    errors, images = [], []
    for service in SERVICES:
        record = records.get(service, {})
        if record.get('project') != PROJECT:
            errors.append(service + ':project_binding')
        if record.get('health') != 'healthy':
            errors.append(service + ':health')
        if record.get('restarts') != 0:
            errors.append(service + ':unexpected_restart')
        if service != 'db':
            images.append(record.get('image'))
            if not str(record.get('image', '')).startswith('sha256:'):
                errors.append(service + ':image_missing')
            for flag in ('EXTERNAL_SUBMISSION_ENABLED', 'WB_TENDER_ALLOW_EXTERNAL_SUBMISSION'):
                if record.get('flags', {}).get(flag) != 'false':
                    errors.append(service + ':external_submission')
    if len(set(images)) != 1:
        errors.append('release_images_differ')
    return errors


class ProjectRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        from urllib.parse import urlsplit
        target = urlsplit(newurl)
        if target.scheme != 'https' or target.hostname not in HOSTS:
            raise ValueError('redirect_outside_project')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=25)
    if result.returncode:
        raise RuntimeError('command_failed')
    return result.stdout.strip()


def manifest_checksum_verified(manifest):
    entries = []
    for line in Path(str(manifest) + '.sha256').read_text().splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) == 2 and parts[1].lstrip('*') in (str(manifest), manifest.name):
            entries.append(parts[0])
    return len(entries) == 1 and hashlib.sha256(manifest.read_bytes()).hexdigest() == entries[0]


SCANNER_NAME = 'wb-tender-production-malware-scanner'
SCANNER_IMAGE = 'clamav/clamav@sha256:faa54529dcd972899ef7d01d13e51920c4ac7646a4f985817dd14b159ba6c9c7'


def scanner_failures(record, now=None):
    errors = []
    for key, expected in (('project', 'wb-tender-malware'), ('configuredImage', SCANNER_IMAGE),
                          ('health', 'healthy'), ('restarts', 0), ('ping', 'PONG')):
        if record.get(key) != expected:
            errors.append('scanner:' + key)
    ports = record.get('portBindings', {})
    if ports != {'3310/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '13310'}]}:
        errors.append('scanner:port_binding')
    try:
        version = record.get('version', '')
        if not version.startswith('ClamAV ') or len(version.split('/')) != 3:
            raise ValueError('invalid_version')
        stamp = datetime.datetime.strptime(version.split('/')[-1], '%a %b %d %H:%M:%S %Y').replace(tzinfo=datetime.timezone.utc)
        age = ((now or datetime.datetime.now(datetime.timezone.utc)) - stamp).total_seconds()
        if not 0 <= age <= 48 * 3600:
            errors.append('scanner:signatures_stale')
    except (ValueError, TypeError):
        errors.append('scanner:signature_version_invalid')
    return errors


def clamd_command(value):
    with socket.create_connection(('127.0.0.1', 13310), timeout=5) as connection:
        connection.sendall(('z' + value + chr(0)).encode('ascii'))
        response = b''
        while len(response) < 4096:
            chunk = connection.recv(4096 - len(response))
            if not chunk:
                break
            response += chunk
            if b'\x00' in response:
                return response.split(b'\x00', 1)[0].decode('ascii').strip()
        raise ValueError('invalid_clamd_response')


def collect_scanner():
    data = json.loads(command(['docker', 'inspect', SCANNER_NAME]))[0]
    return {'project': data['Config'].get('Labels', {}).get('com.docker.compose.project'),
            'configuredImage': data['Config'].get('Image'), 'image': data['Image'],
            'health': data['State'].get('Health', {}).get('Status'), 'restarts': data['RestartCount'],
            'portBindings': data['HostConfig'].get('PortBindings'),
            'ping': clamd_command('PING'), 'version': clamd_command('VERSION')}


def collect():
    report = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'services': {}, 'errors': []}
    for service in SERVICES:
        try:
            data = json.loads(command(['docker', 'inspect', PROJECT + '-' + service]))[0]
            flags = dict(item.split('=', 1) for item in data['Config'].get('Env', []) if '=' in item)
            report['services'][service] = {
                'project': data['Config'].get('Labels', {}).get('com.docker.compose.project'),
                'image': data['Image'], 'health': data['State'].get('Health', {}).get('Status'),
                'restarts': data['RestartCount'],
                'flags': {key: flags.get(key) for key in ('EXTERNAL_SUBMISSION_ENABLED', 'WB_TENDER_ALLOW_EXTERNAL_SUBMISSION')},
            }
        except Exception:
            report['errors'].append(service + ':inspection_failed')
    report['errors'] += container_failures(report['services'])
    try:
        report['scanner'] = collect_scanner()
        report['errors'] += scanner_failures(report['scanner'])
    except Exception:
        report['errors'].append('scanner:inspection_failed')
    opener = urllib.request.build_opener(ProjectRedirect())
    report['http'] = []
    for url in ('https://wb-tender.com/', 'https://www.wb-tender.com/', 'https://www.enwi.online/healthz',
                'https://www.enwi.online/saas/pricing', 'https://www.enwi.online/saas/register?plan=TRIAL'):
        try:
            with opener.open(url, timeout=15) as response:
                status = response.status
            report['http'].append({'url': url, 'status': status})
            if status != 200:
                report['errors'].append('http:' + url)
        except Exception:
            report['errors'].append('http:' + url)
    try:
        clients = command(['docker', 'ps', '--filter', 'label=com.docker.compose.project=' + PROJECT,
                           '--filter', 'label=com.docker.compose.service=db', '--format', '{{.Names}}']).splitlines()
        if len(clients) != 1 or not clients[0].startswith(PROJECT + '-release-db-client-'):
            raise ValueError('database_client_binding')
        sql = """BEGIN READ ONLY; SET LOCAL statement_timeout='10s';
SELECT json_build_object(
 'emailFailed',(SELECT count(*) FROM saas.booking_email_outbox WHERE state='FAILED'),
 'emailOverdue',(SELECT count(*) FROM saas.booking_email_outbox WHERE (state='PENDING' AND next_attempt_at<now()-interval '10 minutes') OR (state='SENDING' AND lease_until<now()-interval '10 minutes')),
 'jobsOverdue',(SELECT count(*) FROM tenant_portal.jobs WHERE (status='QUEUED' AND created_at<now()-interval '30 minutes') OR (status='RUNNING' AND claimed_at<now()-interval '2 hours')),
 'recentFailedJobs',(SELECT count(*) FROM tenant_portal.jobs WHERE status='FAILED' AND created_at>now()-interval '1 hour'),
 'recentFailedLogins',(SELECT count(*) FROM iam.login_attempts WHERE NOT success AND created_at>now()-interval '15 minutes'),
 'recentPaymentFailures',(SELECT count(*) FROM saas.billing_events WHERE event_type='invoice.payment_failed' AND processed_at>now()-interval '1 hour'),
 'staleImports',(SELECT count(*) FROM tender.scheduler_sources WHERE source_code IN('DOE','TED') AND (NOT enabled OR kill_switch OR last_success_at IS NULL OR last_success_at<now()-interval '30 hours')),
 'configuredImports',(SELECT count(*) FROM tender.scheduler_sources WHERE source_code IN('DOE','TED'))
); ROLLBACK;"""
        output = command(['docker', 'exec', clients[0], 'psql', '-XAtqv', 'ON_ERROR_STOP=1', '-c', sql])
        report['queues'] = json.loads(output)
        for name in ('emailFailed', 'emailOverdue', 'jobsOverdue', 'recentFailedJobs', 'recentPaymentFailures', 'staleImports'):
            if report['queues'][name] > 0:
                report['errors'].append('queue:' + name)
        if report['queues']['configuredImports'] != 2:
            report['errors'].append('import_configuration_incomplete')
        if report['queues']['recentFailedLogins'] >= 20:
            report['errors'].append('login_failure_burst')
    except Exception:
        report['errors'].append('database_monitor_query_failed')
    backups = []
    for manifest in Path('/srv/wb-tender-production/backups').glob('**/*.gpg.manifest'):
        try:
            if manifest.is_symlink():
                continue
            if not manifest_checksum_verified(manifest):
                continue
            fields = dict(line.split('=', 1) for line in manifest.read_text().splitlines() if '=' in line)
            name = fields['archive']
            if Path(name).name != name or fields.get('pg_restore_list_verified') != 'true':
                continue
            archive = manifest.parent / name
            if archive.is_symlink() or not archive.is_file() or archive.stat().st_size == 0:
                continue
            created = datetime.datetime.strptime(fields['created_utc'][:16], '%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc)
            age = (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds()
            if age >= 0:
                backups.append((age, str(manifest)))
        except (OSError, ValueError, KeyError, IndexError):
            continue
    if not backups or min(backups)[0] > 30 * 3600:
        report['errors'].append('verified_backup_stale_or_missing')
    else:
        age, path = min(backups)
        report['backup'] = {'manifest': path, 'ageHours': round(age / 3600, 2), 'manifestChecksumVerified': True,
                            'archiveRehashedThisProbe': False, 'restoreRepeatedThisProbe': False}
    try:
        command(['systemctl', 'is-active', '--quiet', 'wb-tender-production-backup.timer'])
        command(['systemctl', 'is-enabled', '--quiet', 'wb-tender-production-backup.timer'])
    except Exception:
        report['errors'].append('daily_backup_timer_inactive')
    usage = os.statvfs('/srv/wb-tender-production')
    report['diskFreePercent'] = round(100 * usage.f_bavail / usage.f_blocks, 2)
    if report['diskFreePercent'] < 15:
        report['errors'].append('disk_space_low')
    report['healthy'] = not report['errors']
    return report


def main():
    os.umask(0o077)
    root = Path('/var/lib/wb-tender-production-monitor')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    report = collect()
    try:
        spec = importlib.util.spec_from_file_location('wb_monitor_alert', Path(__file__).with_name('production-monitor-alert.py'))
        alert = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(alert)
        report['alert'] = alert.notify(report, root)
    except Exception:
        report['alert'] = {'delivery': 'FAILED'}
        report['errors'].append('operational_alert_delivery_failed')
        report['healthy'] = False
    target = root / 'current.json'
    temporary = root / ('check-' + str(os.getpid()) + '.json')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    temporary.replace(target)
    if not report['healthy']:
        subprocess.run(['logger', '-p', 'daemon.err', '-t', 'wb-tender-production-monitor',
                        'WB-Tender production monitor failed; inspect protected current.json'], check=False)
    print(json.dumps({'healthy': report['healthy'], 'errorCount': len(report['errors']), 'report': str(target)}))
    return 0 if report['healthy'] else 1


if __name__ == '__main__':
    sys.exit(main())
