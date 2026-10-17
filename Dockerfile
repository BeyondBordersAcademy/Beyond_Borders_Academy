FROM node:24-slim

WORKDIR /srv/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Render (and most hosts) injects the port via the PORT env var; app.js reads
# process.env.PORT with a local fallback. No fixed port is set here.
CMD ["node", "app.js"]
