FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://0.0.0.0:3001/health', (res) => { if (res.statusCode !== 200) process.exit(1) }).on('error', () => process.exit(1))" || exit 1

CMD ["node", "server.js"]
