# استفاده از پایتون به عنوان پایه
FROM python:3.11-slim-bullseye

# ۱. نصب ابزارهای مورد نیاز و Node.js نسخه ۲۲ (نسخه مورد نیاز Puppeteer جدید)
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ۲. نصب گوگل کروم پایدار
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | tee /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ۳. نصب کتابخانه‌های پایتون (بدون کش برای صرفه‌جویی در فضا)
RUN pip install --no-cache-dir pandas matplotlib Pillow mplfinance arabic-reshaper python-bidi

# تعیین پوشه کاری
WORKDIR /app

# ۴. نصب وابستگی‌های Node.js (با فلگ برای نادیده گرفتن هشدارهای غیرضروری)
COPY package*.json ./
RUN npm install --loglevel error

# ۵. کپی کدها و بیلد
COPY . .
RUN npm run build

# تنظیمات محیطی Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "run", "start:prod"]
