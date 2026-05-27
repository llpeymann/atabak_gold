# استفاده از نسخه سبک و آماده Node 22 روی دبیان
FROM node:22-bullseye-slim

# ۱. نصب پایتون و پیش‌نیازهای کروم (بدون ابزارهای اضافی بیلد برای حفظ رم)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
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
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ۲. نصب گوگل کروم
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | tee /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ۳. نصب پکیج‌های پایتون (نصب تکی برای جلوگیری از جهش مصرف رم)
RUN pip3 install --no-cache-dir --break-system-packages pandas && \
    pip3 install --no-cache-dir --break-system-packages matplotlib && \
    pip3 install --no-cache-dir --break-system-packages Pillow mplfinance arabic-reshaper python-bidi

WORKDIR /app

# ۴. نصب بهینه Node Modules (مهم‌ترین بخش برای جلوگیری از کرش npm)
COPY package*.json ./
# استفاده از --no-audit و --no-fund برای کاهش مصرف رم و حذف کش بلافاصله
RUN npm install --network-timeout=100000 --no-audit --no-fund && npm cache clean --force

# ۵. کپی کدها و بیلد
COPY . .
RUN npm run build

# تنظیمات نهایی
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "run", "start:prod"]
