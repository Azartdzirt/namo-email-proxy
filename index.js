'use strict';

/**
 * email-proxy — stateless SMTP relay + IMAP reader для Namo CRM
 *
 * Архитектура: ПОЛНОСТЬЮ STATELESS.
 * Не хранит никаких аккаунтов, паролей, состояний.
 * CRM передаёт smtpConfig в теле каждого запроса.
 * При рестарте PM2 — ничего не теряется.
 * 100 клиентов = 100 разных smtpConfig в запросах к одному сервису.
 *
 * Endpoints:
 *   POST /api/send        — отправить письмо (smtpConfig в теле)
 *   POST /api/verify      — проверить SMTP-подключение без отправки
 *   POST /api/inbox       — получить письма через IMAP (imapConfig в теле)
 *   GET  /health          — healthcheck для мониторинга
 *
 * Безопасность:
 *   Все запросы защищены заголовком x-proxy-secret.
 *   Секрет задаётся через переменную окружения PROXY_SECRET.
 *
 * Запуск: pm2 start index.js --name email-proxy
 */

const express    = require('express');
const nodemailer = require('nodemailer');
const Imap       = require('imap');
const { simpleParser } = require('mailparser');

// ВАЖНО: на некоторых VPS маршрут IPv6 битый/отсутствует, из-за чего nodemailer
// виснет на подключении к SMTP (Connection timeout), хотя IPv4 работает.
// Заставляем Node отдавать сперва IPv4-адреса при DNS-резолве.
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) {}

const app  = express();
const PORT = process.env.PORT || 3025;

// Секрет для авторизации запросов от CF Worker.
// Задаётся в /etc/environment или .env на сервере.
// В CF Worker хранится как секрет EMAIL_PROXY_SECRET.
const PROXY_SECRET = process.env.PROXY_SECRET;
if (!PROXY_SECRET) {
  console.error('[FATAL] PROXY_SECRET не задан в .env — завершение');
  process.exit(1);
}

app.use(express.json({ limit: '2mb' }));

