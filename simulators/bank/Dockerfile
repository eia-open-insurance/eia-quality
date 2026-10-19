# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f simulators/bank/Dockerfile -t eia/bank-simulator .
FROM node:24-alpine

WORKDIR /app
ENV HOST=0.0.0.0 \
    PORT=8080 \
    SIM_ENV=test

COPY simulators ./simulators

EXPOSE 8080
USER node

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/sim/bank/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "simulators/bank/server.mjs"]
