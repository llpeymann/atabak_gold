# استفاده از ایمیج پایتون که برای نصب پکیج‌های علمی بهینه است
FROM python:3.11-slim-bullseye

# ۱. نصب پیش‌نیازهای اولیه سیستم
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libpango-1.0-0 \
    libxcomposite1 \
    libxrandr2 \
    xdg-utils \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ۲. نصب گوگل کروم
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | tee /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ۳. نصب پکیج‌های پایتون فقط به صورت باینری (کلید حل مشکل)
# --only-binary=:all: باعث می‌شود pip فقط فایل آماده را دانلود کند و اصلا سراغ کامپایل نرود.
RUN pip install --no-cache-dir --only-binary=:all: pandas matplotlib mplfinance Pillow arabic-reshaper python-bidi

WORKDIR /app

# ۴. نصب وابستگی‌های Node.js (بسیار سبک)
COPY package*.json ./
RUN npm install --no-audit --no-fund && npm cache clean --force

# ۵. کپی کدها و بیلد
COPY . .
RUN npm run build

# تنظیمات محیطی
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "run", "start:prod"]
