# مرحله ۱: بیلد کردن وابستگی‌ها (Builder)
FROM node:22-bullseye-slim AS builder

WORKDIR /app

# نصب پیش‌نیازهای ساخت
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# کپی فایل‌ها و نصب پکیج‌ها
COPY package*.json ./
# استفاده از --frozen-lockfile اگر package-lock.json دارید یا نصب معمولی
RUN npm install --omit=dev --no-audit --no-fund

# کپی سورس و بیلد
COPY . .
RUN npm run build

# مرحله ۲: ایجاد ایمیج نهایی (Final)
FROM python:3.11-slim-bullseye

# نصب پایتون و کروم (فقط موارد ضروری)
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libgbm1 libgtk-3-0 libnss3 \
    libpango-1.0-0 libxcomposite1 libxrandr2 xdg-utils nodejs \
    && rm -rf /var/lib/apt/lists/*

# نصب کروم
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | tee /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# نصب پایتون
RUN pip install --no-cache-dir pandas matplotlib mplfinance Pillow arabic-reshaper python-bidi

# کپی کردن پوشه‌های ساخته شده از مرحله قبل
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "dist/main.js"]
