# استفاده از Debian Bullseye برای سازگاری بهتر با Chrome و Node
FROM node:20-bullseye-slim

# نصب تمام پیش‌نیازهای سیستمی برای Puppeteer، پایتون و ابزارهای بیلد
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-full \
    build-essential \
    python3-dev \
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
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# نصب Google Chrome Stable
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | tee /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# نصب کتابخانه‌های پایتون (با آپدیت pip برای جلوگیری از خطا)
RUN pip3 install --upgrade pip --break-system-packages \
    && pip3 install --break-system-packages pandas mplfinance matplotlib Pillow arabic-reshaper python-bidi

# تعیین پوشه کاری
WORKDIR /app

# کپی فایل‌های پکیج و نصب وابستگی‌های Node.js
COPY package*.json ./
RUN npm install

# کپی بقیه کدهای پروژه
COPY . .

# کامپایل کردن پروژه
RUN npm run build

# تنظیم متغیرهای محیطی برای Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

# باز کردن پورت ۳۰۰۰
EXPOSE 3000

# اجرای برنامه
CMD ["npm", "run", "start:prod"]
