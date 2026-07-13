# Namo Email Proxy

Stateless SMTP-relay + IMAP-reader для Namo Space CRM.

Cloudflare Workers **не умеют** открывать сырые TCP-сокеты (SMTP/IMAP), поэтому
отправка и приём почты идут через этот маленький Node-сервис. Он **не хранит**
никаких данных: CRM передаёт логин/пароль/хост в теле каждого запроса, сервис
делает подключение и сразу его закрывает.

## Эндпоинты

Все защищены заголовком `x-proxy-secret` (значение = `PROXY_SECRET`).

| Метод | Путь          | Назначение                          |
|-------|---------------|-------------------------------------|
| GET   | `/health`     | Healthcheck (без авторизации)       |
| POST  | `/api/verify` | Проверить SMTP-подключение          |
| POST  | `/api/send`   | Отправить письмо                    |
| POST  | `/api/inbox`  | Получить входящие через IMAP        |

### `/api/verify`
```json
{ "smtpConfig": { "host": "smtp.yandex.ru", "port": 465, "user": "a@b.ru", "pass": "***" } }
```

### `/api/send`
```json
{
  "smtpConfig": { "host": "smtp.yandex.ru", "port": 465, "user": "a@b.ru", "pass": "***", "from": "a@b.ru", "fromName": "Имя" },
  "to": "client@x.ru", "subject": "Тема", "html": "<b>Привет</b>", "text": "Привет", "replyTo": "a@b.ru"
}
```

### `/api/inbox`
```json
{ "imapHost": "imap.yandex.ru", "imapPort": 993, "username": "a@b.ru", "password": "***", "limit": 50 }
```

## Деплой на Render (в один клик)

1. Зайдите на <https://render.com> своим аккаунтом.
2. **New → Blueprint** → выберите этот GitHub-репозиторий.
3. Render прочитает `render.yaml` и всё настроит сам → нажмите **Apply**.
4. Через ~2 минуты сервис поднимется. Скопируйте его URL
   (вида `https://namo-email-proxy.onrender.com`).
5. Сообщите мне этот URL — я пропишу `EMAIL_PROXY_URL` и `EMAIL_PROXY_SECRET`
   в проде CRM, и почта заработает.

### ⚠️ Про бесплатный тариф Render
Free-план **засыпает после 15 минут** без запросов. Первый запрос после сна
занимает 30–50 сек (холодный старт) — письмо может отправиться с задержкой.
Для боевой работы рекомендуется тариф **Starter ($7/мес)** — сервис не спит.
Поменять тариф можно в `render.yaml` (`plan: starter`) или в панели Render.

## Локальный запуск / другой хостинг (VPS)

```bash
npm install
PROXY_SECRET=ваш_секрет PORT=3025 npm start
# healthcheck:
curl http://localhost:3025/health
```

Переменные окружения:
- `PROXY_SECRET` (обязательна) — секрет, совпадает с `EMAIL_PROXY_SECRET` в CRM.
- `PORT` — порт (Render задаёт сам; локально по умолчанию 3025).
- `BIND_HOST` — интерфейс (по умолчанию `0.0.0.0`; за nginx можно `127.0.0.1`).
