"""Deduplicated operational alerts to the configured WB-Tender SMTP account itself."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import smtplib
import ssl
import stat
import time
import uuid
from email.message import EmailMessage
from email.utils import make_msgid, parseaddr

SECRETS = Path('/srv/wb-tender-production/secrets/livego-native')


def secret(name):
    descriptor = os.open(SECRETS / name, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'r') as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size > 8192:
            raise ValueError('smtp_file_secret_invalid')
        value = source.read().strip()
        if '\r' in value or '\n' in value or '\x00' in value:
            raise ValueError('smtp_file_secret_invalid')
        return value


def alert_decision(report, previous, now):
    errors = sorted(set(report['errors']))
    fingerprint = hashlib.sha256(json.dumps(errors, separators=(',', ':')).encode()).hexdigest()
    if not errors and not previous.get('hadErrors'):
        return None
    if previous.get('fingerprint') == fingerprint and 0 <= now - previous.get('sentAt', 0) < 6 * 3600:
        return None
    return fingerprint


def notify(report, root):
    state = root / 'last-alert.json'
    previous = json.loads(state.read_text()) if state.exists() else {}
    now = time.time()
    fingerprint = alert_decision(report, previous, now)
    if fingerprint is None:
        return {'delivery': 'NOT_DUE'}
    host, port, secure = secret('smtp_host'), int(secret('smtp_port')), secret('smtp_secure').lower()
    username, password, sender = secret('smtp_user'), secret('smtp_password'), secret('smtp_from')
    recipient = parseaddr(username)[1]
    if recipient != username or '@' not in recipient or not parseaddr(sender)[1] or secure not in ('true', 'false'):
        raise ValueError('smtp_self_recipient_invalid')
    marker = 'WB-TENDER-MONITOR-' + str(uuid.uuid4())
    message = EmailMessage()
    message['Subject'] = 'WB-Tender Betrieb: ' + ('Prüfung erforderlich' if report['errors'] else 'Störung behoben')
    message['From'], message['To'] = sender, recipient
    message['Message-ID'] = make_msgid(domain='enwi.online')
    message['X-WB-Tender-Monitor'] = marker
    message.set_content('Automatische WB-Tender-Betriebsprüfung.\nZeit: ' + report['checkedAt'] +
                        '\n\n' + ('\n'.join(report['errors']) if report['errors'] else 'Alle überwachten Prüfungen sind wieder erfolgreich.') +
                        '\n\nDetails: /var/lib/wb-tender-production-monitor/current.json\n'
                        'Diese Nachricht bestätigt weder einen Cutover noch LIVE_GO.\n')
    connection = None
    try:
        context = ssl.create_default_context()
        if secure == 'true':
            connection = smtplib.SMTP_SSL(host, port, timeout=15, context=context)
        else:
            connection = smtplib.SMTP(host, port, timeout=15)
            connection.ehlo()
            connection.starttls(context=context)
            connection.ehlo()
        connection.login(username, password)
        refused = connection.send_message(message)
        if refused:
            raise RuntimeError('smtp_alert_recipient_refused')
        record = {'fingerprint': fingerprint, 'sentAt': now, 'hadErrors': bool(report['errors']),
                  'marker': marker, 'messageIdSha256': hashlib.sha256(str(message['Message-ID']).encode()).hexdigest(),
                  'acceptedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'recipient': 'CONFIGURED_SMTP_SELF'}
        temporary = root / ('alert-' + str(os.getpid()) + '.json')
        temporary.write_text(json.dumps(record, indent=2) + '\n')
        temporary.chmod(0o600)
        temporary.replace(state)
        return {'delivery': 'SMTP_ACCEPTED', 'marker': marker, 'messageIdSha256': record['messageIdSha256']}
    finally:
        if connection is not None:
            # A failed QUIT after SMTP acceptance must not trigger a duplicate alert.
            try:
                connection.quit()
            except Exception:
                connection.close()
