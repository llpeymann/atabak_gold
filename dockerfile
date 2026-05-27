# مرحله اول: استفاده از یک ایمیج کامل لینوکسی که نود و پایتون را پشتیبانی کند
FROM node:20-slim

# نصب پایتون و وابستگی‌های مورد نیاز برای رسم نمودار و Puppeteer
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-full \
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
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# نصب کتابخانه‌های پایتون (نمودار)
RUN pip3 install --break-system-packages pandas mplfinance matplotlib Pillow arabic-reshaper python-bidi

# تعیین پوشه کاری
WORKDIR /app

# کپی فایل‌های پکیج و نصب وابستگی‌های Node.js
COPY package*.json ./
RUN npm install

# کپی کل پروژه
COPY . .

# کامپایل کردن کد TypeScript به JavaScript
RUN npm run build

# تعیین متغیر محیطی برای آدرس کروم (مخصوص Puppeteer در لینوکس داکر)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# در اینجا چون از کروم سیستم استفاده نمی‌کنیم، باید puppeteer نسخه پکیج خودش را دانلود کند
# یا از پکیج puppeteer استفاده کنید که خودش کروم را دانلود می‌کند.

# اجرای برنامه
CMD ["npm", "run", "start:prod"]
