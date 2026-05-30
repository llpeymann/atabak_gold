# مرحله ۱: Builder
FROM node:22-bullseye-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 make g++ \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN npm run build

# مرحله ۲: Final
FROM python:3.11-slim-bullseye

WORKDIR /app

# وابستگی‌های سیستمی برای node-canvas و Node.js
RUN apt-get update && apt-get install -y \
    nodejs \
    libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

# وابستگی‌های پایتون (برای چارت کندلی)
RUN pip install --no-cache-dir pandas matplotlib mplfinance Pillow arabic-reshaper python-bidi

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/assets ./assets

ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "dist/main.js"]
