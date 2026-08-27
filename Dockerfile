FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5151
ENV DATA_DIR=/data
ENV TZ=Asia/Taipei

RUN mkdir -p /data

EXPOSE 5151

CMD ["node", "src/server.js"]
