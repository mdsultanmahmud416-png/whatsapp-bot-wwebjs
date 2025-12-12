# -------------------------------
# WhatsApp Bot (whatsapp-web.js)
# Railway Compatible Dockerfile
# -------------------------------

FROM node:18-bullseye

# Install all necessary Chromium dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
    libxss1 \
    libappindicator1 \
    libindicator7 \
    libasound2 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango1.0-0 \
    libxshmfence1 \
    fonts-liberation \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (better build caching)
COPY package*.json ./
RUN npm install

# Copy rest of the project files
COPY . .

# Puppeteer env setup
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"

# Start bot
CMD ["node", "index.js"]
