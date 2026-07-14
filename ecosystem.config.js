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
      // За nginx слушаем только локальный интерфейс — наружу не торчим
      BIND_HOST: '127.0.0.1',
      // ВАЖНО: должен совпадать с EMAIL_PROXY_SECRET в секретах CRM (Cloudflare).
      // Значение подставляется установочным скриптом в файл .env (см. ниже),
      // здесь секрета намеренно НЕТ — репозиторий публичный.
      PROXY_SECRET: process.env.PROXY_SECRET || '',
    }
  }]
};
