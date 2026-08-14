FROM node:20-alpine
WORKDIR /app

RUN addgroup --system --gid 1001 receiver \
  && adduser --system --uid 1001 receiver

COPY --chown=receiver:receiver package.json ./
COPY --chown=receiver:receiver server.js ./

USER receiver
EXPOSE 4000
CMD ["node", "server.js"]
