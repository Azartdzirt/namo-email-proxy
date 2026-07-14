#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Установка email-proxy на чистый Ubuntu 22.04 VPS.
# Запускать под root (или через sudo). Один раз, при первичной настройке.
#
#   ssh root@ВАШ_IP
#   bash <(curl -fsSL ...)   # или скопировать этот файл и: bash deploy-vps.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="emailproxy.namospace.ru"
APP_USER="namodev"
APP_DIR="/home/${APP_USER}/email-proxy"
REPO="https://github.com/Azartdzirt/namo-email-proxy.git"

# Секрет для защиты прокси (должен совпадать с EMAIL_PROXY_SECRET в CRM/Cloudflare).
# Можно переопределить перед запуском:  PROXY_SECRET=xxx bash deploy-vps.sh
PROXY_SECRET="${PROXY_SECRET:-namo_proxy_3fe5af4cc2e4da9148bb05ca529d47789d7b5ad8d39fe763}"

echo "==> 1/8 Обновление системы"
apt-get update -y && apt-get upgrade -y

echo "==> 2/8 Установка Node.js 20 LTS"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git nginx

echo "==> 3/8 Установка PM2 глобально"
npm install -g pm2

echo "==> 4/8 Создание пользователя приложения"
id -u "$APP_USER" &>/dev/null || adduser --disabled-password --gecos "" "$APP_USER"

echo "==> 5/8 Клонирование и установка зависимостей"
sudo -u "$APP_USER" bash -c "
  cd /home/${APP_USER}
  [ -d email-proxy ] && rm -rf email-proxy
  git clone ${REPO} email-proxy
  cd email-proxy
  npm install --omit=dev
"

echo "==> 5.5/8 Запись секрета в окружение приложения (.env)"
# Секрет НЕ хранится в репозитории — кладём его в защищённый .env только на сервере.
cat > "${APP_DIR}/.env" <<ENVEOF
NODE_ENV=production
PORT=3025
BIND_HOST=127.0.0.1
PROXY_SECRET=${PROXY_SECRET}
ENVEOF
chown "$APP_USER:$APP_USER" "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"

echo "==> 6/8 Запуск через PM2 (автозагрузка при перезагрузке)"
# Экспортируем PROXY_SECRET в среду перед стартом, чтобы ecosystem.config.js его увидел.
sudo -u "$APP_USER" PROXY_SECRET="${PROXY_SECRET}" bash -c "cd ${APP_DIR} && pm2 delete email-proxy 2>/dev/null; pm2 start ecosystem.config.js --update-env && pm2 save"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/${APP_USER}" | tail -1 | bash || true

echo "==> 7/8 Настройка nginx"
cp "${APP_DIR}/nginx-emailproxy.conf" /etc/nginx/sites-available/emailproxy
ln -sf /etc/nginx/sites-available/emailproxy /etc/nginx/sites-enabled/emailproxy
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> 8/8 SSL-сертификат (Let's Encrypt)"
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m admin@namospace.ru --redirect || {
  echo "!! Certbot не смог получить сертификат."
  echo "!! Убедись, что DNS A-запись ${DOMAIN} уже указывает на IP этого сервера,"
  echo "!! затем повтори: certbot --nginx -d ${DOMAIN}"
}

echo ""
echo "════════════════════════════════════════════════════"
echo " Готово. Проверь: curl https://${DOMAIN}/health"
echo " Логи:            sudo -u ${APP_USER} pm2 logs email-proxy"
echo "════════════════════════════════════════════════════"
