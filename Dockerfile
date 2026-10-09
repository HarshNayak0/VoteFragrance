FROM node:22-alpine
WORKDIR /app
COPY package.json server.js config.json ./
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
