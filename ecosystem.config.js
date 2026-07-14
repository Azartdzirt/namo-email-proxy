module.exports = {
  apps: [{
    name: 'email-proxy',
    script: 'index.js',
    cwd: '/home/namodev/email-proxy',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
      PORT: 3025,
      // Принудительный IPv4 при DNS-резолве. На VPS IPv6-маршрут часто битый,
      // и nodemailer виснет (Connection timeout), если хост резолвится в IPv6.
      // Через NODE_OPTIONS это надёжнее, чем вызов в коде.
      NODE_OPTIONS: '--dns-result-order=ipv4first',
      UV_THREADPOOL_SIZE: 8,
      // За nginx слушаем только локальный интерфейс — наружу не торчим
      BIND_HOST: '127.0.0.1',
      // ВАЖНО: должен совпадать с EMAIL_PROXY_SECRET в секретах CRM (Cloudflare).
      // Значение подставляется установочным скриптом в файл .env (см. ниже),
      // здесь секрета намеренно НЕТ — репозиторий публичный.
      PROXY_SECRET: process.env.PROXY_SECRET || '',
    }
  }]
};
