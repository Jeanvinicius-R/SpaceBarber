import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const MINUTE = 60000;
export function normalizeWhatsApp(value) {
  if (typeof value !== 'string' || !/^[+\d\s().-]{10,25}$/.test(value)) throw Object.assign(new Error('Informe um WhatsApp válido, com DDD.'), { status: 400 });
  let digits = value.replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) digits = '55' + digits;
  if (!/^55[1-9]\d(?:[2-5]\d{7}|9\d{8})$/.test(digits)) throw Object.assign(new Error('Informe um WhatsApp brasileiro válido, com DDD. Exemplo: (11) 99999-9999.'), { status: 400 });
  return digits;
}

export function whatsAppConfig(env = process.env) {
  const config = {
    enabled: env.WHATSAPP_ENABLED === 'true', token: env.WHATSAPP_ACCESS_TOKEN,
    phoneId: env.WHATSAPP_PHONE_NUMBER_ID, version: env.WHATSAPP_API_VERSION,
    confirmation: env.WHATSAPP_CONFIRMATION_TEMPLATE, reminder: env.WHATSAPP_REMINDER_TEMPLATE,
    language: env.WHATSAPP_TEMPLATE_LANGUAGE || 'pt_BR', appSecret: env.WHATSAPP_APP_SECRET,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
  };
  config.ready = Boolean(config.enabled && config.token && /^\d+$/.test(config.phoneId || '') && /^v\d+\.\d+$/.test(config.version || '') && /^[a-z0-9_]+$/.test(config.confirmation || '') && /^[a-z0-9_]+$/.test(config.reminder || '') && config.appSecret && config.verifyToken);
  return config;
}