// ─── Middleware: проверка секрета ─────────────────────────────────────────────
function auth(req, res, next) {
  const secret = req.headers['x-proxy-secret'];
  if (!secret || secret !== PROXY_SECRET) {
    console.warn(`[auth] Неверный секрет от ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Healthcheck — без авторизации ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'namo-email-proxy',
    version: '2.0.0',
    mode: 'stateless',
    uptime: Math.floor(process.uptime()),
    time: new Date().toISOString(),
  });
});

// ─── Построить Nodemailer transporter из smtpConfig ───────────────────────────
function buildTransporter(cfg) {
  const port   = Number(cfg.port) || 587;
  const secure = port === 465;

  return nodemailer.createTransport({
    host: cfg.host,
    port,
    secure,
    // Принудительно IPv4 — на VPS IPv6-маршрут часто битый (Connection timeout)
    family: 4,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
    tls: {
      // Принимаем самоподписанные сертификаты корпоративных серверов
      rejectUnauthorized: false,
    },
    // Таймаут соединения 15 секунд
    connectionTimeout: 15000,
    greetingTimeout:   10000,
    socketTimeout:     30000,
  });
}

// ─── POST /api/send ───────────────────────────────────────────────────────────
// Body:
//   smtpConfig: { host, port, user, pass, from?, fromName? }
//   to:         string | string[]
//   subject:    string
//   html?:      string
//   text?:      string
//   replyTo?:   string
//   tenantId?:  string  (только для логов)
app.post('/api/send', auth, async (req, res) => {
  const { smtpConfig, to, subject, html, text, replyTo, tenantId } = req.body;

  // Валидация smtpConfig
  if (!smtpConfig || !smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
    return res.status(400).json({
      error: 'smtpConfig обязателен: { host, user, pass }',
    });
  }
  if (!to || !subject) {
    return res.status(400).json({ error: 'to и subject обязательны' });
  }
  if (!html && !text) {
    return res.status(400).json({ error: 'html или text обязательны' });
  }

  const fromAddress = smtpConfig.from || smtpConfig.user;
  const fromHeader  = smtpConfig.fromName
    ? `"${smtpConfig.fromName}" <${fromAddress}>`
    : fromAddress;

  const toArr = Array.isArray(to) ? to : [to];

  const logPrefix = `[send] tenant=${tenantId || '?'} host=${smtpConfig.host}:${smtpConfig.port} from=${fromAddress} to=${toArr.join(',')}`;
  console.log(`${logPrefix} subject="${subject}"`);

  try {
    const transporter = buildTransporter(smtpConfig);

    const info = await transporter.sendMail({
      from:    fromHeader,
      to:      toArr.join(', '),
      subject,
      html:    html || undefined,
      text:    text || undefined,
      replyTo: replyTo || undefined,
    });

    console.log(`${logPrefix} ✅ messageId=${info.messageId}`);
    return res.json({ ok: true, messageId: info.messageId });

  } catch (err) {
    console.error(`${logPrefix} ❌ error:`, err.message);
    return res.status(500).json({
      error: err.message,
      // Подсказка по типичным ошибкам
      hint: getErrorHint(err.message),
    });
  }
});

// ─── POST /api/verify ─────────────────────────────────────────────────────────
// Проверяет SMTP-соединение без отправки письма.
// Используется при подключении почты в CRM (кнопка "Проверить подключение").
// Body: smtpConfig: { host, port, user, pass }
app.post('/api/verify', auth, async (req, res) => {
  const { smtpConfig, tenantId } = req.body;

  if (!smtpConfig || !smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
    return res.status(400).json({ error: 'smtpConfig обязателен: { host, user, pass }' });
  }

  const logPrefix = `[verify] tenant=${tenantId || '?'} host=${smtpConfig.host} user=${smtpConfig.user}`;
  console.log(logPrefix);

  try {
    const transporter = buildTransporter(smtpConfig);
    await transporter.verify();

    console.log(`${logPrefix} ✅ ok`);
    return res.json({ ok: true, message: 'SMTP подключение успешно' });

  } catch (err) {
    console.error(`${logPrefix} ❌ error:`, err.message);
    return res.status(400).json({
      ok: false,
      error: err.message,
      hint: getErrorHint(err.message),
    });
  }
});

// ─── Подсказки по типичным SMTP ошибкам ──────────────────────────────────────
function getErrorHint(message) {
  const m = (message || '').toLowerCase();

  if (m.includes('534') || m.includes('application-specific') || m.includes('invalidsecondfactor')) {
    return 'Gmail требует пароль приложения. Перейдите: myaccount.google.com → Безопасность → Двухэтапная аутентификация → Пароли приложений. Обычный пароль Gmail не работает.';
  }
  if (m.includes('invalid login') || m.includes('authentication') || m.includes('535')) {
    return 'Неверный логин или пароль. Для Gmail используйте пароль приложения (не основной пароль). Для Яндекса включите "Пароли приложений" в настройках безопасности.';
  }
  if (m.includes('self signed') || m.includes('certificate')) {
    return 'Проблема SSL-сертификата сервера. Попробуйте порт 587 вместо 465.';
  }
  if (m.includes('econnrefused') || m.includes('connect')) {
    return 'Не удалось подключиться к SMTP-серверу. Проверьте хост и порт.';
  }
  if (m.includes('timeout')) {
    return 'Превышено время ожидания подключения. Проверьте хост и порт, возможно сервер недоступен.';
  }
  if (m.includes('enotfound') || m.includes('getaddrinfo')) {
    return 'SMTP-хост не найден. Проверьте правильность адреса сервера.';
  }
  if (m.includes('5.7.0') || m.includes('relay')) {
    return 'Сервер запрещает relay. Убедитесь что логин и пароль правильные и ящик разрешает SMTP-отправку.';
  }
  return null;
}

// ─── POST /api/inbox ──────────────────────────────────────────────────────────
// Получает письма через IMAP. Stateless — данные аккаунта в теле запроса.
// Body:
//   imapHost:  string  — IMAP-хост (imap.gmail.com, imap.yandex.ru и т.д.)
//   imapPort:  number  — порт (обычно 993)
//   username:  string  — логин (email)
//   password:  string  — пароль / пароль приложения
//   limit:     number  — макс. кол-во писем (по умолчанию 50)
//   since:     string? — ISO-дата, получить письма начиная с этой даты
//   tenantId?: string  — только для логов
app.post('/api/inbox', auth, async (req, res) => {
  const { imapHost, imapPort, username, password, limit = 50, since, tenantId } = req.body;

  if (!imapHost || !username || !password) {
    return res.status(400).json({ error: 'imapHost, username, password обязательны' });
  }

  const logPrefix = `[inbox] tenant=${tenantId || '?'} host=${imapHost} user=${username}`;
  console.log(`${logPrefix} limit=${limit} since=${since || 'none'}`);

  try {
    const emails = await fetchImapEmails({ imapHost, imapPort: Number(imapPort) || 993, username, password, limit, since });
    console.log(`${logPrefix} ✅ fetched=${emails.length}`);
    return res.json({ ok: true, emails });
  } catch (err) {
    console.error(`${logPrefix} ❌`, err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      hint: getImapErrorHint(err.message),
    });
  }
});

// ─── IMAP: получить письма ────────────────────────────────────────────────────
function fetchImapEmails({ imapHost, imapPort, username, password, limit, since }) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user:             username,
      password:         password,
      host:             imapHost,
      port:             imapPort || 993,
      tls:              true,
      tlsOptions:       { rejectUnauthorized: false },
      connTimeout:      20000,
      authTimeout:      15000,
      keepalive:        false,
    });

    const emails = [];
    let resolved = false;

    function done(err) {
      if (resolved) return;
      resolved = true;
      try { imap.end(); } catch (_) {}
      if (err) reject(err);
      else resolve(emails);
    }

    imap.once('error', done);
    imap.once('end', () => done(null));

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) return done(err);

        // Критерии поиска
        let searchCriteria;
        if (since) {
          // Дата в формате DD-Mon-YYYY для IMAP
          const sinceDate = new Date(since);
          if (!isNaN(sinceDate)) {
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const imapDate = `${sinceDate.getDate()}-${months[sinceDate.getMonth()]}-${sinceDate.getFullYear()}`;
            searchCriteria = [['SINCE', imapDate]];
          } else {
            searchCriteria = ['ALL'];
          }
        } else {
          // Без since — берём последние N писем
          const total = box.messages.total;
          if (total === 0) return done(null);
          const start = Math.max(1, total - limit + 1);
          const end   = total;

          const f = imap.seq.fetch(`${start}:${end}`, {
            bodies: '',
            markSeen: false,
          });

          const parsePromises = [];

          f.on('message', (msg) => {
            parsePromises.push(new Promise((res2, rej2) => {
              let buffer = Buffer.alloc(0);
              msg.on('body', (stream) => {
                const chunks = [];
                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('end', () => { buffer = Buffer.concat(chunks); });
              });
              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(buffer);
                  emails.push(formatEmail(parsed));
                  res2();
                } catch (e) { rej2(e); }
              });
            }));
          });

          f.once('error', done);
          f.once('end', async () => {
            try {
              await Promise.all(parsePromises);
              done(null);
            } catch (e) { done(e); }
          });
          return;
        }

        // Поиск по дате
        imap.search(searchCriteria, (err2, uids) => {
          if (err2) return done(err2);
          if (!uids || uids.length === 0) return done(null);

          // Берём последние limit штук
          const uidsToFetch = uids.slice(-limit);

          const f = imap.fetch(uidsToFetch, {
            bodies: '',
            markSeen: false,
          });

          const parsePromises = [];

          f.on('message', (msg) => {
            parsePromises.push(new Promise((res2, rej2) => {
              let buffer = Buffer.alloc(0);
              msg.on('body', (stream) => {
                const chunks = [];
                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('end', () => { buffer = Buffer.concat(chunks); });
              });
              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(buffer);
                  emails.push(formatEmail(parsed));
                  res2();
                } catch (e) { rej2(e); }
              });
            }));
          });

          f.once('error', done);
          f.once('end', async () => {
            try {
              await Promise.all(parsePromises);
              done(null);
            } catch (e) { done(e); }
          });
        });
      });
    });

    imap.connect();
  });
}

// ─── Форматировать parsed email в объект CRM ──────────────────────────────────
function formatEmail(parsed) {
  const from    = parsed.from?.text || '';
  const to      = parsed.to?.text || (Array.isArray(parsed.to) ? parsed.to.map(a => a.text).join(', ') : '');
  const subject = parsed.subject || '(без темы)';
  const date    = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
  const msgId   = parsed.messageId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Текст письма — HTML или plain text
  const html    = parsed.html || '';
  const text    = parsed.text || '';

  return { from, to, subject, date, messageId: msgId, html, text };
}

// ─── Подсказки по типичным IMAP ошибкам ──────────────────────────────────────
function getImapErrorHint(message) {
  const m = (message || '').toLowerCase();
  if (m.includes('invalid credentials') || m.includes('authenticate') || m.includes('bad')) {
    return 'Неверный логин или пароль. Для Gmail используйте пароль приложения (App Password). Для Яндекса включите "Пароли приложений".';
  }
  if (m.includes('econnrefused') || m.includes('connect')) {
    return 'Не удалось подключиться к IMAP-серверу. Проверьте хост и порт (обычно 993).';
  }
  if (m.includes('timeout')) {
    return 'Превышено время ожидания подключения к IMAP.';
  }
  if (m.includes('certificate') || m.includes('self signed')) {
    return 'Проблема SSL-сертификата. Попробуйте другой порт.';
  }
  return null;
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
// На Render (и любом облачном хостинге) слушаем на 0.0.0.0, порт берём из PORT.
// Локально/за nginx можно задать BIND_HOST=127.0.0.1 через переменную окружения.
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
app.listen(PORT, BIND_HOST, () => {
  console.log(`✅ email-proxy v2.0 запущен на ${BIND_HOST}:${PORT} (stateless mode)`);
  console.log(`   Healthcheck: http://${BIND_HOST}:${PORT}/health`);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
