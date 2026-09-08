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


def container_failures(records, submission_enabled=False):
    errors, images = [], []
    services = SERVICES + ('submission-worker',) if submission_enabled else SERVICES
    for service in services:
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
                if record.get('flags', {}).get(flag) != ('true' if submission_enabled else 'false'):
                    errors.append(service + ':external_submission')
            if submission_enabled and record.get('executionMode') != 'DEDICATED_VALIDATED_WORKER':
                errors.append(service + ':submission_execution_mode')
    if len(set(images)) != 1:
        errors.append('release_images_differ')
    return errors


def submission_worker_failures(record, expected_commit):
    if not isinstance(record, dict):
        return ['submission-worker:health_response_missing']
    errors = []
    if record.get('status') != 'ok' or record.get('component') != 'submission-worker':
        errors.append('submission-worker:health_response_invalid')
    if not expected_commit or record.get('sourceCommit') != expected_commit:
        errors.append('submission-worker:release_binding')
    if record.get('externalSubmissionEnabled') is not True:
        errors.append('submission-worker:submission_disabled')
    if record.get('lastError') is not None:
        errors.append('submission-worker:operation_failed')
    metrics = record.get('metrics')
    required = ('duplicateAttempts24h', 'queued', 'urgentDeadlines', 'portalErrors',
                'abandonedUploads', 'missingReceipts', 'pendingNotifications', 'staleWorkers')
    if not isinstance(metrics, dict) or any(type(metrics.get(key)) is not int or metrics[key] < 0 for key in required):
        errors.append('submission-worker:metrics_invalid')
    elif metrics['staleWorkers'] > 0:
        errors.append('submission-worker:heartbeat_stale')
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
    submission_setting = os.environ.get('WB_TENDER_MONITOR_SUBMISSION_ENABLED', 'false')
    if submission_setting not in ('true', 'false'):
        report['errors'].append('submission_monitor_configuration_invalid')
    submission_enabled = submission_setting == 'true'
    services = SERVICES + ('submission-worker',) if submission_enabled else SERVICES
    for service in services:
        try:
            data = json.loads(command(['docker', 'inspect', PROJECT + '-' + service]))[0]
            flags = dict(item.split('=', 1) for item in data['Config'].get('Env', []) if '=' in item)
            report['services'][service] = {
                'project': data['Config'].get('Labels', {}).get('com.docker.compose.project'),
                'image': data['Image'], 'health': data['State'].get('Health', {}).get('Status'),
                'restarts': data['RestartCount'],
                'flags': {key: flags.get(key) for key in ('EXTERNAL_SUBMISSION_ENABLED', 'WB_TENDER_ALLOW_EXTERNAL_SUBMISSION')},
                'executionMode': flags.get('SUBMISSION_EXECUTION_MODE'),
                'sourceCommit': data['Config'].get('Labels', {}).get('org.opencontainers.image.revision'),
            }
        except Exception:
            report['errors'].append(service + ':inspection_failed')
    report['errors'] += container_failures(report['services'], submission_enabled)
    if submission_enabled:
        try:
            probe = "const http=require('http');const r=http.get('http://127.0.0.1:'+Number(process.env.PORT||4241)+'/healthz',res=>{if(res.statusCode!==200)process.exitCode=1;res.pipe(process.stdout)});r.setTimeout(5000,()=>r.destroy());r.on('error',()=>process.exit(1));"
            report['submissionWorker'] = json.loads(command(['docker', 'exec', PROJECT + '-submission-worker', 'node', '-e', probe]))
            report['errors'] += submission_worker_failures(report['submissionWorker'], report['services'].get('api', {}).get('sourceCommit'))
        except Exception:
            report['errors'].append('submission-worker:probe_failed')
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
    try:
        backup_state = json.loads(Path('/var/lib/wb-tender-production-backup/current.json').read_text())
    except (OSError, ValueError):
        backup_state = None
    report['scheduledBackup'] = {key: backup_state.get(key) for key in ('status', 'checkedAt', 'backupCreated', 'availableBytes', 'requiredBytes')} if isinstance(backup_state, dict) else None
    report['errors'].extend(scheduled_backup_failures(backup_state))
    try:
        command(['systemctl', 'is-active', '--quiet', 'wb-tender-production-restore.timer'])
        command(['systemctl', 'is-enabled', '--quiet', 'wb-tender-production-restore.timer'])
    except Exception:
        report['errors'].append('weekly_restore_timer_inactive')
    try:
        restore_state = json.loads(Path('/var/lib/wb-tender-production-restore/current.json').read_text())
    except (OSError, ValueError):
        restore_state = None
    report['scheduledRestore'] = {key: restore_state.get(key) for key in ('status', 'checkedAt', 'completedAt', 'temporaryResourcesRemoved')} if isinstance(restore_state, dict) else None
    report['errors'].extend(scheduled_restore_failures(restore_state))
    usage = os.statvfs('/srv/wb-tender-production')
    report['diskFreePercent'] = round(100 * usage.f_bavail / usage.f_blocks, 2)
    if report['diskFreePercent'] < 15:
        report['errors'].append('disk_space_low')
    report['healthy'] = not report['errors']
    return report


def scheduled_backup_failures(record, now=None):
    if not isinstance(record, dict):
        return ['scheduled_backup_state_missing']
    status = record.get('status')
    if status not in ('BACKUP_PASS', 'RUNNING'):
        return ['scheduled_backup_' + str(status or 'missing').lower()]
    try:
        stamp = datetime.datetime.fromisoformat(record['checkedAt'])
        age = ((now or datetime.datetime.now(datetime.timezone.utc)) - stamp).total_seconds()
        maximum = 4 * 3600 + 600 if status == 'RUNNING' else 30 * 3600
        if not 0 <= age <= maximum:
            return ['scheduled_backup_state_stale']
    except (KeyError, ValueError, TypeError):
        return ['scheduled_backup_state_invalid']
    if status == 'BACKUP_PASS' and record.get('backupCreated') is not True:
        return ['scheduled_backup_result_invalid']
    return []


def scheduled_restore_failures(record, now=None):
    if not isinstance(record, dict):
        return ['scheduled_restore_state_missing']
    status = record.get('status')
    if status not in ('RESTORE_PASS', 'RESTORING'):
        return ['scheduled_restore_' + str(status or 'missing').lower()]
    try:
        age = ((now or datetime.datetime.now(datetime.timezone.utc)) - datetime.datetime.fromisoformat(record['checkedAt'])).total_seconds()
        maximum = 4 * 3600 + 600 if status == 'RESTORING' else 8 * 86400
        if not 0 <= age <= maximum:
            return ['scheduled_restore_state_stale']
    except (KeyError, ValueError, TypeError):
        return ['scheduled_restore_state_invalid']
    if status == 'RESTORE_PASS' and (record.get('temporaryResourcesRemoved') is not True or record.get('productionModified') is not False):
        return ['scheduled_restore_result_invalid']
    return []


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