export function messageFor(appointment, kind) {
  const date = appointment.day.split('-').reverse().join('/');
  const price = (appointment.price / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const parameters = [appointment.client_name, appointment.shop_name, appointment.service_name, date, appointment.time, appointment.professional_name, `${appointment.duration} min`, price, appointment.address];
  return {
    parameters,
    text: `Olá, ${parameters[0]}! ${kind === 'confirmation' ? 'Seu agendamento está confirmado' : 'Lembrete do seu agendamento'} na ${parameters[1]}.\n\nServiços: ${parameters[2]}\nData: ${parameters[3]}\nHorário: ${parameters[4]} (Brasília)\nProfissional: ${parameters[5]}\nDuração: ${parameters[6]}\nValor: ${parameters[7]}\nEndereço: ${parameters[8]}\n\n${kind === 'confirmation' ? 'Acompanhe sua reserva no SpaceBarber.' : 'Estamos esperando por você! Acompanhe sua reserva no SpaceBarber.'}`,
  };
}

export function createWhatsAppTransport(config, fetcher = fetch) {
  return async job => {
    if (!config.ready) return { state: 'waiting_config', code: 'configuration_missing' };
    const payload = JSON.parse(job.payload);
    try {
      const response = await fetcher(`https://graph.facebook.com/${config.version}/${config.phoneId}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ messaging_product: 'whatsapp', to: job.phone, type: 'template', template: {
          name: job.kind === 'confirmation' ? config.confirmation : config.reminder,
          language: { code: config.language }, components: [{ type: 'body', parameters: payload.parameters.map(text => ({ type: 'text', text: String(text).replace(/[\r\n\t]+/g, ' ') })) }],
        } }),
      });
      if (response.status === 429) return { state: 'retry', code: 'rate_limited' };
      if (response.status >= 500) return { state: 'unknown', code: 'provider_unavailable' };
      if (!response.ok) return { state: 'failed', code: `provider_http_${response.status}` };
      const data = await response.json();
      const providerId = data.messages?.[0]?.id;
      return typeof providerId === 'string' && providerId ? { state: 'accepted', providerId } : { state: 'unknown', code: 'missing_provider_id' };
    } catch { return { state: 'unknown', code: 'delivery_uncertain' }; }
  };
}

export function installNotificationSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS notification_contacts(
    user_id TEXT PRIMARY KEY REFERENCES users(id),phone TEXT NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS appointment_notifications(
    id TEXT PRIMARY KEY,appointment_id TEXT NOT NULL REFERENCES appointments(id),kind TEXT NOT NULL,
    phone TEXT NOT NULL,consented_at INTEGER NOT NULL,consent_version TEXT NOT NULL,
    due_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,
    payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,
    locked_at INTEGER,provider_id TEXT,accepted_at INTEGER,delivered_at INTEGER,error_code TEXT,
    UNIQUE(appointment_id,kind));
  CREATE INDEX IF NOT EXISTS notifications_due ON appointment_notifications(status,next_attempt_at);
  CREATE INDEX IF NOT EXISTS notifications_provider ON appointment_notifications(provider_id);
  CREATE TABLE IF NOT EXISTS notification_delivery_receipts(provider_id TEXT PRIMARY KEY,status TEXT NOT NULL,received_at INTEGER NOT NULL);`);
}

export function createNotifications(db, { config = whatsAppConfig(), transport, now = Date.now } = {}) {
  installNotificationSchema(db);
  const send = transport || createWhatsAppTransport(config);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  let busy = false;

  function enqueue(appointmentId, phone, consentedAt = now()) {
    const a = one(`SELECT a.*,u.name AS client_name,b.name AS shop_name,b.address,p.name AS professional_name,
      COALESCE((SELECT group_concat(name,' + ') FROM (SELECT name FROM appointment_services WHERE appointment_id=a.id ORDER BY position)),s.name) AS service_name
      FROM appointments a JOIN users u ON u.id=a.client_id JOIN shops b ON b.id=a.shop_id JOIN professionals p ON p.id=a.professional_id JOIN services s ON s.id=a.service_id WHERE a.id=?`, appointmentId);
    if (!a || a.status !== 'confirmed') return;
    const start = Date.parse(`${a.day}T${a.time}:00-03:00`), time = now(), reminderDue = start - 30 * MINUTE;
    for (const kind of ['confirmation', 'reminder']) {
      // A booking made inside the 30-minute window gets only the confirmation.
      const late = kind === 'reminder' && reminderDue <= time;
      const due = kind === 'confirmation' ? time : reminderDue;
      const expires = kind === 'confirmation' ? Math.min(start, time + 30 * MINUTE) : Math.min(start, reminderDue + 5 * MINUTE);
      run(`INSERT OR IGNORE INTO appointment_notifications(id,appointment_id,kind,phone,consented_at,consent_version,due_at,expires_at,status,payload,next_attempt_at,error_code)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, randomUUID(), a.id, kind, phone, consentedAt, 'appointment-whatsapp-v1', due, expires,
        late ? 'skipped' : config.ready ? 'queued' : 'waiting_config', JSON.stringify(messageFor(a, kind)), due, late ? 'booked_inside_reminder_window' : null);
    }
    run('INSERT INTO notification_contacts VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,updated_at=excluded.updated_at', a.client_id, phone, time);
  }

  function cancel(appointmentId) {
    run("UPDATE appointment_notifications SET status='cancelled',error_code='appointment_inactive' WHERE appointment_id=? AND status IN ('queued','waiting_config')", appointmentId);
  }

  async function processDue() {
    if (busy) return;
    busy = true;
    try {
      const time = now();
      run('DELETE FROM notification_delivery_receipts WHERE received_at<?',time-30*24*60*MINUTE);
      // Never resend a job that might have reached the provider before a crash.
      run("UPDATE appointment_notifications SET status='unknown',error_code='interrupted_send' WHERE status='sending' AND locked_at<?", time - 2 * MINUTE);
      run("UPDATE appointment_notifications SET status='cancelled',error_code='appointment_inactive' WHERE status IN ('queued','waiting_config') AND appointment_id IN (SELECT id FROM appointments WHERE status!='confirmed')");
      run("UPDATE appointment_notifications SET status='expired',error_code='sending_window_expired' WHERE status IN ('queued','waiting_config') AND expires_at<=?", time);
      if (!config.ready) return;
      run("UPDATE appointment_notifications SET status='queued',error_code=NULL WHERE status='waiting_config' AND expires_at>?", time);
      const candidates = all("SELECT id FROM appointment_notifications WHERE status='queued' AND due_at<=? AND next_attempt_at<=? ORDER BY due_at LIMIT 25", time, time);
      for (const candidate of candidates) {
        const job = db.prepare(`UPDATE appointment_notifications SET status='sending',locked_at=?,attempts=attempts+1 WHERE id=? AND status='queued' AND expires_at>? AND appointment_id IN (SELECT id FROM appointments WHERE status='confirmed') RETURNING *`).get(now(), candidate.id, now());
        if (!job) continue;
        let result;
        try { result = await send(job); } catch { result = { state: 'unknown', code: 'delivery_uncertain' }; }
        if (result.state === 'accepted') {
          run("UPDATE appointment_notifications SET status='accepted',provider_id=?,accepted_at=?,error_code=NULL WHERE id=? AND status='sending'", result.providerId, now(), job.id);
          const receipt=one('SELECT * FROM notification_delivery_receipts WHERE provider_id=?',result.providerId);
          if(receipt)run("UPDATE appointment_notifications SET status=?,delivered_at=?,error_code=? WHERE id=? AND status='accepted'",receipt.status,receipt.status==='delivered'?receipt.received_at:null,receipt.status==='failed'?'provider_delivery_failed':null,job.id);
        } else if (result.state === 'retry' && job.attempts < 4) {
          run("UPDATE appointment_notifications SET status='queued',next_attempt_at=?,error_code=? WHERE id=? AND status='sending'", now() + Math.min(4 * MINUTE, MINUTE * 2 ** (job.attempts - 1)), result.code, job.id);
        } else {
          const state = ['waiting_config','unknown','failed'].includes(result.state) ? result.state : 'failed';
          run("UPDATE appointment_notifications SET status=?,error_code=? WHERE id=? AND status='sending'", state, result.code || 'provider_error', job.id);
        }
      }
    } finally { busy = false; }
  }

  function list(appointmentId) {
    return all('SELECT kind,phone,due_at,status,payload,accepted_at,delivered_at,error_code FROM appointment_notifications WHERE appointment_id=? ORDER BY due_at', appointmentId).map(row => ({
      ...row, phone: `+55 •• •••••-${row.phone.slice(-4)}`, payload: undefined, preview: JSON.parse(row.payload).text,
    }));
  }
  function deliveryEvents(data) {
    if (data?.object !== 'whatsapp_business_account') return;
    for (const entry of data.entry || []) for (const change of entry.changes || []) {
      if (change.value?.metadata?.phone_number_id !== config.phoneId) continue;
      for (const status of change.value.statuses || []) {
        if (typeof status.id !== 'string') continue;
        if(['delivered','read','failed'].includes(status.status))run("INSERT INTO notification_delivery_receipts VALUES(?,?,?) ON CONFLICT(provider_id) DO UPDATE SET status=CASE WHEN notification_delivery_receipts.status='delivered' THEN 'delivered' ELSE excluded.status END,received_at=excluded.received_at",status.id,status.status==='failed'?'failed':'delivered',now());
        if (['delivered','read'].includes(status.status)) run("UPDATE appointment_notifications SET status='delivered',delivered_at=COALESCE(delivered_at,?),error_code=NULL WHERE provider_id=? AND status IN ('accepted','failed','delivered')", now(), status.id);
        else if (status.status === 'failed') run("UPDATE appointment_notifications SET status='failed',error_code='provider_delivery_failed' WHERE provider_id=? AND status='accepted'", status.id);
      }
    }
  }
  return { enqueue, cancel, processDue, list, deliveryEvents, contact: uid => one('SELECT phone FROM notification_contacts WHERE user_id=?', uid)?.phone || '', ready: config.ready, config };
}

export function verifySignature(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(createHmac('sha256', secret).update(rawBody).digest(), Buffer.from(signature.slice(7), 'hex'));
}
